import { randomUUID } from "node:crypto";
import {
  mkdir,
  realpath,
  copyFile,
  stat,
  readFile,
  writeFile,
} from "node:fs/promises";
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
import { agentNames, defaultImages } from "../shared/types";
import { Store } from "./store";
import { discover, checkAuth, readVersion } from "./discovery";
import { CodexSession } from "./agents/codex";
import { ClaudeSession } from "./agents/claude";
import { DevinSession } from "./agents/devin";
import { probeCommands, probeModels } from "./agents/catalog";
import { probeQuota } from "./agents/quota";
import { createWorktree, isGit } from "./workspace";
import { codexImageModel, ImageService } from "./images";
import { mcpFor } from "./extensions";
import type { BridgeKind } from "./bridge";
const sessionTypes = {
  codex: CodexSession,
  claude: ClaudeSession,
  devin: DevinSession,
};
export class Runtime {
  agents: AgentInfo[] = [];
  images: ImageService;
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
  // Tasks whose turn ended while background work kept the session open.
  private parked = new Set<string>();
  // Last chat that changed each file (by absolute path) and when each run
  // started, to warn when parallel chats in one folder change the same file.
  private edits = new Map<string, { taskId: string; at: number }>();
  private runStarts = new Map<string, number>();
  private warned = new Set<string>();
  private quick = new Map<
    string,
    { run: QuickRun; session?: AgentSession; timer?: NodeJS.Timeout }
  >();
  // How long a parked session with no background work left waits for the
  // agent's report before closing.
  quietMs = 3000;
  private notifyTimer?: NodeJS.Timeout;
  private disposed = false;
  private detection?: Promise<AgentInfo[]>;
  private versionCheck = 0;
  private catalogLoads = new WeakMap<AgentInfo, Promise<AgentInfo>>();
  private catalogAbort = new AbortController();
  bridgeConfig: (taskId: string, kind: BridgeKind) => any = () => ({});
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
    };
    this.store.put("task", task);
    this.refresh();
    return task;
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
      if (!info.isFile() || info.size > 20_000_000)
        throw new Error("Anexos devem ser arquivos de até 20 MB.");
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
    void this.run(task, { text, attachments }).catch((e) => {
      if (this.disposed) return;
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
      ...(task.subagents?.enabled
        ? { codebit_agents: this.bridgeConfig(task.id, "agents") }
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
      this.entry(taskId, "activity", event.text);
      this.trackEdits(taskId, event.files);
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
      if (this.task(taskId).background) this.park(taskId);
      else this.finish(taskId, "idle");
    }
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
      );
      this.entry(
        other.id,
        "warning",
        `A conversa “${t.title}” também alterou ${name}, que esta conversa mudou. Revise as mudanças antes de continuar.`,
      );
      this.notify(taskId, `Conflito: “${other.title}” também alterou ${name}.`);
    }
  }
  private notify(taskId: string, body: string) {
    this.attention({ title: this.task(taskId).title, body, taskId });
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
    const sub = this.subRequests.get(entry.request.id);
    const session = sub?.session ?? this.sessions.get(taskId);
    if (!session || !this.sessions.has(taskId))
      throw new Error("Sessão encerrada. Retome a tarefa.");
    session.respond(sub?.id ?? entry.request.id, value);
    this.subRequests.delete(entry.request.id);
    entry.resolved = true;
    this.store.put("entry", entry);
    this.updateTask(taskId, { status: "running" });
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
    this.revokeBridge(id);
    for (const e of this.store.entries(id))
      if (e.kind === "request" && !e.resolved)
        this.store.put("entry", { ...e, resolved: true });
    this.updateTask(id, { status, background: undefined });
    // After a failure or interruption the queue waits for the user.
    if (status === "idle") this.sendNext(id);
    // A queued message that went out keeps the task working: no notice yet.
    if (status === "failed") this.notify(id, "A execução falhou.");
    if (status === "idle" && this.task(id).status === "idle")
      this.notify(id, `${agentNames[this.task(id).agent]} terminou.`);
    void this.checkVersions().catch(() => {});
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
    const options = parent.subagents;
    if (!options?.enabled)
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
      const session = this.createSession(installation, task, {}, (e) => {
        if (e.type === "text") text += e.text;
        else if (e.type === "activity") {
          this.entry(parent.id, "activity", `${label} · ${e.text}`);
          this.trackEdits(parent.id, e.files);
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
    const q: { run: QuickRun; session?: AgentSession } = { run };
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
    else if (e.type === "activity") run.activity.push(e.text);
    else if (e.type === "native") run.nativeId = e.id;
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
