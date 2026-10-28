import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { Channel } from "./protocol";
import { codebitInstructions } from "../extensions";
import type {
  AgentEvent,
  AgentSession,
  InspectCommand,
  Installation,
  Model,
  RequestPrompt,
  Task,
} from "../../shared/types";
// The helper that answers the hook, as the bridge describes it.
export interface HookServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface AntigravityHost {
  // Where the session's plugin goes; Codebit's, never the project's.
  dir: string;
  hook?: HookServer;
  // Called once the session is closed.
  release?: () => void;
}
export type HookDecision = { decision: "allow" | "deny"; reason?: string };
// Codebit's own servers; codebit_social asks before each post by itself.
const internalServers = ["codebit_images", "codebit_agents", "codebit_social"];
// Tool steps the hook sees in each mode. Reads go ahead everywhere.
const gatedTools =
  "run_command|send_command_input|call_mcp_tool|write_file|edit_file|.*browser.*";
const matchers = {
  plan: gatedTools,
  execute: gatedTools,
  bypass: "run_command|write_file|edit_file",
};
const editTools = ["write_file", "edit_file"];
const imageTypes = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
function inside(parent: string, path: string) {
  const r = relative(resolve(parent), resolve(path));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}
// Antigravity CLI takes no MCP servers or instructions per session. A plugin
// in a folder added to the workspace (--add-dir) carries Codebit's servers,
// the instructions (as rules) and the hook that gates tools. The plugin is
// named codebit, so its servers reach the agent as codebit_images and so on.
export function writePlugin(
  root: string,
  task: Task,
  mcp: Record<string, any>,
  guidelines: string,
  hook?: HookServer,
) {
  const plugin = join(root, ".agents", "plugins", "codebit");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(plugin, "rules"), { recursive: true });
  writeFileSync(
    join(plugin, "plugin.json"),
    JSON.stringify({ name: "codebit" }),
  );
  const servers: Record<string, any> = {};
  for (const [name, s] of Object.entries(mcp))
    servers[name.replace(/^codebit_/, "")] = s.command
      ? { command: s.command, args: s.args || [], env: s.env || {} }
      : { url: s.url };
  writeFileSync(
    join(plugin, "mcp_config.json"),
    JSON.stringify({ mcpServers: servers }, null, 2),
  );
  // The added folder is listed first in the workspace, and the agent took
  // it for the work folder.
  writeFileSync(
    join(plugin, "rules", "AGENTS.md"),
    `${codebitInstructions(mcp, guidelines)}\n\nA pasta de trabalho desta conversa é ${task.cwd}. A pasta ${root} só guarda a configuração do Codebit para o Antigravity: não crie, leia nem altere arquivos nela.\n`,
  );
  if (!hook?.command) return;
  // Hooks run through cmd /c in the plugin folder; quoted paths break there,
  // so the script is relative and the paths come from the environment.
  writeFileSync(
    join(plugin, "hook.cmd"),
    [
      "@echo off",
      "set ELECTRON_RUN_AS_NODE=1",
      '"%CODEBIT_HOOK_NODE%" "%CODEBIT_HOOK_SCRIPT%" hook',
      "",
    ].join("\r\n"),
  );
  writeFileSync(
    join(plugin, "hooks.json"),
    JSON.stringify(
      {
        codebit: {
          PreToolUse: [
            {
              matcher: matchers[task.mode],
              // The user can take a while to answer.
              hooks: [
                { type: "command", command: ".\\hook.cmd", timeout: 86400 },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
}
// What a tool step shows in the chat.
function describe(name: string, p: any = {}) {
  if (name === "run_command") return `Terminal · ${p.CommandLine ?? ""}`;
  if (name === "call_mcp_tool") return `${p.ServerName} · ${p.ToolName}`;
  const detail = [
    p.Path,
    p.Query,
    p.Url,
    p.SearchPath,
    p.Pattern,
    p.toolSummary,
  ].find((v) => typeof v === "string" && v);
  return detail ? `${name} · ${detail}` : name;
}
// Antigravity CLI (agy) in headless mode: one NDJSON message per turn on
// stdin, steps and a result per turn on stdout. Each turn is its own
// process, resumed with --conversation.
export class AntigravitySession implements AgentSession {
  private channel: Channel;
  private conversation = "";
  private seen = new Set<number>();
  private reply = "";
  private used = 0;
  private planFile = "";
  private asks = new Map<string, (d: HookDecision) => void>();
  private sequence = 0;
  private failure = "";
  private receivedResult = false;
  // The turn's last step was the agent's answer, with text: it finished.
  private answered = false;
  private answerStep = -1;
  private answerText = "";
  private gated: boolean;
  private closed = false;
  constructor(
    i: Installation,
    private task: Task,
    mcp: Record<string, any>,
    private emit: (event: AgentEvent) => void,
    guidelines = "",
    private inspect: InspectCommand | undefined,
    private host: AntigravityHost,
  ) {
    const hook = host.hook;
    this.gated = !!hook?.command;
    writePlugin(host.dir, task, mcp, guidelines, hook);
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--add-dir",
      host.dir,
    ];
    // Headless mode cannot ask the user: it denies commands and MCP tools,
    // and an agent planning gave up when it could not list the folder. So
    // the CLI's own permissions are off and Codebit's hook asks instead.
    // Without the hook, the CLI's denials stand outside Bypass.
    if (task.mode === "plan") args.push("--mode", "plan");
    if (task.mode === "execute" && !this.gated)
      args.push("--mode", "accept-edits");
    if (task.mode === "bypass" || this.gated)
      args.push("--dangerously-skip-permissions");
    if (task.nativeId) args.push("--conversation", task.nativeId);
    if (task.model) args.push("--model", task.model);
    if (task.effort) args.push("--effort", task.effort);
    this.channel = new Channel(
      {
        ...i,
        env: {
          ...i.env,
          ...(hook?.command
            ? {
                CODEBIT_HOOK_NODE: hook.command,
                CODEBIT_HOOK_SCRIPT: hook.args?.[0] ?? "",
                CODEBIT_HOOK_URL: hook.env?.CODEBIT_TOOL_URL ?? "",
                CODEBIT_HOOK_TOKEN: hook.env?.CODEBIT_TOOL_TOKEN ?? "",
              }
            : {}),
        },
      },
      args,
      task.cwd,
      "claude",
      (msg) => this.receive(msg),
      (e) => {
        // A result owns the turn's outcome, including its error. The CLI
        // can exit while finish waits for the short reason on stderr.
        if (!this.receivedResult)
          emit({ type: "error", text: this.failure || e.message });
      },
    );
    // A failed turn ends with the reason on stderr.
    this.channel.child.stderr.on("data", (chunk) => {
      const m = /AGY_ERROR: (\{.*\})/.exec(String(chunk));
      try {
        if (m) this.failure = JSON.parse(m[1]).short_error || this.failure;
      } catch {}
    });
  }
  private receive(msg: any) {
    if (msg.event === "init") {
      this.conversation = msg.conversation_id || "";
      if (this.conversation && this.conversation !== this.task.nativeId)
        this.emit({ type: "native", id: this.conversation });
      return;
    }
    if (msg.event === "step_update") this.step(msg.step_update || {});
    if (msg.event === "result") {
      this.receivedResult = true;
      void this.finish(msg.result || {});
    }
  }
  private step(u: any) {
    if (u.step_type === "agent_response") {
      if (u.step_index !== this.answerStep) {
        this.answerStep = u.step_index;
        this.answerText = "";
      }
      if (u.text_delta) {
        this.reply += u.text_delta;
        this.answerText += u.text_delta;
        this.emit({ type: "text", text: u.text_delta });
      }
      if (u.state === "DONE") this.answered = !!this.answerText.trim();
      // The latest call's input and output is what the context holds now.
      if (u.usage)
        this.used = (u.usage.input_tokens || 0) + (u.usage.output_tokens || 0);
      return;
    }
    // An error step (a failed model call, retried or not) or a tool means
    // the turn went on after the last answer.
    if (u.step_type === "tool" || u.step_type === "error_message")
      this.answered = false;
    if (u.step_type !== "tool" || typeof u.step_index !== "number") return;
    const name: string = u.tool_name || u.tool_info?.name || "";
    const p = u.tool_info?.parameters || {};
    const id = String(u.step_index);
    if (!this.seen.has(u.step_index)) {
      this.seen.add(u.step_index);
      this.emit({
        type: "activity",
        id,
        text: describe(name, p),
        key: `${name} ${JSON.stringify({ ...p, toolSummary: undefined, WaitMsBeforeAsync: undefined })}`,
        files:
          editTools.includes(name) && typeof p.Path === "string"
            ? [p.Path]
            : undefined,
      });
    }
    if (u.state === "DONE" || u.state === "ERROR") {
      this.emit({ type: "outcome", ok: u.state === "DONE", id });
      // In plan mode the plan is a .md file in the conversation's folder.
      if (
        u.state === "DONE" &&
        this.task.mode === "plan" &&
        editTools.includes(name) &&
        /\.md$/i.test(p.Path || "") &&
        inside(this.brain(), p.Path)
      )
        this.planFile = resolve(p.Path);
    }
  }
  private brain(conversation = this.conversation) {
    return join(homedir(), ".gemini", "antigravity-cli", "brain", conversation);
  }
  private async finish(r: any) {
    if (this.used) this.emit({ type: "usage", used: this.used });
    // Antigravity CLI 1.4 can end a turn the agent answered with an error
    // it already retried, even one from an earlier turn of the conversation
    // ("API error (attempt 1): UNAVAILABLE (code 503)"). The answer stands.
    if (r.status !== "SUCCESS" && !this.answered) {
      // The reason comes on stderr right after the result.
      await new Promise((ok) => setTimeout(ok, 300));
      this.emit({
        type: "error",
        text:
          r.error ||
          this.failure ||
          `O Antigravity CLI terminou com ${r.status || "erro"}.`,
      });
      return;
    }
    if (this.task.mode === "plan") {
      const text = this.planFile
        ? await readFile(this.planFile, "utf8").catch(() => "")
        : "";
      if (text.trim()) this.emit({ type: "plan", text, path: this.planFile });
      else if (this.reply.trim()) this.emit({ type: "plan", text: this.reply });
    }
    this.emit({ type: "done" });
  }
  // Asked by the hook before a gated tool step runs.
  async hook(input: any): Promise<HookDecision> {
    const name = String(input?.toolCall?.name || "");
    const args = input?.toolCall?.args || {};
    const path =
      typeof args.Path === "string" && args.Path
        ? resolve(this.task.cwd, args.Path)
        : "";
    const allow: HookDecision = { decision: "allow" };
    if (path && inside(this.host.dir, path))
      return {
        decision: "deny",
        reason: `Essa pasta é do Codebit. Trabalhe em ${this.task.cwd}.`,
      };
    const command =
      typeof args.CommandLine === "string" ? args.CommandLine : "";
    // Planning writes only the plan, in the conversation's own folder.
    if (this.task.mode === "plan" && editTools.includes(name)) {
      const artifacts = input?.artifactDirectoryPath;
      const conversation =
        this.conversation ||
        this.task.nativeId ||
        (typeof input?.conversationId === "string" ? input.conversationId : "");
      return !path ||
        (conversation && inside(this.brain(conversation), path)) ||
        (typeof artifacts === "string" && artifacts && inside(artifacts, path))
        ? allow
        : {
            decision: "deny",
            reason:
              "Modo Planejar: não altere arquivos. Escreva o plano e espere a aprovação do usuário.",
          };
    }
    if (this.task.mode === "bypass") {
      // Only commands that delete files from before the conversation stop.
      const blast =
        name === "run_command" && command
          ? await this.inspect?.(command, false).catch(() => undefined)
          : undefined;
      if (!blast) return allow;
      return this.ask(
        {
          kind: "approval",
          title: "Confirmar comando que apaga arquivos?",
          detail: command,
          choices: ["decline", "accept"],
          tool: name,
          blast,
        },
        `O usuário viu o alcance no Codebit (${blast.summary}) e cancelou. Não tente apagar isso por outro caminho: explique o que pretendia e pergunte como seguir.`,
      );
    }
    // Execute and Plan: edits in the task folder and Codebit's own tools go
    // ahead; commands and other tools ask.
    if (editTools.includes(name))
      return !path || inside(this.task.cwd, path)
        ? allow
        : this.ask({
            kind: "approval",
            title: "Permitir alterar arquivo fora da pasta da tarefa?",
            detail: path,
            choices: ["decline", "accept"],
            tool: name,
          });
    if (name === "call_mcp_tool" && internalServers.includes(args.ServerName))
      return allow;
    if (name === "run_command") {
      const blast = await this.inspect?.(command, true).catch(() => undefined);
      return this.ask({
        kind: "approval",
        title: "Permitir Terminal?",
        detail: command,
        choices: ["decline", "accept"],
        tool: name,
        ...(blast ? { blast } : {}),
      });
    }
    return this.ask({
      kind: "approval",
      title:
        name === "call_mcp_tool"
          ? `Permitir ${args.ServerName} · ${args.ToolName}?`
          : `Permitir ${name}?`,
      detail: JSON.stringify(
        name === "call_mcp_tool" ? (args.Arguments ?? {}) : args,
        null,
        2,
      ),
      choices: ["decline", "accept"],
      tool: name,
    });
  }
  private ask(
    request: Omit<RequestPrompt, "id">,
    declined = "Ação recusada pelo usuário no Codebit.",
  ) {
    const id = `agy-${++this.sequence}`;
    return new Promise<HookDecision>((done) => {
      this.asks.set(id, (d) =>
        done(
          d.decision === "deny" && !d.reason ? { ...d, reason: declined } : d,
        ),
      );
      this.emit({ type: "request", request: { id, ...request } });
    });
  }
  async send(text: string, attachments: string[]) {
    this.reply = "";
    this.planFile = "";
    this.receivedResult = false;
    this.answered = false;
    // It takes only text: attachments go as paths it can open.
    const content = [
      text,
      ...attachments.map((path) =>
        imageTypes.includes(extname(path).toLowerCase())
          ? `Imagem anexada pelo usuário: ${path}. Abra o arquivo para vê-la; para editá-la com codebit_images, use esse caminho.`
          : `Arquivo anexado pelo usuário: ${path}`,
      ),
    ].join("\n\n");
    this.channel.send({ event: "user", message: { content } });
  }
  respond(id: string, value: any) {
    const answer = this.asks.get(id);
    if (!answer) throw new Error("Esta solicitação não está mais ativa.");
    this.asks.delete(id);
    answer(
      value?.decision === "accept"
        ? { decision: "allow" }
        : { decision: "deny", reason: value?.message || undefined },
    );
  }
  async models(): Promise<Model[]> {
    return [];
  }
  // There is no way to cancel a turn: the process ends, and the next
  // message resumes the conversation.
  async interrupt() {
    this.close();
    this.channel.child.kill();
  }
  close() {
    for (const answer of this.asks.values())
      answer({
        decision: "deny",
        reason: "A sessão foi encerrada no Codebit.",
      });
    this.asks.clear();
    if (this.closed) return;
    this.closed = true;
    this.channel.close();
    // The plugin goes once the CLI is gone; leftovers go when Codebit starts.
    const cleanup = () => {
      this.host.release?.();
      try {
        rmSync(this.host.dir, { recursive: true, force: true });
      } catch {}
    };
    const child = this.channel.child;
    if (child.exitCode !== null || child.signalCode) cleanup();
    else child.once("close", cleanup);
  }
}
