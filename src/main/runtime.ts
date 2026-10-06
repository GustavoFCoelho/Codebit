import { randomUUID } from "node:crypto";
import {
  mkdir,
  realpath,
  copyFile,
  stat,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, relative, resolve } from "node:path";
import type {
  AgentCommand,
  AgentQuota,
  AgentEvent,
  AgentId,
  AgentInfo,
  AgentSession,
  BoardCard,
  AppEvent,
  Artifact,
  Entry,
  ImageOptions,
  Installation,
  Project,
  QueuedMessage,
  QuickRun,
  QuotaWindow,
  SavedPrompt,
  SubagentOptions,
  Task,
} from "../shared/types";
import {
  agentNames,
  defaultImages,
  defaultLoopGuard,
  socialNetworkNames,
  subagentsFor,
} from "../shared/types";
import type { SocialPreview, WorkItem, WorkSettings } from "../shared/types";
import { defaultWork, workStatus } from "../shared/types";
import type { SocialService } from "./social";
import { Store } from "./store";
import { discover, checkAuth, readVersion } from "./discovery";
import { CodexSession } from "./agents/codex";
import { ClaudeSession } from "./agents/claude";
import { DevinSession } from "./agents/devin";
import { probeCommands, probeModels } from "./agents/catalog";
import { probeQuota } from "./agents/quota";
import { createWorktree, isGit, removeWorktree } from "./workspace";
import { codexImageModel, ImageService } from "./images";
import { mcpFor } from "./extensions";
import { LoopGuard } from "./guard";
import type { BridgeKind } from "./bridge";
const sessionTypes = {
  codex: CodexSession,
  claude: ClaudeSession,
  devin: DevinSession,
};
export class Runtime {
  agents: AgentInfo[] = [];
  images: ImageService;
  // Social networks of the projects; set by the app, absent in some tests.
  social?: SocialService;
  // Posts waiting for the user's approval, by their chat request id.
  private socialRequests = new Map<
    string,
    { taskId: string; resolve: (ok: boolean) => void }
  >();
  private sessions = new Map<string, AgentSession>();
  // Subagent approvals shown in the parent chat, by their chat request id.
  private subRequests = new Map<
    string,
    { session: AgentSession; id: string }
  >();
  // Cancels for running subagents, by parent task.
  private subagents = new Map<string, Set<() => void>>();
  private slots = new Map<
    string,
    { active: number; waiting: (() => void)[] }
  >();
  private quotaLoads = new Map<AgentId, Promise<AgentQuota>>();
  // Slash commands and skills by agent and folder, refreshed every few minutes.
  private commandCache = new Map<
    string,
    { at: number; list: Promise<AgentCommand[]> }
  >();
  private assistantIds = new Map<string, string>();
  // Activity rows by tool call, so the call's outcome marks its row.
  private calls = new Map<string, Map<string, string>>();
  // Tasks whose turn ended while background work kept the session open.
  private parked = new Set<string>();
  // Last chat that changed each file (by absolute path) and when each run
  // started, to warn when parallel chats in one folder change the same file.
  private edits = new Map<string, { taskId: string; at: number }>();
  private runStarts = new Map<string, number>();
  private warned = new Set<string>();
  // One per run: reset by each message from the user.
  private guards = new Map<string, LoopGuard>();
  private quick = new Map<
    string,
    {
      run: QuickRun;
      session?: AgentSession;
      timer?: NodeJS.Timeout;
      guard?: LoopGuard;
    }
  >();
  // How long a parked session with no background work left waits for the
  // agent's report before closing.
  quietMs = 3000;
  private notifyTimer?: NodeJS.Timeout;
  private disposed = false;
  // Board starts run one after another per project, so none starts twice.
  private dispatching = new Map<string, Promise<unknown>>();
  // Board tasks that failed in a row, per project; two pause the mode.
  private workFailures = new Map<string, number>();
  private detection?: Promise<AgentInfo[]>;
  private versionCheck = 0;
  private catalogLoads = new WeakMap<AgentInfo, Promise<AgentInfo>>();
  private catalogAbort = new AbortController();
  bridgeConfig: (
    taskId: string,
    kind: BridgeKind,
    env?: Record<string, string>,
  ) => any = () => ({});
  revokeBridge: (taskId: string) => void = () => {};
  // Asks for the user's attention: a Windows notification while the window
  // is in the background.
  attention: (notice: {
    title: string;
    body: string;
    taskId?: string;
  }) => void = () => {};
  constructor(
    public store: Store,
    private emit: (event: AppEvent) => void,
    key: () => string | undefined,
  ) {
    this.images = new ImageService(
      store.root,
      () => store.settings(),
      key,
      (taskId, message) => emit({ type: "image-progress", taskId, message }),
      () => this.agents.find((a) => a.id === "codex")?.selected,
    );
  }
  refresh(taskId?: string) {
    this.emit({ type: "refresh", taskId });
  }
  async detect() {
    if (this.detection) return this.detection;
    this.detection = (async () => {
      const found = await discover(this.store.settings());
      if (this.disposed) return this.agents;
      this.catalogAbort.abort();
      this.catalogAbort = new AbortController();
      this.agents = found;
      this.refresh();
      // Discovery is immediately usable; catalogs populate independently.
      void Promise.allSettled(found.map((a) => this.auth(a.id)));
      return this.agents;
    })();
    try {
      return await this.detection;
    } finally {
      this.detection = undefined;
    }
  }
  // Agents may update their own CLI during a task (see the guidelines); pick up
  // the new version, catalog, commands and quota without restarting Codebit.
  async checkVersions() {
    if (this.detection || Date.now() - this.versionCheck < 60_000) return false;
    this.versionCheck = Date.now();
    const changed = await Promise.all(
      this.agents.map(async (a) => {
        if (!a.selected) return false;
        const version = await readVersion(a.selected).catch(() => undefined);
        return (
          !!version &&
          version !== "desconhecida" &&
          version !== a.selected.version
        );
      }),
    );
    if (this.disposed || !changed.includes(true)) return false;
    this.commandCache.clear();
    await this.detect();
    return true;
  }
  async auth(id: string) {
    const current = this.agents.find((a) => a.id === id);
    if (!current) throw new Error("Agente não encontrado.");
    const pending = this.catalogLoads.get(current);
    if (pending) return pending;
    current.catalogStatus = "loading";
    current.catalogError = undefined;
    this.refresh();
    const isCurrent = () => !this.disposed && this.agents.includes(current);
    const load = (async () => {
      try {
        const checked = await checkAuth(current);
        if (!isCurrent()) return current;
        Object.assign(current, checked);
        if (current.auth !== "ready" || !current.selected)
          throw new Error(current.authMessage || "Verifique o acesso ao CLI.");
        const models = await probeModels(
          current.selected,
          this.store.root,
          this.catalogAbort.signal,
        );
        if (!isCurrent()) return current;
        if (!models.length)
          throw new Error(
            "O CLI não retornou modelos. Atualize o CLI ou informe um modelo manualmente.",
          );
        current.models = models;
        current.catalogStatus = "ready";
      } catch (e) {
        if (isCurrent()) {
          current.catalogStatus = "error";
          current.catalogError = (e as Error).message;
        }
      } finally {
        this.catalogLoads.delete(current);
        if (isCurrent()) this.refresh();
      }
      return current;
    })();
    this.catalogLoads.set(current, load);
    return load;
  }
  task(id: string) {
    return this.store.get<Task>("task", id);
  }
  updateTask(id: string, patch: Partial<Task>) {
    const old = this.task(id);
    const t = { ...old, ...patch, id, updatedAt: new Date().toISOString() };
    if (patch.agent && patch.agent !== old.agent) {
      // Each agent keeps its native session; the next message carries what
      // it missed while another agent was answering.
      const last = this.store
        .entries(id)
        .filter((e) => e.kind === "user" || e.kind === "assistant")
        .at(-1);
      t.seen = { ...old.seen, [old.agent]: last?.id };
      t.nativeIds = { ...old.nativeIds, [old.agent]: old.nativeId };
      t.nativeId = t.nativeIds[patch.agent];
      t.model =
        patch.model ?? this.store.settings().defaultModels[patch.agent] ?? "";
      t.effort = "";
      t.contextPending = true;
    }
    // Usage belongs to the agent and model that reported it.
    if (t.agent !== old.agent || t.model !== old.model) t.context = undefined;
    if (patch.model !== undefined || patch.effort !== undefined) {
      const model = this.agents
        .find((a) => a.id === t.agent)
        ?.models.find((m) => m.id === t.model);
      if (t.effort && !model?.efforts?.includes(t.effort)) {
        if (patch.effort)
          throw new Error(
            "Este esforço não está disponível para o modelo selecionado.",
          );
        t.effort = "";
      }
    }
    this.store.put("task", t);
    this.refresh(id);
    return t;
  }
  async project(path: string) {
    const resolved = await realpath(path);
    const old = this.store
      .all<Project>("project")
      .find((p) => p.path.toLowerCase() === resolved.toLowerCase());
    if (old) return old;
    if (!(await stat(resolved)).isDirectory())
      throw new Error("Selecione uma pasta de projeto.");
    const p: Project = {
      id: randomUUID(),
      name: basename(resolved),
      path: resolved,
      git: await isGit(resolved),
      trusted: false,
    };
    this.store.put("project", p);
    this.refresh();
    return p;
  }
  async createTask(input: {
    projectId?: string;
    title: string;
    agent: AgentId;
    worktree?: boolean;
    parentId?: string;
    // An existing folder, for a saved prompt's run kept as a conversation.
    cwd?: string;
    // The board task this internal session works on.
    workItemId?: string;
  }) {
    const p = input.projectId
      ? this.store.get<Project>("project", input.projectId)
      : undefined;
    const id = randomUUID();
    // Conversations without a project work in a folder owned by Codebit.
    let cwd = input.cwd ?? p?.path ?? join(this.store.root, "scratch", id);
    if (!p && !input.cwd) await mkdir(cwd, { recursive: true });
    if (input.worktree) {
      if (!p?.git) throw new Error("Worktrees exigem um projeto Git.");
      cwd = join(this.store.root, "worktrees", id);
      await mkdir(join(this.store.root, "worktrees"), { recursive: true });
      await createWorktree(p.path, cwd, id);
    }
    const now = new Date().toISOString();
    const task: Task = {
      id,
      projectId: p?.id ?? "",
      title: input.title || "Nova tarefa",
      agent: input.agent,
      model: this.store.settings().defaultModels[input.agent],
      effort: "",
      cwd,
      worktree: !!input.worktree,
      mode: this.store.settings().defaultMode ?? "bypass",
      status: "idle",
      archived: false,
      createdAt: now,
      updatedAt: now,
      images: { ...defaultImages },
      parentId: input.parentId,
      workItemId: input.workItemId,
    };
    this.store.put("task", task);
    this.refresh();
    return task;
  }
  private trackCall(taskId: string, call: string | undefined, entryId: string) {
    if (!call) return;
    const calls = this.calls.get(taskId) ?? new Map<string, string>();
    this.calls.set(taskId, calls);
    calls.set(call, entryId);
  }
  // Marks the activity row of a finished tool call as a success or failure.
  private settleCall(taskId: string, call: string | undefined, ok: boolean) {
    const entryId = call && this.calls.get(taskId)?.get(call);
    if (!entryId) return;
    this.calls.get(taskId)!.delete(call);
    try {
      const entry = this.store.get<Entry>("entry", entryId);
      this.store.put("entry", { ...entry, ok });
      this.refresh(taskId);
    } catch {}
  }
  entry(
    taskId: string,
    kind: Entry["kind"],
    text: string,
    extra: Partial<Entry> = {},
  ) {
    const entry: Entry = {
      ...extra,
      id: randomUUID(),
      taskId,
      kind,
      text,
      createdAt: new Date().toISOString(),
    };
    this.store.put("entry", entry);
    this.refresh(taskId);
    return entry;
  }
  async attach(taskId: string, paths: string[]) {
    const saved: string[] = [];
    for (const path of paths) {
      const info = await stat(path);
      // Videos go to the agents as a path, never read into memory, so they
      // may be larger than the other attachments.
      const video = /[.](mp4|m4v|mov|webm|mkv|avi|wmv|flv|mpe?g|3gp)$/i.test(
        path,
      );
      if (
        !info.isFile() ||
        info.size > (video ? 100 * 1024 * 1024 : 20_000_000)
      )
        throw new Error(
          video
            ? "Vídeos anexados devem ter até 100 MB."
            : "Anexos devem ser arquivos de até 20 MB (vídeos, até 100 MB).",
        );
      saved.push(
        await this.saveAttachment(taskId, basename(path), (target) =>
          copyFile(path, target),
        ),
      );
    }
    return saved;
  }
  // Images pasted into the composer arrive as bytes instead of a file path.
  async attachData(taskId: string, name: string, bytes: Buffer) {
    if (!bytes.length || bytes.length > 20_000_000)
      throw new Error("Anexos devem ser arquivos de até 20 MB.");
    return this.saveAttachment(taskId, basename(name), (target) =>
      writeFile(target, bytes),
    );
  }
  private async saveAttachment(
    taskId: string,
    name: string,
    write: (target: string) => Promise<void>,
  ) {
    this.task(taskId);
    const folder = join(this.store.root, "attachments", taskId);
    await mkdir(folder, { recursive: true });
    const target = join(folder, randomUUID() + "-" + name);
    await write(target);
    this.store.put("attachment", { id: target, taskId, path: target });
    return target;
  }
  trusted(t: Task) {
    return (
      !t.projectId || this.store.get<Project>("project", t.projectId).trusted
    );
  }
  // Tasks on the multitask board, in the order they were placed there.
  board(): BoardCard[] {
    return this.store
      .all<Task>("task")
      .filter((t) => t.boardAt && !t.archived)
      .sort((a, b) => a.boardAt!.localeCompare(b.boardAt!))
      .map((task) => {
        const entries = this.store.entries(task.id);
        const recent = entries.filter((e) => e.kind !== "request").slice(-8);
        const image = recent.findLast((e) => e.kind === "image");
        return {
          task,
          entries: [
            ...recent,
            ...entries.filter((e) => e.kind === "request" && !e.resolved),
          ],
          artifact: image?.artifactId
            ? this.store
                .artifacts(task.id)
                .find((a) => a.id === image.artifactId)
            : undefined,
        };
      });
  }
  setBoard(taskId: string, on: boolean) {
    return this.updateTask(taskId, {
      boardAt: on
        ? (this.task(taskId).boardAt ?? new Date().toISOString())
        : undefined,
    });
  }
  // Creates a task on the board from a first message and starts it.
  async startOnBoard(input: {
    projectId?: string;
    agent: AgentId;
    worktree?: boolean;
    text: string;
  }) {
    if (!input.text.trim()) throw new Error("Descreva a tarefa.");
    const p = input.projectId
      ? this.store.get<Project>("project", input.projectId)
      : undefined;
    if (p && !p.trusted)
      throw new Error(
        "Confie no projeto antes de iniciar tarefas nele. Abra uma tarefa do projeto e confirme a confiança.",
      );
    const t = await this.createTask({
      projectId: p?.id,
      agent: input.agent,
      worktree: input.worktree,
      title: input.text.trim().split("\n")[0].slice(0, 60),
    });
    this.setBoard(t.id, true);
    await this.send(t.id, input.text);
    return this.task(t.id);
  }
  private validateMessage(taskId: string, text: string, attachments: string[]) {
    for (const path of attachments)
      if (this.store.get<any>("attachment", path).taskId !== taskId)
        throw new Error("Anexo não pertence a esta tarefa.");
    if (!text.trim() && !attachments.length)
      throw new Error("Digite uma mensagem.");
  }
  // Messages typed while the agent works wait in the task and go out in order.
  enqueue(taskId: string, text: string, attachments: string[] = []) {
    this.validateMessage(taskId, text, attachments);
    const item: QueuedMessage = {
      id: randomUUID(),
      text,
      attachments,
      createdAt: new Date().toISOString(),
    };
    this.updateTask(taskId, {
      queue: [...(this.task(taskId).queue ?? []), item],
    });
    this.sendNext(taskId);
    return item;
  }
  // Edits and reorders queued messages; items left out are removed.
  setQueue(taskId: string, items: { id: string; text: string }[]) {
    const queue = this.task(taskId).queue ?? [];
    return this.updateTask(taskId, {
      queue: items.map((i) => {
        const old = queue.find((q) => q.id === i.id);
        if (!old) throw new Error("Mensagem da fila não encontrada.");
        if (!i.text.trim() && !old.attachments.length)
          throw new Error("A mensagem não pode ficar vazia.");
        return { ...old, text: i.text };
      }),
    });
  }
  // Sends a queued message now: directly when idle, into the response in
  // progress when the CLI supports it, otherwise first in line.
  async sendQueued(taskId: string, itemId: string) {
    const t = this.task(taskId);
    const item = t.queue?.find((q) => q.id === itemId);
    if (!item) throw new Error("Mensagem da fila não encontrada.");
    const rest = t.queue!.filter((q) => q !== item);
    const restore = () =>
      this.updateTask(taskId, {
        queue: [item, ...(this.task(taskId).queue ?? [])],
      });
    const session = this.sessions.get(taskId);
    if (!["running", "waiting", "queued"].includes(t.status)) {
      this.updateTask(taskId, { queue: rest });
      await this.send(taskId, item.text, item.attachments).catch((e) => {
        restore();
        throw e;
      });
      return "sent";
    }
    if (t.status === "running" && session?.steer) {
      // Out of the queue first, so the end of the response cannot send it too.
      this.updateTask(taskId, { queue: rest });
      const steered = await session.steer(item.text, item.attachments).then(
        () => true,
        () => false,
      );
      if (steered) {
        this.resetGuard(taskId);
        this.assistantIds.delete(taskId);
        this.entry(taskId, "user", item.text, {
          attachments: item.attachments,
        });
        return "steered";
      }
      // The response ended before the message got in: it goes out next.
      restore();
      this.sendNext(taskId);
      return "next";
    }
    this.updateTask(taskId, { queue: [item, ...rest] });
    return "next";
  }
  private sendNext(taskId: string) {
    const t = this.task(taskId);
    const [item, ...rest] = t.queue ?? [];
    if (!item || this.disposed || t.status !== "idle" || !this.trusted(t))
      return;
    this.updateTask(taskId, { queue: rest });
    this.send(taskId, item.text, item.attachments).catch((e) => {
      this.updateTask(taskId, {
        queue: [item, ...(this.task(taskId).queue ?? [])],
      });
      this.entry(
        taskId,
        "error",
        `A próxima mensagem da fila não foi enviada: ${e.message}`,
      );
    });
  }
  async send(taskId: string, text: string, attachments: string[] = []) {
    const t = this.task(taskId);
    if (["running", "waiting", "queued"].includes(t.status))
      throw new Error("Aguarde ou interrompa a execução atual.");
    if (!this.trusted(t))
      throw new Error(
        "Confirme a confiança no projeto antes de executar seus CLIs e extensões.",
      );
    if (!this.agents.find((a) => a.id === t.agent)?.selected)
      throw new Error("Configure o executável do agente em Configurações.");
    if (t.effort) {
      let agent = this.agents.find((a) => a.id === t.agent)!;
      if (agent.catalogStatus !== "ready") agent = await this.auth(t.agent);
      if (agent.catalogStatus !== "ready")
        throw new Error(
          "Não foi possível verificar o esforço. Atualize a lista de modelos e tente novamente.",
        );
      if (
        !agent.models.find((m) => m.id === t.model)?.efforts?.includes(t.effort)
      )
        throw new Error(
          "O esforço salvo não está disponível neste modelo. Selecione outro esforço antes de enviar.",
        );
    }
    this.validateMessage(taskId, text, attachments);
    // Catalog verification may yield while another send claims this task.
    if (
      this.disposed ||
      ["running", "waiting", "queued"].includes(this.task(taskId).status)
    )
      throw new Error("Aguarde ou interrompa a execução atual.");
    this.entry(taskId, "user", text, { attachments });
    // Tasks run right away, including several chats in the same folder.
    const task = this.updateTask(taskId, { status: "running" });
    this.runStarts.set(taskId, Date.now());
    this.resetGuard(taskId);
    void this.run(task, { text, attachments }).catch((e) => {
      // Stopped and deleted meanwhile: nothing left to report on.
      if (
        this.disposed ||
        !this.store.all<Task>("task").some((t) => t.id === taskId)
      )
        return;
      const status = this.task(taskId).status;
      if (status === "running" || status === "waiting") {
        this.entry(taskId, "error", e.message);
        this.finish(taskId, "failed");
      }
    });
  }
  private async run(task: Task, job: { text: string; attachments: string[] }) {
    const agent = this.agents.find((a) => a.id === task.agent);
    const installation = agent?.selected;
    if (!installation) throw new Error("CLI não encontrado.");
    // A session kept open for background work takes the next message; its
    // settings cannot change meanwhile (see "task.update").
    const live = this.parked.delete(task.id)
      ? this.sessions.get(task.id)
      : undefined;
    const session = live ?? this.openSession(task, installation);
    let text = task.images.inputImage
      ? `${job.text}\n\nImagem de referência selecionada pelo usuário. Para editar pelo MCP codebit_images, use este identificador em inputImage: ${task.images.inputImage}`
      : job.text;
    if (task.contextPending) {
      text = this.missedContext(task) + text;
      this.updateTask(task.id, { contextPending: false });
    }
    // The agent learns why its last run was stopped, so it does not go back
    // to the same attempt on its own.
    if (task.guardNote) {
      text = `[Codebit] Sua execução anterior foi interrompida automaticamente porque ${task.guardNote}. Não repita essa ação por conta própria; siga o que o usuário disser abaixo.\n\n${text}`;
      this.updateTask(task.id, { guardNote: undefined });
    }
    await session.send(text, job.attachments);
    if (live) return;
    void session
      .models()
      .then((models) => {
        const a = this.agents.find((a) => a.id === task.agent);
        if (!this.disposed && a?.selected === installation && models.length) {
          a.models = models;
          a.catalogStatus = "ready";
          a.catalogError = undefined;
          this.refresh();
        }
      })
      .catch(() => {});
  }
  private openSession(task: Task, installation: Installation) {
    const selectedModel = this.agents
      .find((a) => a.id === task.agent)
      ?.models.find((m) => m.id === task.model);
    // Codex overrides persist in native threads. Reapply the catalog default
    // when the user clears an explicit effort, including after resuming.
    const sessionTask =
      task.agent === "codex" && !task.effort && selectedModel?.defaultEffort
        ? { ...task, effort: selectedModel.defaultEffort }
        : task;
    const mcp = mcpFor(task.agent, this.store.settings().mcp, {
      codebit_images: this.bridgeConfig(task.id, "images"),
      ...(subagentsFor(task, this.store.settings()).enabled
        ? { codebit_agents: this.bridgeConfig(task.id, "agents") }
        : {}),
      ...(task.projectId && this.social?.accounts(task.projectId).length
        ? { codebit_social: this.bridgeConfig(task.id, "social") }
        : {}),
      // Every session of a project reaches its task board.
      ...(task.projectId
        ? {
            codebit_tasks: this.bridgeConfig(task.id, "tasks", {
              CODEBIT_TASK_ROLE: task.workItemId ? "board" : "chat",
            }),
          }
        : {}),
    });
    const session = this.createSession(installation, sessionTask, mcp, (e) =>
      this.handle(task.id, e),
    );
    this.sessions.set(task.id, session);
    return session;
  }
  private createSession(
    installation: Installation,
    task: Task,
    mcp: Record<string, any>,
    emit: (event: AgentEvent) => void,
  ): AgentSession {
    return new sessionTypes[task.agent](
      installation,
      task,
      mcp,
      emit,
      this.store.settings().guidelines,
    );
  }
  // Conversation the task's agent has not seen since it was selected.
  private missedContext(task: Task) {
    const entries = this.store
      .entries(task.id)
      .filter((e) => e.kind === "user" || e.kind === "assistant");
    entries.pop(); // The message being sent now.
    // An agent resuming its session saw everything up to when the task
    // switched away from it (or, for older tasks, up to its last reply).
    const seen = task.seen?.[task.agent];
    const from = !task.nativeId
      ? 0
      : seen
        ? entries.findIndex((e) => e.id === seen) + 1
        : entries.findLastIndex(
            (e) => e.kind === "assistant" && e.agent === task.agent,
          ) + 1;
    const missed = entries.slice(from);
    return missed.length
      ? `Contexto da conversa nesta tarefa que você ainda não viu (outro agente atendeu):\n\n${this.transcript(missed)}\n\nMensagem atual:\n`
      : "";
  }
  private transcript(entries: Entry[]) {
    return entries
      .map(
        (e) =>
          `${e.kind === "user" ? "Usuário" : e.agent ? agentNames[e.agent] : "Agente"}: ${e.text}`,
      )
      .join("\n\n")
      .slice(-24000);
  }
  private handle(taskId: string, event: AgentEvent) {
    if (this.disposed || !this.sessions.has(taskId)) return;
    if (event.type === "native") {
      this.updateTask(taskId, { nativeId: event.id });
      return;
    }
    if (event.type === "usage") {
      this.updateTask(taskId, {
        context: {
          used: event.used,
          size: event.size ?? this.task(taskId).context?.size,
        },
      });
      return;
    }
    if (event.type === "commands") {
      const t = this.task(taskId);
      this.cacheCommands(t.agent, t.cwd, event.commands);
      return;
    }
    if (event.type === "quota") {
      this.mergeQuota(this.task(taskId).agent, event.windows);
      return;
    }
    if (event.type === "image") {
      void this.publishImage(taskId, event).catch((e) =>
        this.entry(taskId, "error", `Imagem não publicada: ${e.message}`),
      );
      return;
    }
    if (event.type === "plan") {
      void this.savePlan(taskId, event.text, event.path);
      return;
    }
    if (event.type === "background") {
      this.updateTask(taskId, { background: event.count || undefined });
      if (!event.count && this.parked.has(taskId)) this.closeWhenQuiet(taskId);
      return;
    }
    // The agent resumes on its own (Claude does when background work ends)
    // or background work asks for approval.
    if (
      this.parked.has(taskId) &&
      (event.type === "turn" || event.type === "request")
    ) {
      this.parked.delete(taskId);
      this.updateTask(taskId, { status: "running" });
    }
    if (event.type === "turn") {
      this.assistantIds.delete(taskId);
      return;
    }
    if (event.type === "text") {
      let id = this.assistantIds.get(taskId);
      if (!id) {
        id = this.entry(taskId, "assistant", "", {
          agent: this.task(taskId).agent,
        }).id;
        this.assistantIds.set(taskId, id);
      }
      const entry = this.store.get<Entry>("entry", id);
      entry.text += event.text;
      this.store.put("entry", entry);
      if (!this.notifyTimer)
        this.notifyTimer = setTimeout(() => {
          this.notifyTimer = undefined;
          this.refresh(taskId);
        }, 60);
    } else if (event.type === "activity") {
      this.assistantIds.delete(taskId);
      const row = this.entry(taskId, "activity", event.text);
      this.trackCall(taskId, event.id, row.id);
      this.trackEdits(taskId, event.files);
      this.stopIfStuck(
        taskId,
        this.guards
          .get(taskId)
          ?.action(event.key ?? event.text, event.text, !!event.files?.length),
      );
    } else if (event.type === "outcome") {
      this.settleCall(taskId, event.id, event.ok);
      this.stopIfStuck(taskId, this.guards.get(taskId)?.outcome(event.ok));
    } else if (event.type === "request") {
      this.entry(taskId, "request", event.request.title, {
        request: event.request,
      });
      this.updateTask(taskId, { status: "waiting" });
      this.notify(taskId, `Aguardando você: ${event.request.title}`);
    } else if (event.type === "error") {
      this.entry(taskId, "error", event.text);
      this.finish(taskId, "failed");
    } else if (event.type === "done") {
      // Codex and Devin answer plan mode in the chat: that answer is the
      // plan. Claude hands its plan over with ExitPlanMode instead.
      const t = this.task(taskId);
      const reply = this.assistantIds.get(taskId);
      if (t.mode === "plan" && t.agent !== "claude" && reply) {
        const text = this.store.get<Entry>("entry", reply).text;
        if (text.trim()) void this.savePlan(taskId, text);
      }
      if (t.background) this.park(taskId);
      else this.finish(taskId, "idle");
    }
  }
  // The plan becomes a .md document shown in the side panel. Claude writes
  // its own file; other agents' plans are saved in Codebit's data folder.
  private async savePlan(taskId: string, text: string, path?: string) {
    let file = path && existsSync(path) ? path : "";
    if (!file) {
      file = join(this.store.root, "plans", `${taskId}.md`);
      await mkdir(join(this.store.root, "plans"), { recursive: true });
      await writeFile(file, text);
    }
    if (this.disposed) return;
    this.updateTask(taskId, {
      plan: {
        text,
        path: file,
        agent: this.task(taskId).agent,
        at: new Date().toISOString(),
      },
    });
    this.emit({ type: "plan", taskId });
  }
  // Two chats conflict when both change a file while their runs overlap:
  // the other one changed it during this run, or during its own run that is
  // still going. Worktrees have paths of their own and never conflict.
  private trackEdits(taskId: string, files: string[] = []) {
    const t = this.task(taskId);
    const since = this.runStarts.get(taskId) ?? 0;
    for (const file of files) {
      const path = resolve(t.cwd, file);
      const key = path.toLowerCase();
      const last = this.edits.get(key);
      this.edits.set(key, { taskId, at: Date.now() });
      if (!last || last.taskId === taskId) continue;
      let other: Task;
      try {
        other = this.task(last.taskId);
      } catch {
        continue;
      }
      const otherActive =
        ["running", "waiting"].includes(other.status) &&
        last.at >= (this.runStarts.get(other.id) ?? 0);
      const pair = `${since}|${taskId}|${other.id}|${key}`;
      if ((last.at < since && !otherActive) || this.warned.has(pair)) continue;
      this.warned.add(pair);
      const name = relative(t.cwd, path) || path;
      this.entry(
        taskId,
        "warning",
        `A conversa “${other.title}” também alterou ${name} nesta pasta. Revise as mudanças antes de continuar.`,
        { title: "Conflito com outra conversa" },
      );
      this.entry(
        other.id,
        "warning",
        `A conversa “${t.title}” também alterou ${name}, que esta conversa mudou. Revise as mudanças antes de continuar.`,
        { title: "Conflito com outra conversa" },
      );
      this.notify(taskId, `Conflito: “${other.title}” também alterou ${name}.`);
    }
  }
  private newGuard() {
    const limits = this.store.settings().loopGuard ?? defaultLoopGuard;
    return limits.enabled ? new LoopGuard(limits) : undefined;
  }
  private resetGuard(taskId: string) {
    const guard = this.newGuard();
    if (guard) this.guards.set(taskId, guard);
    else this.guards.delete(taskId);
  }
  // The agent keeps trying something that does not work: stop the run and
  // hand the decision to the user.
  private stopIfStuck(taskId: string, reason?: string) {
    if (!reason || !this.guards.delete(taskId)) return;
    const t = this.updateTask(taskId, { guardNote: reason });
    this.entry(
      taskId,
      "warning",
      `Parei o ${agentNames[t.agent]}: ${reason}. Ele não vai tentar de novo por conta própria. Veja o que aconteceu e diga como prefere seguir.`,
      { title: "Ação interrompida pelo Codebit" },
    );
    this.notify(taskId, "Parei o agente: uma ação se repetia sem sucesso.");
    void this.interrupt(taskId);
  }
  private stopStuckQuick(id: string, reason: string) {
    const q = this.quick.get(id);
    if (!q?.session) return;
    this.attention({
      title: q.run.name,
      body: "Parei o prompt: uma ação se repetia sem sucesso.",
    });
    void q.session.interrupt().catch(() => {});
    this.endQuick(
      id,
      "interrupted",
      `O Codebit parou o prompt porque ${reason}.`,
    );
  }
  private notify(
    taskId: string,
    body: string,
    kind: "completed" | "failed" | "waiting" = "waiting",
  ) {
    const title = this.task(taskId).title;
    this.emit({
      type: "task-signal",
      signal: { id: randomUUID(), taskId, kind, title },
    });
    this.attention({ title, body, taskId });
  }
  // Closing the session would kill background commands and sub-agents, so it
  // stays open: the next message goes to it, and so does the agent's report.
  private park(id: string) {
    this.parked.add(id);
    this.assistantIds.delete(id);
    this.updateTask(id, { status: "idle" });
    this.sendNext(id);
  }
  // Once background work is over, the session closes unless the agent starts
  // a turn to report it.
  private closeWhenQuiet(id: string) {
    setTimeout(() => {
      if (!this.disposed && this.parked.has(id) && !this.task(id).background)
        this.finish(id, "idle");
    }, this.quietMs);
  }
  respond(taskId: string, entryId: string, value: any) {
    const entry = this.store.get<Entry>("entry", entryId);
    if (entry.taskId !== taskId || entry.resolved || !entry.request)
      throw new Error("Solicitação inválida.");
    // A post waiting for approval: the answer goes back to the tool call.
    const social = this.socialRequests.get(entry.request.id);
    if (social) {
      this.socialRequests.delete(entry.request.id);
      entry.resolved = true;
      this.store.put("entry", entry);
      this.updateTask(taskId, { status: "running" });
      social.resolve(value?.decision === "accept");
      return;
    }
    const sub = this.subRequests.get(entry.request.id);
    const session = sub?.session ?? this.sessions.get(taskId);
    if (!session || !this.sessions.has(taskId))
      throw new Error("Sessão encerrada. Retome a tarefa.");
    session.respond(sub?.id ?? entry.request.id, value);
    this.subRequests.delete(entry.request.id);
    entry.resolved = true;
    this.store.put("entry", entry);
    this.updateTask(taskId, { status: "running" });
    // An approved plan is carried out in the mode new tasks use, so the chat
    // and the next messages stop saying "Planejar".
    if (entry.request.plan && value.decision === "accept") {
      const preferred = this.store.settings().defaultMode ?? "bypass";
      const mode = preferred === "plan" ? "execute" : preferred;
      this.updateTask(taskId, { mode });
      void session.setMode?.(mode).catch(() => {});
    }
  }
  private finish(id: string, status: Task["status"]) {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    this.parked.delete(id);
    session?.close();
    for (const cancel of [...(this.subagents.get(id) ?? [])]) cancel();
    this.subagents.delete(id);
    this.slots.delete(id);
    this.assistantIds.delete(id);
    this.calls.delete(id);
    this.revokeBridge(id);
    for (const [key, pending] of this.socialRequests)
      if (pending.taskId === id) {
        this.socialRequests.delete(key);
        pending.resolve(false);
      }
    for (const e of this.store.entries(id))
      if (e.kind === "request" && !e.resolved)
        this.store.put("entry", { ...e, resolved: true });
    this.updateTask(id, { status, background: undefined });
    // After a failure or interruption the queue waits for the user.
    if (status === "idle") this.sendNext(id);
    const board = this.task(id).workItemId ? this.task(id) : undefined;
    // A queued message that went out keeps the task working: no notice yet.
    if (status === "failed")
      this.notify(
        id,
        board
          ? `A tarefa do quadro falhou: ${board.title}`
          : "A execução falhou.",
        "failed",
      );
    if (status === "idle" && this.task(id).status === "idle")
      this.notify(
        id,
        board
          ? `Tarefa do quadro concluída: ${board.title}`
          : `${agentNames[this.task(id).agent]} terminou.`,
        "completed",
      );
    if (board) this.workFinished(board.projectId, status);
    void this.checkVersions().catch(() => {});
  }
  // Removes a task with what Codebit keeps for it: history, images,
  // attachment copies and its saved plan. The project folder is never
  // touched; the task's own folder or worktree only when asked.
  async deleteTask(id: string, removeFolder = false) {
    const task = this.task(id);
    if (
      ["running", "waiting", "queued"].includes(task.status) ||
      task.background ||
      this.sessions.has(id)
    )
      throw new Error("Interrompa a tarefa antes de excluí-la.");
    const root = this.store.root;
    const paths = [
      join(root, "attachments", id),
      join(root, "artifacts", id),
      join(root, "plans", `${id}.md`),
    ];
    if (removeFolder && task.worktree) {
      const project = this.store
        .all<Project>("project")
        .find((p) => p.id === task.projectId);
      if (project) await removeWorktree(project.path, task.cwd);
    } else if (
      removeFolder &&
      !task.projectId &&
      resolve(task.cwd) === join(root, "scratch", id)
    )
      paths.push(task.cwd);
    this.images.cancel(id);
    // A board task goes with its internal session.
    if (task.workItemId) this.store.delete("work", task.workItemId);
    for (const e of this.store.entries(id)) this.store.delete("entry", e.id);
    for (const a of this.store.artifacts(id))
      this.store.delete("artifact", a.id);
    this.store.delete("task", id);
    this.guards.delete(id);
    this.calls.delete(id);
    this.assistantIds.delete(id);
    this.revokeBridge(id);
    await Promise.all(
      paths.map((p) =>
        rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
    );
    this.refresh();
  }
  async interrupt(id: string) {
    const s = this.sessions.get(id);
    if (s) await s.interrupt().catch(() => {});
    this.images.cancel(id);
    this.finish(id, "interrupted");
  }
  handoffSummary(id: string) {
    const t = this.task(id);
    const entries = this.store
      .entries(id)
      .filter((e) => ["user", "assistant"].includes(e.kind));
    return (
      `Continuar o trabalho: ${t.title}\nPasta: ${t.cwd}\nAgente anterior: ${t.agent}\n\nContexto visível (revise antes de enviar):\n\n` +
      this.transcript(entries.slice(-8))
    );
  }
  async handoff(id: string, agent: Task["agent"], summary: string) {
    const old = this.task(id);
    if (["running", "waiting", "queued"].includes(old.status))
      throw new Error("Encerre o turno atual antes de transferir contexto.");
    const task = await this.createTask({
      projectId: old.projectId,
      agent,
      title: old.title,
      parentId: id,
    });
    this.updateTask(task.id, {
      cwd: old.cwd,
      worktree: old.worktree,
      images: { ...old.images, inputImage: undefined },
    });
    this.entry(
      task.id,
      "activity",
      `Contexto transferido de ${old.agent}. A sessão original foi preservada.`,
    );
    return { task: this.task(task.id), draft: summary };
  }
  async generate(
    taskId: string,
    prompt: string,
    options?: ImageOptions,
  ): Promise<Artifact> {
    const t = this.task(taskId);
    const selected = { ...(options || t.images) };
    let inputPath: string | undefined;
    if (selected.inputImage) {
      const artifact = this.store
        .artifacts(taskId)
        .find((a) => a.id === selected.inputImage);
      const attachment = this.store
        .all<any>("attachment")
        .find((a) => a.id === selected.inputImage && a.taskId === taskId);
      inputPath = artifact?.path || attachment?.path;
      if (!inputPath || !/\.(png|jpe?g|webp)$/i.test(inputPath))
        throw new Error("Selecione uma imagem anexada a esta tarefa.");
      if (selected.provider === "comfyui" && selected.workflow === "sdxl-text")
        selected.workflow = "sdxl-edit";
    }
    const artifact = await this.images.generate(
      taskId,
      prompt,
      selected,
      inputPath,
    );
    this.store.put("artifact", artifact);
    this.entry(taskId, "image", prompt, { artifactId: artifact.id });
    return artifact;
  }
  // The project's task board.
  workItems(projectId: string) {
    return this.store
      .all<WorkItem>("work")
      .filter((i) => i.projectId === projectId)
      .sort((a, b) => a.order - b.order);
  }
  private workItem(id: string) {
    return this.store.get<WorkItem>("work", id);
  }
  private saveWork(item: WorkItem) {
    this.store.put("work", { ...item, updatedAt: new Date().toISOString() });
    this.refresh();
  }
  private busyTask(taskId?: string) {
    if (!taskId) return false;
    try {
      const t = this.task(taskId);
      return (
        ["running", "waiting", "queued"].includes(t.status) || !!t.background
      );
    } catch {
      return false;
    }
  }
  private nextOrder(projectId: string, first = false) {
    const orders = this.workItems(projectId).map((i) => i.order);
    return first ? Math.min(0, ...orders) - 1 : Math.max(0, ...orders) + 1;
  }
  // The user's tasks wait to start; the AI's wait for approval.
  addWork(
    projectId: string,
    input: { title: string; description?: string },
    meta: {
      origin?: "user" | "ai";
      sourceId?: string;
      chatId?: string;
    } = {},
  ) {
    const origin = meta.origin ?? "user";
    const project = this.store.get<Project>("project", projectId);
    const title = input.title.trim();
    if (!title) throw new Error("Dê um título à tarefa.");
    const now = new Date().toISOString();
    const item: WorkItem = {
      id: randomUUID(),
      projectId: project.id,
      title: title.slice(0, 200),
      description: (input.description ?? "").trim().slice(0, 20000),
      origin,
      state: origin === "ai" ? "pending" : "todo",
      order: this.nextOrder(project.id),
      sourceId: meta.sourceId,
      chatId: meta.chatId,
      createdAt: now,
      updatedAt: now,
    };
    this.store.put("work", item);
    this.refresh();
    if (item.state === "todo") void this.dispatchWork(project.id);
    return item;
  }
  editWork(id: string, patch: { title?: string; description?: string }) {
    const item = this.workItem(id);
    const title = patch.title?.trim();
    if (patch.title !== undefined && !title)
      throw new Error("Dê um título à tarefa.");
    this.saveWork({
      ...item,
      title: title?.slice(0, 200) ?? item.title,
      description:
        patch.description?.trim().slice(0, 20000) ?? item.description,
    });
    return this.workItem(id);
  }
  approveWork(id: string) {
    const item = this.workItem(id);
    if (item.state !== "pending") return item;
    this.saveWork({
      ...item,
      state: "todo",
      order: this.nextOrder(item.projectId),
      approvedAt: new Date().toISOString(),
    });
    void this.dispatchWork(item.projectId);
    return this.workItem(id);
  }
  // Moves a waiting task up or down the line.
  moveWork(id: string, direction: -1 | 1) {
    const item = this.workItem(id);
    const line = this.workItems(item.projectId).filter(
      (i) => i.state === item.state,
    );
    const at = line.findIndex((i) => i.id === id);
    const other = line[at + direction];
    if (!other) return;
    this.store.put("work", { ...item, order: other.order });
    this.saveWork({ ...other, order: item.order });
  }
  async deleteWork(id: string) {
    const item = this.workItem(id);
    if (this.busyTask(item.taskId))
      throw new Error("Interrompa a tarefa antes de excluí-la.");
    if (
      item.taskId &&
      this.store.all<Task>("task").some((t) => t.id === item.taskId)
    )
      await this.deleteTask(item.taskId);
    this.store.delete("work", id);
    this.refresh();
  }
  // Back to the front of the line; it resumes in the same session.
  retryWork(id: string) {
    const item = this.workItem(id);
    if (this.busyTask(item.taskId))
      throw new Error("Esta tarefa já está em andamento.");
    this.saveWork({
      ...item,
      state: "todo",
      order: this.nextOrder(item.projectId, true),
    });
    void this.dispatchWork(item.projectId);
    return this.workItem(id);
  }
  // Changes only the given settings, so quick successive changes add up.
  setWork(projectId: string, patch: Partial<WorkSettings>) {
    const project = this.store.get<Project>("project", projectId);
    const work = { ...(project.work ?? defaultWork), ...patch };
    if (work.enabled && !project.trusted)
      throw new Error("Confie no projeto antes de ligar o modo tarefas.");
    const settings: WorkSettings = {
      ...work,
      max: Math.min(4, Math.max(1, Math.round(work.max) || 1)),
    };
    this.store.put("project", { ...project, work: settings });
    if (settings.enabled && !project.work?.enabled)
      this.workFailures.delete(projectId);
    this.refresh();
    if (settings.enabled) void this.dispatchWork(projectId);
    return settings;
  }
  // Starts a task now, even with the mode off.
  startWork(id: string) {
    const item = this.workItem(id);
    return this.chain(item.projectId, () => this.launchWork(id));
  }
  dispatchAll() {
    for (const p of this.store.all<Project>("project"))
      if (p.work?.enabled) void this.dispatchWork(p.id);
  }
  // With the mode on, fills the free places with the next tasks in line.
  dispatchWork(projectId: string) {
    return this.chain(projectId, async () => {
      const project = this.store
        .all<Project>("project")
        .find((p) => p.id === projectId);
      const work = project?.work;
      if (this.disposed || !project?.trusted || !work?.enabled) return;
      const items = this.workItems(projectId);
      let free = work.max - items.filter((i) => this.busyTask(i.taskId)).length;
      for (const item of items.filter((i) => i.state === "todo")) {
        if (free-- <= 0) break;
        await this.launchWork(item.id);
      }
    });
  }
  private chain<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.dispatching.get(projectId) ?? Promise.resolve()).then(
      work,
      work,
    );
    this.dispatching.set(
      projectId,
      next.catch(() => {}),
    );
    return next;
  }
  private async launchWork(id: string) {
    const item = this.workItem(id);
    if (item.state === "pending")
      throw new Error("Aprove a recomendação antes de executá-la.");
    if (this.busyTask(item.taskId))
      throw new Error("Esta tarefa já está em andamento.");
    const project = this.store.get<Project>("project", item.projectId);
    if (!project.trusted)
      throw new Error("Confie no projeto antes de executar tarefas nele.");
    const work = project.work ?? defaultWork;
    const existing = this.store
      .all<Task>("task")
      .find((t) => t.id === item.taskId);
    let task = existing;
    if (!task) {
      task = await this.createTask({
        projectId: project.id,
        title: item.title,
        agent: work.agent,
        workItemId: item.id,
      });
      const settings = { model: work.model || task.model, mode: work.mode };
      try {
        task = this.updateTask(task.id, { ...settings, effort: work.effort });
      } catch {
        task = this.updateTask(task.id, settings);
      }
    }
    this.saveWork({ ...item, state: "started", taskId: task.id });
    const text = existing
      ? "Retome esta tarefa do quadro de onde parou. Se ela já estiver concluída, confirme com um resumo curto do que foi feito."
      : [
          `Tarefa do quadro do projeto ${project.name}: ${item.title}`,
          item.description,
          "Trabalhe nesta tarefa até concluí-la. Ao terminar, responda com um resumo curto do que foi feito e de como conferir.",
        ]
          .filter(Boolean)
          .join("\n\n");
    try {
      await this.send(task.id, text);
    } catch (e) {
      // The reason stays in the session; the mode stops so the next tasks
      // do not fail the same way.
      this.entry(task.id, "error", (e as Error).message);
      this.updateTask(task.id, { status: "failed" });
      this.pauseWork(
        project.id,
        `não foi possível iniciar "${item.title}": ${(e as Error).message}`,
      );
      throw e;
    }
  }
  private workFinished(projectId: string, status: Task["status"]) {
    const failures =
      status === "failed" ? (this.workFailures.get(projectId) ?? 0) + 1 : 0;
    this.workFailures.set(projectId, failures);
    if (failures >= 2)
      this.pauseWork(projectId, "duas tarefas seguidas falharam");
    else void this.dispatchWork(projectId);
  }
  private pauseWork(projectId: string, reason: string) {
    const project = this.store.get<Project>("project", projectId);
    if (!project.work?.enabled) return;
    this.store.put("project", {
      ...project,
      work: { ...project.work, enabled: false },
    });
    this.workFailures.delete(projectId);
    this.refresh();
    this.attention?.({
      title: "Modo tarefas pausado",
      body: `${project.name}: ${reason}. Confira e ligue de novo no quadro.`,
    });
  }
  // codebit_tasks, the channel from a project's sessions to its board. What
  // the user asked for goes to "todo"; the agent's own ideas wait for
  // approval, like the follow-ups of board sessions.
  tasksTool(
    taskId: string,
    call: {
      tool: string;
      args?: {
        tasks?: { title: string; description?: string }[];
        requested_by_user?: boolean;
      };
    },
  ) {
    const task = this.task(taskId);
    if (!task.projectId)
      throw new Error(
        "Esta conversa não tem projeto; o quadro de tarefas é de cada projeto.",
      );
    const reply = (text: string) => ({ content: [{ type: "text", text }] });
    const items = this.workItems(task.projectId);
    if (call.tool === "list_tasks") {
      const tasks = new Map(this.store.all<Task>("task").map((t) => [t.id, t]));
      return reply(
        JSON.stringify(
          items.slice(-100).map((i) => ({
            title: i.title,
            status: workStatus(i, i.taskId ? tasks.get(i.taskId) : undefined),
            origin: i.origin,
            description: i.description.slice(0, 300),
          })),
        ),
      );
    }
    const list = call.args?.tasks ?? [];
    const requested = call.args?.requested_by_user === true;
    const pending = items.filter((i) => i.state === "pending").length;
    if (!requested && pending + list.length > 50)
      throw new Error(
        "Já há muitas sugestões esperando aprovação neste projeto. Não sugira mais agora.",
      );
    const created = list.map((t) =>
      this.addWork(task.projectId, t, {
        origin: requested ? "user" : "ai",
        sourceId: task.workItemId,
        chatId: task.workItemId ? undefined : task.id,
      }),
    );
    const titles = created.map((c) => c.title).join("; ");
    const count =
      created.length === 1 ? "1 tarefa" : `${created.length} tarefas`;
    this.entry(
      taskId,
      "activity",
      requested
        ? `Quadro · ${count} em A fazer: ${titles}`
        : `Quadro · ${count} ${created.length === 1 ? "sugerida, pendente" : "sugeridas, pendentes"} de aprovação: ${titles}`,
    );
    return reply(
      requested
        ? `Adicionadas ao quadro, em "A fazer": ${titles}.${this.store.get<Project>("project", task.projectId).work?.enabled ? " O modo tarefas está ligado: agentes vão começar nelas pela fila." : " O modo tarefas está desligado: elas esperam até o usuário ligar ou executar."} Não trabalhe nelas nesta conversa.`
        : `Registradas como sugestões, pendentes de aprovação do usuário: ${titles}. Não trabalhe nelas agora.`,
    );
  }
  // The codebit_social tools. Every post shows its exact preview in the chat
  // and waits for the user, even in Bypass.
  async socialTool(taskId: string, call: { tool: string; args: any }) {
    const task = this.task(taskId);
    const accounts =
      task.projectId && this.social ? this.social.accounts(task.projectId) : [];
    const reply = (value: unknown) => ({
      content: [
        {
          type: "text",
          text: typeof value === "string" ? value : JSON.stringify(value),
        },
      ],
    });
    if (call.tool === "social_accounts")
      return reply(
        accounts.map((a) => ({
          network: a.network,
          account: a.name,
          type: a.accountType,
          accessUntil: a.expiresAt,
          problem: a.error,
        })),
      );
    if (!this.social || !accounts.length)
      throw new Error(
        "Este projeto não tem redes sociais conectadas. Conecte em Configurações → Redes sociais.",
      );
    if (task.mode === "plan")
      throw new Error("Publicar está desabilitado no modo Planejar.");
    const args = call.args ?? {};
    const network = call.tool === "patreon_publish" ? "patreon" : "instagram";
    const account = this.social.account(task.projectId, network);
    if (!account)
      throw new Error(
        `Conecte uma conta do ${socialNetworkNames[network]} a este projeto em Configurações → Redes sociais.`,
      );
    const images = await this.socialImages(
      task,
      args.images ?? [],
      network === "instagram" ? ["png", "jpg", "jpeg"] : undefined,
    );
    const postId = randomUUID();
    if (network === "instagram") {
      const kind = args.kind === "story" ? "story" : "feed";
      const caption = String(args.caption ?? "");
      if (
        !images.length ||
        images.length > 10 ||
        (kind === "story" && images.length > 1)
      )
        throw new Error(
          kind === "story"
            ? "Um story leva exatamente uma imagem."
            : "Um post do Instagram leva de 1 a 10 imagens.",
        );
      if (caption.length > 2200)
        throw new Error("A legenda passa de 2.200 caracteres.");
      const prepared = await this.social.prepareInstagram(postId, images, kind);
      const accepted = await this.askToPublish(taskId, {
        network,
        account: account.name,
        images: prepared,
        text: kind === "story" ? "" : caption,
        kind:
          kind === "story" ? "Story" : images.length > 1 ? "Carrossel" : "Feed",
      });
      if (!accepted)
        return reply(
          "O usuário recusou a publicação. Não publique de outra forma; pergunte o que ele quer ajustar.",
        );
      this.entry(
        taskId,
        "activity",
        `Instagram · publicando em ${account.name}…`,
      );
      const result = await this.social.publishInstagram(account, {
        images: prepared,
        caption,
        kind,
        altText: args.alt_text ? String(args.alt_text) : undefined,
        aiGenerated: args.ai_generated === true,
      });
      this.social.record({
        id: postId,
        projectId: task.projectId,
        taskId,
        network,
        accountId: account.id,
        url: result.url,
        mediaId: result.mediaId,
        text: caption,
        images: prepared,
      });
      this.entry(
        taskId,
        "activity",
        `Instagram · publicado · ${result.url ?? result.mediaId}`,
      );
      return reply({
        published: true,
        url: result.url,
        mediaId: result.mediaId,
      });
    }
    const title = String(args.title ?? "").trim();
    const text = String(args.text ?? "").trim();
    const audience = String(args.audience ?? "").trim();
    if (!title || !text || !audience)
      throw new Error(
        "Informe title, text e audience (public, members, paid ou o nome exato de um nível).",
      );
    const audienceName =
      {
        public: "Público",
        members: "Todos os membros",
        paid: "Só membros pagantes",
      }[audience.toLowerCase()] ?? audience;
    const accepted = await this.askToPublish(taskId, {
      network,
      account: account.name,
      images,
      title,
      text,
      audience: audienceName,
    });
    if (!accepted)
      return reply(
        "O usuário recusou a publicação. Não publique de outra forma; pergunte o que ele quer ajustar.",
      );
    this.entry(
      taskId,
      "activity",
      `Patreon · preenchendo o editor em ${account.name}…`,
    );
    const result = await this.social.publishPatreon(account, {
      title,
      text,
      images,
      audience,
    });
    this.social.record({
      id: postId,
      projectId: task.projectId,
      taskId,
      network,
      accountId: account.id,
      url: result.url,
      title,
      text,
      images,
    });
    this.entry(taskId, "activity", `Patreon · publicado · ${result.url}`);
    return reply({ published: true, url: result.url });
  }
  // Images by Codebit image id or by path, absolute or from the task folder.
  private async socialImages(task: Task, items: unknown[], types?: string[]) {
    if (!Array.isArray(items) || items.length > 10)
      throw new Error("Envie no máximo 10 imagens.");
    const artifacts = this.store.artifacts(task.id);
    return Promise.all(
      items.map(async (item) => {
        const ref = String(item);
        const path =
          artifacts.find((a) => a.id === ref)?.path ?? resolve(task.cwd, ref);
        const ext = path.split(".").pop()?.toLowerCase() ?? "";
        const allowed = types ?? ["png", "jpg", "jpeg", "gif", "webp"];
        if (!allowed.includes(ext))
          throw new Error(
            `Formato não aceito (${ref}). Use ${allowed.join(", ").toUpperCase()}.`,
          );
        if (!(await stat(path).catch(() => null))?.isFile())
          throw new Error(`Imagem não encontrada: ${ref}`);
        return path;
      }),
    );
  }
  private askToPublish(taskId: string, preview: SocialPreview) {
    const id = "social-" + randomUUID();
    const title = `Publicar no ${socialNetworkNames[preview.network]}`;
    this.entry(taskId, "request", title, {
      request: {
        id,
        kind: "approval",
        title,
        detail: "",
        choices: ["decline", "accept"],
        social: preview,
      },
    });
    this.updateTask(taskId, { status: "waiting" });
    this.notify(taskId, `Aguardando você: ${title}`);
    return new Promise<boolean>((resolve) =>
      this.socialRequests.set(id, { taskId, resolve }),
    );
  }
  async imageTool(
    taskId: string,
    args: { prompt: string; inputImage?: string },
  ) {
    const t = this.task(taskId);
    if (t.mode === "plan")
      throw new Error("Geração de imagem desabilitada em modo planejamento.");
    const artifact = await this.generate(taskId, args.prompt, {
      ...t.images,
      inputImage: args.inputImage,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: artifact.id,
            path: artifact.path,
            provider: artifact.provider,
            model: artifact.model,
          }),
        },
        {
          type: "image",
          mimeType: "image/png",
          data: (await readFile(artifact.path)).toString("base64"),
        },
      ],
    };
  }
  private async publishImage(
    taskId: string,
    image: { prompt: string; data?: string; path?: string },
  ) {
    const bytes = image.data
      ? Buffer.from(image.data, "base64")
      : await readFile(image.path!);
    const artifact = await this.images.save(
      taskId,
      image.prompt,
      {
        ...this.task(taskId).images,
        provider: "codex",
        model: codexImageModel,
      },
      bytes,
    );
    this.store.put("artifact", artifact);
    // Text after the image starts a new message below it.
    this.assistantIds.delete(taskId);
    this.entry(taskId, "image", image.prompt, { artifactId: artifact.id });
  }
  async quota(agentId: AgentId, refresh = false) {
    const agent = this.agents.find((a) => a.id === agentId);
    if (!agent?.selected) throw new Error("CLI não encontrado.");
    if (
      !refresh &&
      agent.quota &&
      Date.now() - Date.parse(agent.quota.checkedAt) < 120_000
    )
      return agent.quota;
    let load = this.quotaLoads.get(agentId);
    if (!load) {
      load = probeQuota(agent.selected, this.store.root);
      this.quotaLoads.set(agentId, load);
      void load.finally(() => this.quotaLoads.delete(agentId)).catch(() => {});
    }
    try {
      agent.quota = await load;
      agent.quotaError = undefined;
      return agent.quota;
    } catch (e) {
      agent.quotaError = (e as Error).message;
      throw e;
    } finally {
      this.refresh();
    }
  }
  // Rolling updates from a running session replace windows with the same label.
  private mergeQuota(agentId: AgentId, windows: QuotaWindow[]) {
    const agent = this.agents.find((a) => a.id === agentId);
    if (!agent || !windows.length) return;
    const current = agent.quota?.windows ?? [];
    agent.quota = {
      ...agent.quota,
      windows: [
        ...current.map((w) => windows.find((n) => n.label === w.label) ?? w),
        ...windows.filter((n) => !current.some((w) => w.label === n.label)),
      ],
      checkedAt: new Date().toISOString(),
    };
    this.refresh();
  }
  async commands(taskId: string, refresh = false) {
    const t = this.task(taskId);
    const installation = this.agents.find((a) => a.id === t.agent)?.selected;
    // Listing starts the CLI in the folder, which loads project settings.
    if (!installation || !this.trusted(t)) return [];
    const key = `${t.agent}|${t.cwd}`;
    const cached = this.commandCache.get(key);
    if (!refresh && cached && Date.now() - cached.at < 300_000)
      return cached.list;
    const list = probeCommands(installation, t.cwd);
    this.commandCache.set(key, { at: Date.now(), list });
    list.catch(() => this.commandCache.delete(key));
    return list;
  }
  private cacheCommands(agent: AgentId, cwd: string, list: AgentCommand[]) {
    if (list.length)
      this.commandCache.set(`${agent}|${cwd}`, {
        at: Date.now(),
        list: Promise.resolve(list),
      });
  }
  async subagentTool(
    taskId: string,
    args: { tasks: { title?: string; prompt: string }[] },
  ) {
    const parent = this.task(taskId);
    const options = subagentsFor(parent, this.store.settings());
    if (!options.enabled)
      throw new Error("Os sub-agentes estão desligados nesta tarefa.");
    const installation = this.agents.find(
      (a) => a.id === options.agent,
    )?.selected;
    if (!installation)
      throw new Error(
        `${agentNames[options.agent]} não encontrado. Configure o CLI em Configurações.`,
      );
    const results = await Promise.all(
      args.tasks.map(async (item, i) => {
        const name = `Sub-agente ${i + 1}/${args.tasks.length}${item.title ? ` · ${item.title}` : ""}`;
        // The limit applies to the whole task, even across parallel calls.
        const release = await this.slot(taskId, options.max);
        try {
          return {
            task: name,
            response: await this.runSubagent(
              parent,
              installation,
              options,
              name,
              item.prompt,
            ),
          };
        } catch (e) {
          return { task: name, error: (e as Error).message };
        } finally {
          release();
        }
      }),
    );
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
  }
  private async slot(taskId: string, max: number) {
    const s = this.slots.get(taskId) ?? { active: 0, waiting: [] };
    this.slots.set(taskId, s);
    while (s.active >= max) await new Promise<void>((r) => s.waiting.push(r));
    s.active++;
    return () => {
      s.active--;
      s.waiting.shift()?.();
    };
  }
  private runSubagent(
    parent: Task,
    installation: Installation,
    options: SubagentOptions,
    name: string,
    prompt: string,
  ) {
    if (this.disposed || !this.sessions.has(parent.id))
      return Promise.reject(new Error("A tarefa principal foi encerrada."));
    const model = this.agents
      .find((a) => a.id === options.agent)
      ?.models.find((m) => m.id === options.model)?.name;
    const label = `${name} · ${agentNames[options.agent]}${model ? ` · ${model}` : ""}`;
    // Subagents inherit folder and mode, without internal MCPs or a resumable session.
    const task: Task = {
      ...parent,
      id: `${parent.id}:${randomUUID()}`,
      agent: options.agent,
      model: options.model,
      effort: options.effort,
      nativeId: undefined,
      nativeIds: undefined,
      contextPending: false,
      subagents: undefined,
    };
    this.entry(parent.id, "activity", `${label} · iniciado`);
    const running = this.subagents.get(parent.id) ?? new Set<() => void>();
    this.subagents.set(parent.id, running);
    return new Promise<string>((resolve, reject) => {
      let text = "";
      const done = (error?: Error) => {
        if (!running.delete(cancel)) return;
        session.close();
        for (const [key, r] of this.subRequests)
          if (r.session === session) this.subRequests.delete(key);
        if (!this.disposed)
          this.entry(
            parent.id,
            "activity",
            `${label} · ${error ? `falhou: ${error.message}` : "concluído"}`,
          );
        if (error) reject(error);
        else resolve(text.slice(-20000));
      };
      const cancel = () => done(new Error("A tarefa principal foi encerrada."));
      running.add(cancel);
      // A stuck sub-agent is stopped and the main agent is told to ask the
      // user instead of trying again.
      const guard = this.newGuard();
      const stuck = (reason?: string) => {
        if (!reason || !running.has(cancel)) return;
        this.entry(parent.id, "warning", `${label}: ${reason}.`, {
          title: "Sub-agente interrompido pelo Codebit",
        });
        this.notify(
          parent.id,
          `Parei ${label}: uma ação se repetia sem sucesso.`,
        );
        void session.interrupt().catch(() => {});
        done(
          new Error(
            `O Codebit interrompeu este sub-agente porque ${reason}. Não tente de novo nem crie outro sub-agente para a mesma ação: pare e explique o problema ao usuário.`,
          ),
        );
      };
      const session = this.createSession(installation, task, {}, (e) => {
        if (e.type === "text") text += e.text;
        else if (e.type === "activity") {
          const row = this.entry(parent.id, "activity", `${label} · ${e.text}`);
          this.trackCall(parent.id, e.id && `${label}#${e.id}`, row.id);
          this.trackEdits(parent.id, e.files);
          stuck(guard?.action(e.key ?? e.text, e.text, !!e.files?.length));
        } else if (e.type === "outcome") {
          this.settleCall(parent.id, e.id && `${label}#${e.id}`, e.ok);
          stuck(guard?.outcome(e.ok));
        } else if (e.type === "request") {
          const id = "sub-" + randomUUID();
          this.subRequests.set(id, { session, id: e.request.id });
          const title = `${label} · ${e.request.title}`;
          this.entry(parent.id, "request", title, {
            request: { ...e.request, id, title },
          });
          this.updateTask(parent.id, { status: "waiting" });
          this.notify(parent.id, `Aguardando você: ${title}`);
        } else if (e.type === "done") done();
        else if (e.type === "error") done(new Error(e.text));
      });
      session.send(prompt, []).catch((e) => done(e));
    });
  }
  savePrompt(input: Omit<SavedPrompt, "id" | "createdAt"> & { id?: string }) {
    if (input.projectId) this.store.get<Project>("project", input.projectId);
    const old = input.id
      ? this.store.get<SavedPrompt>("prompt", input.id)
      : undefined;
    const prompt = this.store.put<SavedPrompt>("prompt", {
      ...input,
      id: old?.id ?? randomUUID(),
      createdAt: old?.createdAt ?? new Date().toISOString(),
    });
    this.refresh();
    return prompt;
  }
  deletePrompt(id: string) {
    this.store.delete("prompt", id);
    this.refresh();
  }
  // Work an update restart would cut: turns, approvals, background work,
  // saved prompts and image generation.
  busy() {
    return (
      this.store
        .all<Task>("task")
        .some(
          (t) =>
            ["running", "waiting", "queued"].includes(t.status) ||
            !!t.background,
        ) ||
      [...this.quick.values()].some((q) => !!q.session) ||
      this.images.busy()
    );
  }
  // Newest first, as the panel lists them.
  quickRuns() {
    return [...this.quick.values()].map((q) => q.run).reverse();
  }
  // Runs a saved prompt apart from the conversations: the open task only
  // lends its agent and model, and its project when the prompt is global.
  async startQuick(promptId: string, taskId?: string) {
    const prompt = this.store.get<SavedPrompt>("prompt", promptId);
    const open = taskId ? this.task(taskId) : undefined;
    const projectId = prompt.projectId || open?.projectId || "";
    const project = projectId
      ? this.store.get<Project>("project", projectId)
      : undefined;
    if (project && !project.trusted)
      throw new Error(
        "Confie no projeto antes de executar prompts nele. Abra uma tarefa do projeto e confirme.",
      );
    const agent =
      open?.agent ?? this.agents.find((a) => a.selected)?.id ?? "codex";
    const installation = this.agents.find((a) => a.id === agent)?.selected;
    if (!installation)
      throw new Error("Configure o executável do agente em Configurações.");
    const mcp = mcpFor(agent, this.store.settings().mcp, {});
    const cwd = project?.path ?? join(this.store.root, "scratch", "prompts");
    if (!project) await mkdir(cwd, { recursive: true });
    const now = new Date().toISOString();
    const run: QuickRun = {
      id: randomUUID(),
      promptId,
      name: prompt.name,
      text: prompt.text,
      agent,
      model: open?.model ?? this.store.settings().defaultModels[agent] ?? "",
      effort: open?.effort || undefined,
      mode: prompt.mode,
      projectId,
      cwd,
      status: "running",
      reply: "",
      activity: [],
      startedAt: now,
    };
    const task: Task = {
      id: `prompt:${run.id}`,
      projectId,
      title: prompt.name,
      agent,
      model: run.model,
      effort: run.effort,
      cwd,
      worktree: false,
      mode: prompt.mode,
      status: "running",
      archived: false,
      createdAt: now,
      updatedAt: now,
      images: { ...defaultImages },
    };
    const q: { run: QuickRun; session?: AgentSession; guard?: LoopGuard } = {
      run,
      guard: this.newGuard(),
    };
    this.quick.set(run.id, q);
    q.session = this.createSession(installation, task, mcp, (e) =>
      this.quickEvent(run.id, e),
    );
    this.publishQuick(run.id, true);
    q.session
      .send(prompt.text, [])
      .catch((e) => this.endQuick(run.id, "failed", e.message));
    return run;
  }
  private quickEvent(id: string, e: AgentEvent) {
    const q = this.quick.get(id);
    if (!q?.session || this.disposed) return;
    const run = q.run;
    if (e.type === "text") run.reply += e.text;
    else if (e.type === "activity") {
      run.activity.push(e.text);
      const reason = q.guard?.action(
        e.key ?? e.text,
        e.text,
        !!e.files?.length,
      );
      if (reason) return this.stopStuckQuick(id, reason);
    } else if (e.type === "outcome") {
      const reason = q.guard?.outcome(e.ok);
      if (reason) return this.stopStuckQuick(id, reason);
      return;
    } else if (e.type === "native") run.nativeId = e.id;
    else if (e.type === "quota") this.mergeQuota(run.agent, e.windows);
    else if (
      e.type === "request" &&
      run.mode === "plan" &&
      e.request.tool === "ExitPlanMode"
    )
      // Claude asks to leave plan mode even to answer; a read-only prompt
      // never leaves it, so the answer must come right away.
      q.session.respond(e.request.id, {
        decision: "decline",
        message:
          "Este pedido é só de leitura: não saia do modo de planejamento. Responda aqui mesmo, por completo, sem alterar arquivos.",
      });
    else if (e.type === "request") {
      run.request = e.request;
      run.status = "waiting";
      this.attention({
        title: run.name,
        body: `Aguardando você: ${e.request.title}`,
      });
    } else if (e.type === "done") return this.endQuick(id, "done");
    else if (e.type === "error") return this.endQuick(id, "failed", e.text);
    else return;
    this.publishQuick(id);
  }
  private endQuick(id: string, status: QuickRun["status"], error?: string) {
    const q = this.quick.get(id);
    if (!q?.session) return;
    q.session.close();
    q.session = undefined;
    Object.assign(q.run, { status, error, request: undefined });
    this.publishQuick(id, true);
    if (status === "done")
      this.attention({ title: q.run.name, body: "Prompt concluído." });
    if (status === "failed")
      this.attention({ title: q.run.name, body: "O prompt falhou." });
  }
  private publishQuick(id: string, now = false) {
    const q = this.quick.get(id);
    if (!q || (q.timer && !now)) return;
    clearTimeout(q.timer);
    const send = () => {
      q.timer = undefined;
      this.emit({
        type: "quick",
        run: { ...q.run, activity: [...q.run.activity] },
      });
    };
    if (now) send();
    else q.timer = setTimeout(send, 60);
  }
  respondQuick(id: string, value: any) {
    const q = this.quick.get(id);
    if (!q?.session || !q.run.request)
      throw new Error("Esta solicitação não está mais ativa.");
    q.session.respond(q.run.request.id, value);
    Object.assign(q.run, { request: undefined, status: "running" });
    this.publishQuick(id, true);
  }
  async stopQuick(id: string) {
    const q = this.quick.get(id);
    if (q?.session) await q.session.interrupt().catch(() => {});
    this.endQuick(id, "interrupted");
  }
  async dismissQuick(id: string) {
    await this.stopQuick(id);
    clearTimeout(this.quick.get(id)?.timer);
    this.quick.delete(id);
    this.emit({ type: "quick-removed", id });
  }
  // Keeps a finished run as a conversation that resumes the same session.
  async keepQuick(id: string) {
    const run = this.quick.get(id)?.run;
    if (!run || run.status === "running" || run.status === "waiting")
      throw new Error("Aguarde o prompt terminar.");
    const t = await this.createTask({
      projectId: run.projectId,
      title: run.name,
      agent: run.agent,
      cwd: run.cwd,
    });
    const task = this.store.put<Task>("task", {
      ...t,
      model: run.model,
      effort: run.effort ?? "",
      mode: run.mode,
      nativeId: run.nativeId,
    });
    this.entry(task.id, "user", run.text);
    if (run.reply)
      this.entry(task.id, "assistant", run.reply, { agent: run.agent });
    await this.dismissQuick(id);
    return task;
  }
  close() {
    this.disposed = true;
    for (const q of this.quick.values()) {
      clearTimeout(q.timer);
      q.session?.close();
    }
    this.catalogAbort.abort();
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    for (const cancels of this.subagents.values())
      for (const cancel of [...cancels]) cancel();
    for (const [id, s] of this.sessions) {
      this.updateTask(id, { status: "interrupted" });
      s.close();
    }
    this.sessions.clear();
    this.images.close();
  }
}
