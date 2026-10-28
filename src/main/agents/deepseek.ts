import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Channel } from "./protocol";
import { codebitInstructions } from "../extensions";
import {
  appVersion,
  type AgentEvent,
  type AgentSession,
  type Installation,
  type InspectCommand,
  type Model,
  type Task,
} from "../../shared/types";

// A deployment-owned pre-tool policy. ACP has no session/set_mode. Keep it
// outside the model prompt so a planning instruction cannot grant write access.
export const deepseekPolicy = `
export const name = 'codebit-policy';
export const inject = ['tools', 'approval', 'permissionPresets'];
export function apply(ctx) {
  const plan = process.env.CODEBIT_DSH_MODE === 'plan';
  const readOnly = e => ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch'].includes(e.name)
    || (e.name === 'str_replace_editor' && e.arguments?.command === 'view');
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind !== 'reject' && !signal.aborted)
      ctx.permissionPresets.set(agent.session, plan ? 'codebit-plan' : 'codebit-run');
    return decision;
  });
  ctx.tools.guard(e => plan && !readOnly(e) ? 'Codebit: modo Planejar permite apenas ferramentas de leitura. Apresente o plano na resposta final.' : undefined);
  ctx.on('tools/pre-execute', async (e, next) => {
    const decision = await next();
    if (decision.kind !== 'allow' || readOnly(e)) return decision;
    if (plan) return { kind: 'deny', reason: 'Codebit: ferramenta indisponível no modo Planejar.' };
    return { kind: 'ask', reason: 'Codebit: autorização da ferramenta.' };
  });
}
`;

// One persistent home per Codebit conversation, never the user's global DSH
// profile. No key is serialized here; it only enters the child environment.
export function prepareDeepseekHome(
  home: string,
  model: string,
  mode = "execute",
) {
  mkdirSync(home, { recursive: true });
  const policy = join(home, "codebit-policy.mjs");
  const patch = join(home, "codebit.patch.yml");
  writeFileSync(policy, deepseekPolicy);
  writeFileSync(
    patch,
    JSON.stringify(
      [
        {
          id: "acp",
          config: {
            provider: "deepseek-official",
            model: model || "deepseek-flash",
          },
        },
        { id: "approval", config: { policy: "ask" } },
        {
          id: "permission",
          config: {
            defaultPreset: mode === "plan" ? "codebit-plan" : "codebit-run",
            presets: {
              "codebit-plan": { sandbox: "read-only", approval: "ask" },
              "codebit-run": { sandbox: "danger-full-access", approval: "ask" },
            },
          },
        },
        // Native descendants have no ACP approval channel. Codebit's own
        // subagents use separate sessions with their own permission channel.
        ...[
          "tool-subagent",
          "tool-subagent-fork",
          "tool-subagent-control",
          "tool-cordis",
          "tool-schedule",
          "plan-mode",
        ].map((id) => ({ id, disabled: true })),
        {
          insert: [{ id: "codebit-policy", name: pathToFileURL(policy).href }],
        },
      ],
      null,
      2,
    ),
  );
  return patch;
}

function commandPath(command: string) {
  if (isAbsolute(command)) return command;
  const extensions =
    process.platform === "win32" && !extname(command)
      ? [".exe", ".cmd", ""]
      : [""];
  for (const root of (process.env.PATH || "").split(delimiter))
    for (const extension of extensions) {
      const path = join(root, command + extension);
      if (isAbsolute(path) && existsSync(path)) return path;
    }
  throw new Error(
    `Executável MCP não encontrado: ${command}. Informe um caminho absoluto.`,
  );
}
export function deepseekMcp(mcp: Record<string, any>) {
  const pairs = (obj: Record<string, any> = {}) =>
    Object.entries(obj).map(([name, value]) => ({
      name,
      value: String(value),
    }));
  return Object.entries(mcp).map(([name, server]) =>
    server.command
      ? {
          name,
          command: commandPath(server.command),
          args: server.args || [],
          env: pairs(server.env),
        }
      : { name, type: "http", url: server.url, headers: pairs(server.headers) },
  );
}

