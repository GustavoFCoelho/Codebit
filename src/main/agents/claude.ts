import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Channel } from "./protocol";
import { nativeModels } from "./models";
import { claudeCommands } from "./catalog";
import { claudeWindows } from "./quota";
import { codebitInstructions } from "../extensions";
import { claudeContext } from "./context";
import { newer } from "../updater";
import type {
  AgentEvent,
  AgentSession,
  InspectCommand,
  Installation,
  Model,
  Task,
} from "../../shared/types";
const editTools = ["Edit", "MultiEdit", "Write", "NotebookEdit"];
// The oldest version known to take --thinking-display.
const thinkingDisplaySince = "2.1.292";
const permissionModes = {
  plan: "plan",
  execute: "manual",
  bypass: "bypassPermissions",
};
export class ClaudeSession implements AgentSession {
  private channel: Channel;
  private ready: Promise<any>;
  private requests = new Map<string, any>();
  // Commands held by the blast radius hook, with what they reach.
  private hooks = new Map<string, { command: string; summary: string }>();
  // Commands the user allowed at that hook: when Claude asks about the same
  // one right after, it goes without a second question.
  private allowed = new Set<string>();
  private textSeen = false;
  private thoughtSeen = false;
  private model = "";
  private used = 0;
  // Messages sent but not yet taken by Claude, which echoes each one it
  // accepts (--replay-user-messages).
  private pending = new Set<string>();
  // Claude reported a background task of an earlier process as stopped.
  private notified = false;
  constructor(
    i: Installation,
    private task: Task,
    mcp: Record<string, any>,
    private emit: (event: AgentEvent) => void,
    private guidelines = "",
    private inspect?: InspectCommand,
  ) {
    const args = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--replay-user-messages",
      "--permission-prompt-tool",
      "stdio",
      "--permission-mode",
      permissionModes[task.mode],
      "--setting-sources",
      "user,project,local",
      "--mcp-config",
      JSON.stringify({ mcpServers: mcp }),
      "--append-system-prompt",
      codebitInstructions(mcp, guidelines),
      // Keep native delegation out of the session; Codebit's own MCP tool is
      // exposed only when the user's per-session setting enables it.
      "--disallowedTools",
      "Agent",
      "Task",
    ];
    if (task.mode === "bypass")
      args.push("--allow-dangerously-skip-permissions");
    // Without it a non-interactive session leaves the thinking text out.
    // Older versions refuse the flag, so they go without thoughts.
    const version = i.version.match(/^\d+\.\d+\.\d+/)?.[0];
    if (version && !newer(thinkingDisplaySince, version))
      args.push("--thinking-display", "summarized");
    if (task.nativeId) args.push(`--resume=${task.nativeId}`);
    if (task.model) args.push("--model", task.model);
    if (task.effort) args.push("--effort", task.effort);
    this.channel = new Channel(
      i,
      args,
      task.cwd,
      "claude",
      (msg) => this.receive(msg),
      (e) => emit({ type: "error", text: e.message }),
    );
    // Commands that delete files from before the conversation stop for the
    // user, even in Bypass: the hook runs before Claude's own permissions.
    // A long timeout, since a hook that
    // times out lets the command through.
    this.ready = this.channel.request("initialize", {
      hooks: inspect
        ? {
            PreToolUse: [
              {
                matcher: "Bash|PowerShell",
                hookCallbackIds: ["codebit-blast"],
                timeout: 86400,
              },
            ],
          }
        : {},
    });
    this.ready.then(
      (r) => emit({ type: "commands", commands: claudeCommands(r.commands) }),
      () => {},
    );
  }
  private receive(msg: any) {
    // Every turn starts with init, including the ones Claude starts on its
    // own to report background work that finished.
    if (msg.type === "system" && msg.subtype === "init") {
      if (msg.session_id) this.emit({ type: "native", id: msg.session_id });
      this.model = msg.model || "";
      this.textSeen = false;
      this.thoughtSeen = false;
      this.emit({ type: "turn" });
    }
    if (msg.type === "user" && msg.isReplay && msg.uuid)
      this.pending.delete(msg.uuid);
    if (msg.type === "system" && msg.subtype === "task_notification")
      this.notified = true;
    if (msg.type === "system" && msg.subtype === "background_tasks_changed")
      this.emit({ type: "background", count: (msg.tasks || []).length });
    // Sub-agent messages share the stream; only their tool use is shown.
    const subagent = !!msg.parent_tool_use_id;
    if (msg.type === "rate_limit_event")
      this.emit({ type: "quota", windows: claudeWindows(msg.rate_limit_info) });
    // The latest API call's input plus output is what the context holds now.
    const usage = msg.type === "assistant" && !subagent && msg.message?.usage;
    if (usage)
      this.used =
        (usage.input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.output_tokens || 0);
    if (msg.type === "stream_event" && !subagent) {
      const e = msg.event;
      if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
        this.textSeen = true;
        this.emit({ type: "text", text: e.delta.text });
      }
      // Claude's thinking, summarized; some blocks come without text.
      if (
        e?.type === "content_block_delta" &&
        e.delta?.type === "thinking_delta" &&
        e.delta.thinking
      ) {
        this.thoughtSeen = true;
        this.emit({ type: "thought", text: e.delta.thinking });
      }
    }
    if (msg.type === "assistant")
      for (const block of msg.message?.content || []) {
        if (block.type === "text" && !this.textSeen && !subagent)
          this.emit({ type: "text", text: block.text });
        if (
          block.type === "thinking" &&
          block.thinking &&
          !this.thoughtSeen &&
          !subagent
        )
          this.emit({ type: "thought", text: block.thinking });
        if (block.type === "tool_use")
          this.emit({
            type: "activity",
            id: block.id,
            text: `${subagent ? "Sub-agente · " : ""}${block.name} · ${block.input?.command || block.input?.file_path || block.input?.url || block.input?.query || block.input?.description || ""}`,
            // Claude writes a new description on each call; the action is
            // the rest of the input.
            key: `${block.name} · ${JSON.stringify({ ...block.input, description: undefined })}`,
            files: editTools.includes(block.name)
              ? [block.input?.file_path || block.input?.notebook_path].filter(
                  Boolean,
                )
              : undefined,
          });
      }
    // Tool results come back as user messages.
    if (msg.type === "user")
      for (const block of msg.message?.content || [])
        if (block.type === "tool_result")
          this.emit({
            type: "outcome",
            ok: !block.is_error,
            id: block.tool_use_id,
          });
    // Resuming a session that stopped abruptly with background work running,
    // Claude first reports that work as stopped in a turn of its own, ending
    // in an empty result before it takes our message. Taken as the end of our
    // turn, it closed the session and the message went unanswered.
    if (msg.type === "result" && this.notified && this.pending.size) {
      this.notified = false;
      this.used = 0;
      return;
    }
    if (msg.type === "result") this.notified = false;
    if (msg.type === "result") {
      const models = Object.entries<any>(msg.modelUsage || {});
      const size =
        models.find(([id]) => id === this.model)?.[1].contextWindow ??
        Math.max(0, ...models.map(([, m]) => m.contextWindow || 0));
      const used = this.used;
      this.used = 0;
      if (msg.is_error) {
        // Local commands such as /context do not call the model.
        if (used) this.emit({ type: "usage", used, size: size || undefined });
        this.emit({
          type: "error",
          text: (msg.errors || [msg.result || "Falha no Claude."]).join("\n"),
        });
      } else
        void this.readContext(used, size).finally(() =>
          this.emit({ type: "done" }),
        );
    }
    if (msg.type === "control_request") {
      const r = msg.request,
        id = msg.request_id;
      if (r.subtype === "hook_callback") {
        void this.guard(id, r.input);
        return;
      }
      if (r.subtype !== "can_use_tool") {
        this.channel.send({
          type: "control_response",
          response: {
            subtype: "error",
            request_id: id,
            error: "Controle não suportado pelo Codebit.",
          },
        });
        return;
      }
      if (this.allowed.delete(r.input?.command)) {
        this.channel.send({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: id,
            response: { behavior: "allow", updatedInput: r.input },
          },
        });
        return;
      }
      this.requests.set(id, r);
      if (r.tool_name === "AskUserQuestion")
        this.emit({
          type: "request",
          request: {
            id,
            kind: "question",
            title: "O agente precisa da sua resposta",
            detail: "",
            questions: (r.input.questions || []).map((q: any) => ({
              id: q.question,
              question: q.question,
              options: q.options?.map((o: any) => o.label),
              multiSelect: q.multiSelect,
            })),
          },
        });
      else if (r.tool_name === "ExitPlanMode") {
        // The plan goes to the side panel as a document; the chat keeps a
        // short approval card instead of the raw tool input.
        this.emit({
          type: "plan",
          text: r.input?.plan ?? "",
          path: r.input?.planFilePath,
        });
        this.emit({
          type: "request",
          request: {
            id,
            kind: "approval",
            title: "Plano pronto para revisão",
            detail: "",
            choices: ["decline", "accept"],
            tool: r.tool_name,
            plan: true,
          },
        });
      } else
        void this.blast(r.input?.command, true).then((blast) =>
          this.emit({
            type: "request",
            request: {
              id,
              kind: "approval",
              title: `Permitir ${r.tool_name}?`,
              detail: JSON.stringify(r.input, null, 2),
              choices: ["decline", "accept"],
              tool: r.tool_name,
              ...(blast ? { blast } : {}),
            },
          }),
        );
    }
  }
  private blast(command: unknown, asking: boolean) {
    return typeof command === "string" && this.inspect
      ? this.inspect(command, asking).catch(() => undefined)
      : Promise.resolve(undefined);
  }
  // A command about to run: on its way unless it deletes files from before
  // the conversation, in which case the user sees what it reaches and decides.
  private async guard(id: string, input: any) {
    const command = input?.tool_input?.command;
    const blast = await this.blast(command, false);
    if (!blast) {
      this.hookAnswer(id, {});
      return;
    }
    this.hooks.set(id, { command, summary: blast.summary });
    this.emit({
      type: "request",
      request: {
        id,
        kind: "approval",
        title: "Confirmar comando que apaga arquivos?",
        detail: command,
        choices: ["decline", "accept"],
        tool: input?.tool_name,
        blast,
      },
    });
  }
  private hookAnswer(id: string, output: any) {
    this.channel.send({
      type: "control_response",
      response: { subtype: "success", request_id: id, response: output },
    });
  }
  async send(text: string, attachments: string[]) {
    await this.ready;
    this.textSeen = false;
    this.allowed.clear();
    const uuid = randomUUID();
    this.pending.add(uuid);
    const content: any[] = [{ type: "text", text }];
    for (const path of attachments) {
      const mime = (
        {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".webp": "image/webp",
          ".gif": "image/gif",
        } as Record<string, string>
      )[extname(path).toLowerCase()];
      if (mime) {
        content.push({
          type: "text",
          text: `Imagem anexada. Identificador para codebit_images.edit_image: ${path}`,
        });
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mime,
            data: (await readFile(path)).toString("base64"),
          },
        });
      } else
        content.push({
          type: "text",
          text: `Arquivo anexado pelo usuário: ${path}`,
        });
    }
    this.channel.send({
      type: "user",
      session_id: this.task.nativeId || "",
      parent_tool_use_id: null,
      uuid,
      message: { role: "user", content },
    });
  }
  respond(id: string, value: any) {
    const held = this.hooks.get(id);
    if (held) {
      this.hooks.delete(id);
      const allow = value.decision === "accept";
      if (allow) this.allowed.add(held.command);
      this.hookAnswer(id, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: allow ? "allow" : "deny",
          permissionDecisionReason: allow
            ? "O usuário viu o alcance no Codebit e permitiu."
            : `O usuário viu o alcance no Codebit (${held.summary}) e cancelou. Não tente apagar isso por outro caminho: explique o que pretendia e pergunte como seguir.`,
        },
      });
      return;
    }
    const r = this.requests.get(id);
    if (!r) throw new Error("Esta solicitação não está mais ativa.");
    const response =
      r.tool_name === "AskUserQuestion"
        ? {
            behavior: "allow",
            updatedInput: {
              ...r.input,
              answers: Object.fromEntries(
                Object.entries(value.answers || {}).map(([key, answer]) => [
                  key,
                  Array.isArray(answer) ? answer.join(", ") : answer,
                ]),
              ),
            },
          }
        : value.decision === "accept"
          ? { behavior: "allow", updatedInput: r.input }
          : {
              behavior: "deny",
              message:
                value.message ||
                (r.tool_name === "ExitPlanMode"
                  ? "O usuário ainda não aprovou o plano. Continue no modo de planejamento e aguarde as orientações dele."
                  : "Ação recusada pelo usuário."),
            };
    this.channel.send({
      type: "control_response",
      response: { subtype: "success", request_id: id, response },
    });
    this.requests.delete(id);
  }
  async models(): Promise<Model[]> {
    const r = await this.ready;
    return nativeModels("claude", r.models || []);
  }
  async setMode(mode: Task["mode"]) {
    await this.ready;
    await this.channel.request("set_permission_mode", {
      mode: permissionModes[mode],
    });
  }
  async interrupt() {
    await this.ready;
    await this.channel.request("interrupt");
  }
  // At the end of an answer, what the context is made of: Claude Code works
  // it out locally, with no call to the model. Versions without the request
  // show only the total from the answer's usage.
  private async readContext(used: number, size: number) {
    let usage: ReturnType<typeof claudeContext>;
    try {
      usage = claudeContext(
        await this.channel.request(
          "get_context_usage",
          { detail: "full" },
          4000,
        ),
      );
    } catch {}
    if (usage?.parts?.length) this.emit({ type: "usage", ...usage });
    else if (used) this.emit({ type: "usage", used, size: size || undefined });
  }
  close() {
    this.channel.close();
  }
}
