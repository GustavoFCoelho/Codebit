import { Channel } from "./protocol";
import { nativeModels } from "./models";
import { codexSkills } from "./catalog";
import { codexWindows } from "./quota";
import { codebitInstructions } from "../extensions";
import type {
  AgentEvent,
  AgentSession,
  Installation,
  Model,
  Task,
} from "../../shared/types";
import { appVersion } from "../../shared/types";
export class CodexSession implements AgentSession {
  private channel: Channel;
  private ready: Promise<void>;
  private nativeId = "";
  private turnId = "";
  private starting?: Promise<any>;
  private requests = new Map<string, any>();
  private textSeen = false;
  private skills = new Map<string, string>();
  // Commands still running and sub-agent threads with a turn in progress.
  private commands = new Set<string>();
  private children = new Set<string>();
  private background = 0;
  constructor(
    i: Installation,
    private task: Task,
    mcp: Record<string, any>,
    private emit: (event: AgentEvent) => void,
    private guidelines = "",
  ) {
    this.channel = new Channel(
      i,
      ["app-server", "--listen", "stdio://"],
      task.cwd,
      "codex",
      (msg) => this.receive(msg),
      (e) => emit({ type: "error", text: e.message }),
    );
    this.ready = this.init(mcp);
    this.ready.catch(() => {});
  }
  private async init(mcp: Record<string, any>) {
    await this.channel.request("initialize", {
      clientInfo: { name: "codebit", title: "Codebit", version: appVersion },
      capabilities: { experimentalApi: true },
    });
    this.channel.send({ method: "initialized" });
    const params = {
      cwd: this.task.cwd,
      model: this.task.model || null,
      approvalPolicy: this.task.mode === "bypass" ? "never" : "on-request",
      approvalsReviewer: "user",
      sandbox: {
        plan: "read-only",
        execute: "workspace-write",
        bypass: "danger-full-access",
      }[this.task.mode],
      config: Object.fromEntries(
        Object.entries(mcp).map(([name, value]) => [
          "mcp_servers." + name,
          value,
        ]),
      ),
      developerInstructions: codebitInstructions(mcp, this.guidelines),
    };
    const r = await this.channel.request(
      this.task.nativeId ? "thread/resume" : "thread/start",
      {
        ...params,
        ...(this.task.nativeId ? { threadId: this.task.nativeId } : {}),
      },
    );
    this.nativeId = r.thread.id;
    this.emit({ type: "native", id: this.nativeId });
    const skills = await codexSkills(this.channel, this.task.cwd).catch(
      () => [],
    );
    for (const s of skills) this.skills.set(s.name, s.path!);
    this.emit({ type: "commands", commands: skills });
  }
  private receive(msg: any) {
    const p = msg.params || {};
    if (msg.id != null && msg.method) {
      const id = String(msg.id);
      this.requests.set(id, msg);
      if (msg.method === "item/tool/requestUserInput")
        this.emit({
          type: "request",
          request: {
            id,
            kind: "question",
            title: "O agente precisa da sua resposta",
            detail: "",
            questions: (p.questions || []).map((q: any) => ({
              id: q.id,
              question: q.question,
              options: q.options?.map((o: any) => o.label),
            })),
          },
        });
      else if (msg.method.includes("requestApproval"))
        this.emit({
          type: "request",
          request: {
            id,
            kind: "approval",
            title: msg.method.includes("fileChange")
              ? "Permitir alterações?"
              : msg.method.includes("permissions")
                ? "Conceder permissões?"
                : "Permitir execução?",
            detail: [
              p.reason,
              p.command,
              p.changes ? JSON.stringify(p.changes, null, 2) : "",
              p.permissions ? JSON.stringify(p.permissions) : "",
              p.cwd,
            ]
              .filter(Boolean)
              .join("\n"),
            choices: ["decline", "accept"],
          },
        });
      // Codex asks before running MCP tools through a confirmation elicitation.
      else if (
        msg.method === "mcpServer/elicitation/request" &&
        p._meta?.codex_approval_kind === "mcp_tool_call"
      )
        this.emit({
          type: "request",
          request: {
            id,
            kind: "approval",
            title: `Permitir ferramenta MCP de ${p.serverName}?`,
            detail: [
              p.message,
              JSON.stringify(p._meta.tool_params ?? {}, null, 2),
            ].join("\n"),
            choices: ["decline", "accept"],
          },
        });
      else if (msg.method === "mcpServer/elicitation/request") {
        this.channel.send({
          id: msg.id,
          result: { action: "cancel", content: null },
        });
        this.requests.delete(id);
        this.emit({
          type: "activity",
          text: "O servidor MCP solicitou uma configuração interativa. Configure o acesso no CLI e retome.",
        });
      } else {
        this.channel.send({
          id: msg.id,
          error: {
            code: -32601,
            message: "Solicitação ainda não suportada pelo Codebit.",
          },
        });
        this.requests.delete(id);
      }
      return;
    }
    // Sub-agents run in threads of their own; their events must not end or
    // fill this conversation.
    if (p.threadId && this.nativeId && p.threadId !== this.nativeId) {
      this.child(msg);
      return;
    }
    if (msg.method === "turn/started") {
      this.turnId = p.turn.id;
      this.emit({ type: "turn" });
    }
    if (msg.method === "item/agentMessage/delta") {
      this.textSeen = true;
      this.emit({ type: "text", text: p.delta });
    }
    if (msg.method === "item/started") {
      const i = p.item;
      // A turn can hold several agent messages; keep them apart in the chat.
      if (i?.type === "agentMessage" && this.textSeen)
        this.emit({ type: "text", text: "\n\n" });
      if (i?.type === "commandExecution") {
        this.commands.add(i.id);
        this.emit({
          type: "activity",
          text: `Terminal · ${i.command}`,
          id: i.id,
        });
      }
      if (i?.type === "collabAgentToolCall")
        this.emit({
          type: "activity",
          text: `Sub-agente · ${i.tool}${i.prompt ? ` · ${i.prompt.slice(0, 120)}` : ""}`,
        });
      if (i?.type === "fileChange") {
        const files = (i.changes || []).map((c: any) => c.path);
        this.emit({
          type: "activity",
          text: `Alterar arquivos · ${files.join(", ")}`,
          files,
          id: i.id,
        });
      }
      if (i?.type === "mcpToolCall")
        this.emit({
          type: "activity",
          text: `MCP · ${i.server}/${i.tool}`,
          id: i.id,
          key: `MCP · ${i.server}/${i.tool} ${JSON.stringify(i.arguments ?? {})}`,
        });
    }
    if (
      msg.method === "item/completed" &&
      ["commandExecution", "fileChange", "mcpToolCall"].includes(p.item?.type)
    )
      this.emit({
        type: "outcome",
        ok:
          p.item.status === "completed" &&
          (p.item.exitCode == null || p.item.exitCode === 0),
        id: p.item.id,
      });
    if (
      msg.method === "item/completed" &&
      p.item?.type === "agentMessage" &&
      !this.textSeen &&
      p.item.text
    )
      this.emit({ type: "text", text: p.item.text });
    if (
      msg.method === "item/completed" &&
      p.item?.type === "plan" &&
      p.item.text
    )
      this.emit({ type: "plan", text: p.item.text });
    // Images Codex creates with its own tool are published in the chat.
    if (
      msg.method === "item/completed" &&
      p.item?.type === "imageGeneration" &&
      !p.item.failure &&
      (p.item.result || p.item.savedPath)
    )
      this.emit({
        type: "image",
        prompt: p.item.revisedPrompt || "Imagem gerada pelo Codex",
        data: p.item.result || undefined,
        path: p.item.savedPath,
      });
    if (msg.method === "account/rateLimits/updated" && p.rateLimits)
      this.emit({ type: "quota", windows: codexWindows(p.rateLimits) });
    if (msg.method === "thread/tokenUsage/updated" && p.tokenUsage?.last)
      this.emit({
        type: "usage",
        used: p.tokenUsage.last.totalTokens,
        size: p.tokenUsage.modelContextWindow ?? undefined,
      });
    if (
      msg.method === "item/completed" &&
      p.item?.type === "commandExecution" &&
      this.commands.delete(p.item.id) &&
      !this.turnId
    )
      this.reportBackground();
    if (msg.method === "turn/completed") {
      this.turnId = "";
      // Commands the turn left running (a dev server, for example) keep
      // the session open.
      this.reportBackground();
      if (p.turn?.error)
        this.emit({ type: "error", text: p.turn.error.message });
      else this.emit({ type: "done" });
    }
    if (msg.method === "error" && !p.willRetry)
      this.emit({ type: "error", text: p.error?.message || "Falha no Codex." });
  }
  private child(msg: any) {
    const p = msg.params;
    if (msg.method === "turn/started") this.children.add(p.threadId);
    if (msg.method === "turn/completed") this.children.delete(p.threadId);
    if (msg.method === "turn/started" || msg.method === "turn/completed")
      this.reportBackground();
    if (msg.method === "item/started" && p.item?.type === "commandExecution")
      this.emit({
        type: "activity",
        text: `Sub-agente · Terminal · ${p.item.command}`,
      });
  }
  private reportBackground() {
    const count = this.commands.size + this.children.size;
    if (count !== this.background)
      this.emit({ type: "background", count: (this.background = count) });
  }
  async send(text: string, attachments: string[]) {
    await this.ready;
    this.textSeen = false;
    this.starting = this.channel.request("turn/start", {
      threadId: this.nativeId,
      input: this.input(text, attachments),
      model: this.task.model || null,
      ...(this.task.effort ? { effort: this.task.effort } : {}),
    });
    const r = await this.starting;
    this.turnId ||= r?.turn?.id || "";
  }
  // Adds the message to the turn in progress instead of waiting for it to end.
  async steer(text: string, attachments: string[]) {
    await this.ready;
    // The task shows as running slightly before Codex opens the turn.
    await this.starting?.catch(() => {});
    if (!this.turnId) throw new Error("Nenhuma resposta em andamento.");
    await this.channel.request("turn/steer", {
      threadId: this.nativeId,
      expectedTurnId: this.turnId,
      input: this.input(text, attachments),
    });
  }
  private input(text: string, attachments: string[]) {
    const input: any[] = [
      {
        type: "text",
        text:
          this.task.mode === "plan"
            ? `Modo planejamento: analise e proponha; não execute alterações.\n\n${text}`
            : text,
        text_elements: [],
      },
    ];
    // Codex invokes skills mentioned as $name through skill input items.
    for (const [, name] of text.matchAll(/\$([\w:.-]+)/g))
      if (this.skills.has(name))
        input.push({ type: "skill", name, path: this.skills.get(name) });
    for (const path of attachments) {
      if (/\.(png|jpe?g|webp|gif)$/i.test(path))
        input.push({
          type: "text",
          text: `Imagem anexada. Identificador para codebit_images.edit_image: ${path}`,
          text_elements: [],
        });
      input.push(
        /\.(png|jpe?g|webp|gif)$/i.test(path)
          ? { type: "localImage", path }
          : {
              type: "text",
              text: `Arquivo anexado pelo usuário: ${path}`,
              text_elements: [],
            },
      );
    }
    return input;
  }
  respond(id: string, value: any) {
    const m = this.requests.get(id);
    if (!m) throw new Error("Esta solicitação não está mais ativa.");
    let result: any;
    if (m.method === "item/tool/requestUserInput")
      result = {
        answers: Object.fromEntries(
          Object.entries(value.answers || {}).map(([k, v]) => [
            k,
            { answers: Array.isArray(v) ? v : [String(v)] },
          ]),
        ),
      };
    else if (m.method === "mcpServer/elicitation/request")
      result =
        value.decision === "accept"
          ? { action: "accept", content: {}, _meta: null }
          : { action: "decline", content: null, _meta: null };
    else if (m.method === "item/permissions/requestApproval")
      result = {
        permissions:
          value.decision === "accept" ? m.params.permissions || {} : {},
        scope: "turn",
      };
    else
      result = { decision: value.decision === "accept" ? "accept" : "decline" };
    this.channel.send({ id: m.id, result });
    this.requests.delete(id);
  }
  async models(): Promise<Model[]> {
    await this.ready;
    const all: Model[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await this.channel.request("model/list", {
        limit: 100,
        cursor,
        includeHidden: false,
      });
      all.push(...nativeModels("codex", r.data || []));
      cursor = r.nextCursor;
    } while (cursor);
    return all;
  }
  async interrupt() {
    await this.ready;
    if (this.turnId)
      await this.channel.request("turn/interrupt", {
        threadId: this.nativeId,
        turnId: this.turnId,
      });
  }
  close() {
    this.channel.close();
  }
}