export class DeepseekSession implements AgentSession {
  private channel: Channel;
  private ready: Promise<void>;
  private sessionId = "";
  private calls = new Map<string, any>();
  private requests = new Map<string, any>();
  private closed = false;
  private images = false;
  private catalog: Model[] = [];
  private secrets: string[];
  constructor(
    installation: Installation,
    private task: Task,
    private mcp: Record<string, any>,
    private emit: (event: AgentEvent) => void,
    private guidelines = "",
    private inspect?: InspectCommand,
    home = join(task.cwd, ".codebit-deepseek"),
  ) {
    const key =
      installation.env?.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY;
    if (!key?.trim())
      throw new Error("Cadastre DEEPSEEK_API_KEY em Configurações → Secrets.");
    this.secrets = [key, ...Object.values(installation.env || {})].filter(
      (v) => v.length >= 6,
    );
    const patch = prepareDeepseekHome(home, task.model, task.mode);
    this.channel = new Channel(
      {
        ...installation,
        env: {
          ...installation.env,
          DEEPSEEK_API_KEY: key,
          DEEPSEEK_BASE_URL: "https://api.deepseek.com/anthropic",
          DSH_HOME: home,
          CODEBIT_DSH_MODE: task.mode,
          DSH_PERMISSION_MODE:
            task.mode === "plan" ? "read-only" : "danger-full-access",
          // The private Node runtime must also be available to DSH's child tools.
          PATH: `${dirname(installation.command)}${delimiter}${process.env.PATH || ""}`,
        },
      },
      ["--profile", "acp", "--patch", patch],
      task.cwd,
      "acp",
      (msg) => this.receive(msg),
      (error) => this.fail(error),
    );
    this.ready = this.init().catch((e) => {
      throw new Error(this.clean((e as Error).message));
    });
    this.ready.catch(() => {});
  }
  private clean(text: string) {
    for (const secret of this.secrets)
      text = text.split(secret).join("[segredo omitido]");
    return text;
  }
  private fail(error: Error) {
    if (!this.closed)
      this.emit({ type: "error", text: this.clean(error.message) });
  }
  private async init() {
    const init = await this.channel.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "codebit", title: "Codebit", version: appVersion },
    });
    this.images = init.agentCapabilities?.promptCapabilities?.image === true;
    const session = await this.channel.request(
      this.task.nativeId ? "session/resume" : "session/new",
      {
        cwd: this.task.cwd,
        mcpServers: deepseekMcp(this.mcp),
        ...(this.task.nativeId ? { sessionId: this.task.nativeId } : {}),
      },
    );
    this.sessionId = session.sessionId || this.task.nativeId;
    if (!this.sessionId)
      throw new Error("O DeepSeek Harness não retornou uma sessão.");
    const options =
      (session.configOptions || []).find((o: any) => o.id === "model")
        ?.options || [];
    const flat = options.flatMap((o: any) => o.options || [o]);
    this.catalog = flat.flatMap((o: any) => {
      try {
        const [provider, id] = JSON.parse(o.value);
        return provider === "deepseek-official"
          ? [{ id, name: o.name || id }]
          : [];
      } catch {
        return [];
      }
    });
    await this.channel.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId: "model",
      value: JSON.stringify([
        "deepseek-official",
        this.task.model || "deepseek-flash",
      ]),
    });
    if (this.task.effort)
      await this.channel.request("session/set_config_option", {
        sessionId: this.sessionId,
        configId: "reasoning_effort",
        value: this.task.effort,
      });
    this.emit({ type: "native", id: this.sessionId });
  }
  private receive(msg: any) {
    if (msg.id != null && msg.method) {
      if (msg.method === "session/request_permission")
        void this.permission(msg).catch((error) => {
          if (!this.closed)
            this.channel.send({
              id: msg.id,
              result: { outcome: { outcome: "cancelled" } },
            });
          this.fail(error);
        });
      else
        this.channel.send({
          id: msg.id,
          error: {
            code: -32601,
            message: "Solicitação não suportada pelo Codebit.",
          },
        });
      return;
    }
    if (msg.method !== "session/update" || this.closed) return;
    const u = msg.params?.update || {};
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text")
      this.emit({ type: "text", text: this.clean(u.content.text) });
    if (u.sessionUpdate === "tool_call") {
      this.calls.set(u.toolCallId, u);
      const shell = ["pwsh", "bash"].includes(u.title);
      const file = u.rawInput?.path || u.rawInput?.file_path;
      const edit =
        ["write", "edit"].includes(u.title) ||
        (u.title === "str_replace_editor" && u.rawInput?.command !== "view");
      this.emit({
        type: "activity",
        id: u.toolCallId,
        text: this.clean(
          shell
            ? `Terminal · ${u.rawInput?.command || u.title}`
            : `${u.title || "Ferramenta"}${file ? ` · ${file}` : ""}`,
        ),
        files: edit && typeof file === "string" ? [file] : undefined,
        key: this.clean(`${u.title} ${JSON.stringify(u.rawInput)}`),
      });
    }
    if (
      u.sessionUpdate === "tool_call_update" &&
      ["completed", "failed"].includes(u.status)
    ) {
      this.emit({
        type: "outcome",
        id: u.toolCallId,
        ok: u.status === "completed",
      });
      this.calls.delete(u.toolCallId);
    }
    if (u.sessionUpdate === "usage_update" && typeof u.used === "number")
      this.emit({ type: "usage", used: u.used, size: u.size || undefined });
  }
  private async permission(msg: any) {
    const id = String(msg.id);
    const call = this.calls.get(msg.params?.toolCall?.toolCallId);
    this.requests.set(id, msg);
    // Unknown calls fail closed; the ACP permission carries only a call id.
    if (!call || this.task.mode === "plan")
      return this.respond(id, { decision: "decline" });
    const command = ["pwsh", "bash"].includes(call.title)
      ? call.rawInput?.command
      : undefined;
    const blast =
      typeof command === "string" && this.inspect
        ? await this.inspect(command, this.task.mode !== "bypass")
        : undefined;
    if (this.closed) return;
    if (this.task.mode === "bypass" && !blast)
      return this.respond(id, { decision: "accept" });
    this.emit({
      type: "request",
      request: {
        id,
        kind: "approval",
        title: `Permitir ${call.title || "ferramenta"}?`,
        detail: this.clean(JSON.stringify(call.rawInput || {}, null, 2)),
        choices: ["decline", "accept"],
        ...(blast ? { blast } : {}),
      },
    });
  }
  async send(text: string, attachments: string[]) {
    await this.ready;
    const mode =
      this.task.mode === "plan"
        ? "Modo Planejar: use apenas leitura e apresente o plano na resposta final, sem executar a implementação."
        : `Modo ${this.task.mode === "bypass" ? "Bypass" : "Executar"}.`;
    const prompt: any[] = [
      {
        type: "text",
        text: `${codebitInstructions(this.mcp, this.guidelines)}\n\n${mode}\n\n${text}`,
      },
    ];
    const types: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
    };
    for (const path of attachments) {
      prompt.push({
        type: "text",
        text: `Arquivo anexado pelo usuário: ${path}`,
      });
      const mimeType = types[extname(path).toLowerCase()];
      if (mimeType && this.images)
        prompt.push({
          type: "image",
          mimeType,
          data: (await readFile(path)).toString("base64"),
        });
    }
    this.channel
      .request(
        "session/prompt",
        { sessionId: this.sessionId, prompt },
        24 * 3_600_000,
      )
      .then(
        (result) => {
          if (!this.closed)
            this.emit(
              result.stopReason === "refusal"
                ? { type: "error", text: "O DeepSeek recusou a solicitação." }
                : { type: "done" },
            );
        },
        (error) => this.fail(error),
      );
  }
  respond(id: string, value: any) {
    const msg = this.requests.get(id);
    if (!msg) throw new Error("Esta solicitação não está mais ativa.");
    const kind = value.decision === "accept" ? "allow_once" : "reject_once";
    const option = msg.params?.options?.find((o: any) => o.kind === kind);
    this.channel.send({
      id: msg.id,
      result: {
        outcome: option
          ? { outcome: "selected", optionId: option.optionId }
          : { outcome: "cancelled" },
      },
    });
    this.requests.delete(id);
  }
  // The runtime catalog comes from GET /models, not ACP's reduced metadata.
  async models(): Promise<Model[]> {
    await this.ready;
    return [];
  }
  async interrupt() {
    await this.ready;
    this.channel.send({
      method: "session/cancel",
      params: { sessionId: this.sessionId },
    });
  }
  close() {
    this.closed = true;
    this.requests.clear();
    this.calls.clear();
    this.channel.close();
  }
}
