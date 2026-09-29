import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Channel } from "./protocol";
import { nativeModels } from "./models";
import { guidelinesText, stopWhenStuck } from "../extensions";
import type {
  AgentEvent,
  AgentSession,
  Installation,
  Model,
  Task,
} from "../../shared/types";
import { appVersion } from "../../shared/types";
const modes = { plan: "plan", execute: "accept-edits", bypass: "bypass" };
// Devin CLI 3000.10 starts MCP servers received over ACP but its MCP tools only
// see servers from its own config files, so the Codebit tools are not offered.
const instructions =
  "Você está no Codebit. Responda em português do Brasil." + stopWhenStuck;
const imageTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
// Devin CLI speaks the Agent Client Protocol (ACP) through `devin acp`.
export class DevinSession implements AgentSession {
  private channel: Channel;
  private ready: Promise<void>;
  private sessionId = "";
  private instructed = false;
  private loading = false;
  private catalog: Model[] = [];
  private requests = new Map<string, any>();
  constructor(
    i: Installation,
    private task: Task,
    private mcp: Record<string, any>,
    private emit: (event: AgentEvent) => void,
    private guidelines = "",
  ) {
    this.channel = new Channel(
      i,
      ["acp"],
      task.cwd,
      "acp",
      (msg) => this.receive(msg),
      (e) => emit({ type: "error", text: e.message }),
    );
    this.ready = this.init();
    this.ready.catch(() => {});
  }
  private async init() {
    await this.channel.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "codebit", title: "Codebit", version: appVersion },
    });
    // Devin accepts only stdio MCP servers.
    const mcpServers = Object.entries(this.mcp)
      .filter(([, s]) => s.command)
      .map(([name, s]) => ({
        name,
        command: s.command,
        args: s.args || [],
        env: Object.entries(s.env || {}).map(([key, value]) => ({
          name: key,
          value: String(value),
        })),
      }));
    const params = { cwd: this.task.cwd, mcpServers };
    let session: any;
    if (this.task.nativeId) {
      // session/load replays the history as updates before it responds.
      this.loading = true;
      try {
        session = await this.channel.request("session/load", {
          ...params,
          sessionId: this.task.nativeId,
        });
      } finally {
        this.loading = false;
      }
      this.sessionId = this.task.nativeId;
      this.instructed = true;
    } else {
      session = await this.channel.request("session/new", params);
      this.sessionId = session.sessionId;
    }
    this.catalog = modelOptions(session.configOptions);
    if (this.task.model)
      await this.channel.request("session/set_config_option", {
        sessionId: this.sessionId,
        configId: "model",
        value: this.task.model,
      });
    await this.channel.request("session/set_mode", {
      sessionId: this.sessionId,
      modeId: modes[this.task.mode],
    });
    this.emit({ type: "native", id: this.sessionId });
  }
  private receive(msg: any) {
    const p = msg.params || {};
    if (msg.id != null && msg.method) {
      const id = String(msg.id);
      if (msg.method === "session/request_permission") {
        this.requests.set(id, msg);
        this.emit({
          type: "request",
          request: {
            id,
            kind: "approval",
            title: p.toolCall?.title
              ? `Permitir ${p.toolCall.title}?`
              : "Permitir ação?",
            detail: JSON.stringify(p.toolCall?.rawInput ?? p.toolCall, null, 2),
            choices: ["decline", "accept"],
          },
        });
      } else
        this.channel.send({
          id: msg.id,
          error: {
            code: -32601,
            message: "Solicitação ainda não suportada pelo Codebit.",
          },
        });
      return;
    }
    if (msg.method !== "session/update" || this.loading) return;
    const u = p.update || {};
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text")
      this.emit({ type: "text", text: u.content.text });
    if (u.sessionUpdate === "tool_call")
      this.emit({
        type: "activity",
        id: u.toolCallId,
        text: u.rawInput?.command
          ? `Terminal · ${u.rawInput.command}`
          : u.title || "Ferramenta",
        files: ["edit", "delete", "move"].includes(u.kind)
          ? (u.locations || []).map((l: any) => l.path).filter(Boolean)
          : undefined,
        // The input without its free-text description, plus the paths it
        // touches, identifies the action.
        key: `${u.kind} ${JSON.stringify({ ...u.rawInput, description: undefined })} ${(u.locations || []).map((l: any) => l.path).join(",") || u.title || ""}`,
      });
    if (
      u.sessionUpdate === "tool_call_update" &&
      (u.status === "completed" || u.status === "failed")
    )
      this.emit({
        type: "outcome",
        ok: u.status === "completed",
        id: u.toolCallId,
      });
    if (u.sessionUpdate === "usage_update" && typeof u.used === "number")
      this.emit({ type: "usage", used: u.used, size: u.size || undefined });
    if (u.sessionUpdate === "available_commands_update")
      this.emit({
        type: "commands",
        commands: (u.availableCommands || []).map((c: any) => ({
          name: c.name,
          description: c.description || "",
          kind: "command",
          hint: c.input?.hint || undefined,
        })),
      });
  }
  async send(text: string, attachments: string[]) {
    await this.ready;
    // ACP has no system prompt, so new sessions get the instructions inline.
    const prompt: any[] = [
      {
        type: "text",
        text: this.instructed
          ? text
          : `${instructions}${guidelinesText(this.guidelines)}\n\n${text}`,
      },
    ];
    this.instructed = true;
    for (const path of attachments) {
      const mimeType = imageTypes[extname(path).toLowerCase()];
      if (mimeType) {
        prompt.push({
          type: "text",
          text: `Imagem anexada pelo usuário: ${path}`,
        });
        prompt.push({
          type: "image",
          mimeType,
          data: (await readFile(path)).toString("base64"),
        });
      } else
        prompt.push({
          type: "text",
          text: `Arquivo anexado pelo usuário: ${path}`,
        });
    }
    // The prompt request resolves only when the whole turn ends.
    this.channel
      .request(
        "session/prompt",
        { sessionId: this.sessionId, prompt },
        24 * 3_600_000,
      )
      .then(
        (r) =>
          this.emit(
            r?.stopReason === "refusal"
              ? { type: "error", text: "O modelo recusou a solicitação." }
              : { type: "done" },
          ),
        (e) => this.emit({ type: "error", text: e.message }),
      );
  }
  respond(id: string, value: any) {
    const m = this.requests.get(id);
    if (!m) throw new Error("Esta solicitação não está mais ativa.");
    const allow = value.decision === "accept";
    const options: any[] = m.params.options || [];
    const option =
      options.find((o) => o.kind === (allow ? "allow_once" : "reject_once")) ||
      options.find((o) =>
        String(o.kind).startsWith(allow ? "allow" : "reject"),
      );
    this.channel.send({
      id: m.id,
      result: {
        outcome: option
          ? { outcome: "selected", optionId: option.optionId }
          : { outcome: "cancelled" },
      },
    });
    this.requests.delete(id);
  }
  async models(): Promise<Model[]> {
    await this.ready;
    return this.catalog;
  }
  async interrupt() {
    await this.ready;
    this.channel.send({
      method: "session/cancel",
      params: { sessionId: this.sessionId },
    });
  }
  close() {
    this.channel.close();
  }
}
function modelOptions(configOptions: any[] = []): Model[] {
  return nativeModels(
    "devin",
    configOptions.find((o) => o.id === "model")?.options || [],
  );
}
