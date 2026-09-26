import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
const dialect = process.argv[2];
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8uoAAAAASUVORK5CYII=";
let started = false;
let pending = "";
let imageThread = false;
let threadParams = {};
let responseText = "Olá, ação concluída.";
let userMessages = 0;
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
// Markers in the prompt: MODE reports permission settings, ECHO returns the
// prompt, GUIDE returns the system instructions, SLOW delays the answer, HOLD
// never answers. BACKGROUND leaves work running after the turn, which ends
// later; BGWAIT leaves it running; COUNT reports the messages this process got.
// EDIT reports an edit of src/shared.ts with the CLI's own edit tool;
// FAILTURN ends the Codex turn with an error; EXITPLAN makes Claude ask to
// leave plan mode.
const respondTo = (text, mode) => {
  if (text.includes("MODE")) responseText = JSON.stringify(mode);
  if (text.includes("ECHO")) responseText = text;
  return text.includes("SLOW") ? 200 : 30;
};
// Version checks get no recognizable version unless a test sets one.
if (process.argv[3] === "--version") {
  process.stdout.write(process.env.CODEBIT_FIXTURE_VERSION ?? "fixture");
  process.exit(0);
}
if (dialect === "devin" && process.argv[3] === "models") {
  out({
    families: [
      {
        variants: [
          {
            model_uid: "swe-2-high",
            label: "SWE-2 High",
            cost_tier: "Free",
            max_context_tokens: 262000,
          },
        ],
      },
    ],
  });
  process.exit(0);
}
if (dialect === "devin" && process.argv[3] === "auth") {
  process.stdout.write(
    [
      "Logged in (via Devin).",
      "",
      "Account:",
      "  Tier:              Devin Pro",
      "  Plan:              Pro",
      "",
    ].join("\n"),
  );
  process.exit(0);
}
if (dialect === "devin" && process.argv[3] === "skills") {
  process.stdout.write(
    [
      "Available Skills",
      "",
      "  /revisar [user] (~/skills/revisar) - Revisa o código",
      "  interna [model] () - Só para o modelo",
      "",
    ].join("\n"),
  );
  process.exit(0);
}
const devin = { mode: "accept-edits", model: "swe-2-high", prompt: null };
const devinModels = [
  { id: "model", options: [{ value: "swe-2-high", name: "SWE-2 High" }] },
];
const devinFinish = () => {
  devinUpdate({ sessionUpdate: "usage_update", used: 900, size: 262000 });
  out({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "native-devin",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: responseText },
      },
    },
  });
  out({ jsonrpc: "2.0", id: devin.prompt, result: { stopReason: "end_turn" } });
};
const devinUpdate = (update) =>
  out({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "native-devin", update },
  });
const finish = () => {
  if (dialect === "codex") {
    out({
      method: "item/agentMessage/delta",
      params: { delta: responseText },
    });
    out({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: { last: { totalTokens: 1200 }, modelContextWindow: 200000 },
      },
    });
    out({
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed" } },
    });
  } else {
    out({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: responseText },
      },
    });
    out({
      type: "assistant",
      message: {
        content: [],
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 1000,
          output_tokens: 90,
        },
      },
    });
    out({
      type: "result",
      is_error: false,
      modelUsage: {
        "other-model": { contextWindow: 1000 },
        "test-model": { contextWindow: 500000 },
      },
    });
  }
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (dialect === "devin") {
    const reply = (result) => out({ jsonrpc: "2.0", id: m.id, result });
    if (m.method === "initialize")
      reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    if (m.method === "session/new") {
      reply({ sessionId: "native-devin", configOptions: devinModels });
      devinUpdate({
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "compact", description: "Compacta", input: { hint: "" } },
        ],
      });
    }
    if (m.method === "session/load") {
      devinUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "REPLAY" },
      });
      reply({ configOptions: devinModels });
    }
    if (m.method === "session/set_config_option") {
      devin.model = m.params.value;
      reply({ configOptions: devinModels });
    }
    if (m.method === "session/set_mode") {
      devin.mode = m.params.modeId;
      reply({});
    }
    if (m.method === "session/prompt") {
      devin.prompt = m.id;
      const text = m.params.prompt[0].text;
      const delay = respondTo(text, { mode: devin.mode, model: devin.model });
      if (text.includes("EDIT"))
        devinUpdate({
          sessionUpdate: "tool_call",
          title: "Edit src/shared.ts",
          kind: "edit",
          locations: [{ path: "src/shared.ts" }],
        });
      if (text.includes("HOLD")) return;
      if (text.includes("APPROVE"))
        out({
          jsonrpc: "2.0",
          id: 901,
          method: "session/request_permission",
          params: {
            sessionId: "native-devin",
            toolCall: { title: "Ran npm", rawInput: { command: "npm test" } },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          },
        });
      else setTimeout(devinFinish, delay);
    }
    if (m.id === 901 && m.result) {
      devinUpdate({
        sessionUpdate: "tool_call",
        title: "decision:" + m.result.outcome.optionId,
      });
      devinFinish();
    }
    if (m.method === "session/cancel")
      out({
        jsonrpc: "2.0",
        id: devin.prompt,
        result: { stopReason: "cancelled" },
      });
    return;
  }
  if (dialect === "codex") {
    if (m.method === "collision") {
      out({
        id: m.id,
        method: "item/commandExecution/requestApproval",
        params: { command: "test" },
      });
      out({ id: m.id, result: { ok: true } });
    }
    if (m.method === "initialize")
      out({ id: m.id, result: { userAgent: "fake" } });
    if (m.method === "modelProvider/capabilities/read")
      out({
        id: m.id,
        result: {
          namespaceTools: false,
          imageGeneration: true,
          webSearch: false,
        },
      });
    if (m.method === "thread/start" && m.params.ephemeral) imageThread = true;
    if (imageThread && m.method === "turn/start") {
      out({ id: m.id, result: { turn: { id: "turn-1" } } });
      const text = m.params.input[0].text;
      const image = m.params.input.find((i) => i.type === "localImage");
      if (text.includes("HOLD")) return;
      const item = {
        type: "imageGeneration",
        id: "image-1",
        status: "completed",
        revisedPrompt: text,
        // Edits echo the reference so tests can verify it was sent.
        result: image ? readFileSync(image.path).toString("base64") : png,
        failure: text.includes("LIMIT")
          ? { type: "usageLimitExceeded", limitId: "images", resetsAt: null }
          : null,
      };
      if (!text.includes("NOIMAGE")) {
        out({
          method: "item/started",
          params: { item: { ...item, status: "in_progress", result: "" } },
        });
        out({ method: "item/completed", params: { item } });
      }
      out({
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      return;
    }
    if (m.method === "thread/start" || m.method === "thread/resume")
      threadParams = m.params;
    if (m.method === "thread/start" || m.method === "thread/resume")
      out({
        id: m.id,
        result: { thread: { id: m.params.threadId || "native-codex" } },
      });
    if (m.method === "account/rateLimits/read")
      out({
        id: m.id,
        result: {
          rateLimits: {
            primary: {
              usedPercent: 42,
              windowDurationMins: 300,
              resetsAt: 1790000000,
            },
            secondary: {
              usedPercent: 99,
              windowDurationMins: 10080,
              resetsAt: 1790500000,
            },
            planType: "pro",
            credits: { hasCredits: true, unlimited: false, balance: "12" },
          },
        },
      });
    if (m.method === "skills/list")
      out({
        id: m.id,
        result: {
          data: [
            {
              cwd: m.params.cwds[0],
              errors: [],
              skills: [
                {
                  name: "revisar",
                  description: "Revisa o código",
                  path: "C:/skills/revisar/SKILL.md",
                  enabled: true,
                },
                {
                  name: "desligada",
                  description: "",
                  path: "x",
                  enabled: false,
                },
              ],
            },
          ],
        },
      });
    if (m.method === "model/list")
      out({
        id: m.id,
        result: {
          data: [
            {
              model: "test-model",
              displayName: "Test model",
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "medium" },
                { reasoningEffort: "high" },
              ],
            },
          ],
          nextCursor: null,
        },
      });
    if (m.method === "turn/start") {
      out({ id: m.id, result: { turn: { id: "turn-1" } } });
      out({ method: "turn/started", params: { turn: { id: "turn-1" } } });
      const text = m.params.input[0].text;
      if (text.includes("OPTIONS"))
        responseText = JSON.stringify({
          model: m.params.model,
          effort: m.params.effort || null,
        });
      const delay = respondTo(text, {
        sandbox: threadParams.sandbox,
        approvalPolicy: threadParams.approvalPolicy,
      });
      if (text.includes("GUIDE"))
        responseText = threadParams.developerInstructions;
      if (text.includes("BACKGROUND")) {
        const item = {
          type: "commandExecution",
          id: "bg-cmd",
          command: "npm run dev",
        };
        out({
          method: "item/started",
          params: { item: { ...item, status: "inProgress" } },
        });
        setTimeout(() => {
          out({
            method: "item/completed",
            params: { item: { ...item, status: "completed" } },
          });
        }, 300);
      }
      // A sub-agent thread whose turn ends before the main one.
      if (text.includes("CHILD"))
        for (const method of [
          "turn/started",
          "item/agentMessage/delta",
          "turn/completed",
        ])
          out({
            method,
            params: {
              threadId: "child-1",
              turn: { id: "turn-child" },
              delta: "FILHO",
            },
          });
      if (text.includes("SKILLS"))
        responseText = JSON.stringify(
          m.params.input.filter((i) => i.type === "skill"),
        );
      if (text.includes("EDIT"))
        out({
          method: "item/started",
          params: {
            item: {
              type: "fileChange",
              id: "edit-1",
              changes: [{ path: "src/shared.ts", kind: "update" }],
            },
          },
        });
      if (text.includes("FAILTURN")) {
        out({
          method: "turn/completed",
          params: {
            turn: { id: "turn-1", error: { message: "Falha simulada." } },
          },
        });
        return;
      }
      if (text.includes("HOLD")) return;
      if (text.includes("IMAGE"))
        out({
          method: "item/completed",
          params: {
            item: {
              type: "imageGeneration",
              status: "completed",
              revisedPrompt: "um raio verde",
              result: png,
              failure: null,
            },
          },
        });
      if (text.includes("LIMITS"))
        out({
          method: "account/rateLimits/updated",
          params: {
            rateLimits: {
              primary: null,
              secondary: { usedPercent: 100, windowDurationMins: 10080 },
            },
          },
        });
      if (text.includes("TWO")) {
        for (const delta of ["um", "dois"]) {
          out({
            method: "item/started",
            params: { item: { type: "agentMessage" } },
          });
          out({ method: "item/agentMessage/delta", params: { delta } });
        }
        out({
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "completed" } },
        });
        return;
      }
      if (text.includes("ELICIT"))
        out({
          id: 900,
          method: "mcpServer/elicitation/request",
          params: {
            serverName: "codebit_agents",
            mode: "form",
            _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} },
            message:
              'Allow the codebit_agents MCP server to run tool "run_subagents"?',
            requestedSchema: { type: "object", properties: {} },
          },
        });
      else if (text.includes("APPROVE")) {
        out({
          id: 900,
          method: "item/commandExecution/requestApproval",
          params: { command: "npm test", cwd: process.cwd() },
        });
        pending = "approve";
      } else setTimeout(finish, delay);
    }
    if (m.id === 900 && m.result) {
      out({
        method: "item/started",
        params: {
          item: {
            type: "commandExecution",
            command: "decision:" + (m.result.decision ?? m.result.action),
          },
        },
      });
      finish();
    }
    if (m.method === "turn/interrupt") out({ id: m.id, result: {} });
    // A steered message joins the turn in progress, which then completes.
    if (m.method === "turn/steer") {
      out({ id: m.id, result: { turnId: m.params.expectedTurnId } });
      responseText = "steer:" + m.params.input[0].text;
      setTimeout(finish, 30);
    }
  } else {
    if (m.type === "control_request") {
      const r = m.request;
      out({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: m.request_id,
          response:
            r.subtype === "initialize"
              ? {
                  models: [
                    {
                      value: "test-model",
                      displayName: "Test model",
                      supportsEffort: true,
                      supportedEffortLevels: ["low", "medium", "high"],
                    },
                  ],
                  commands: [
                    {
                      name: "revisar",
                      description: "Revisa o código",
                      argumentHint: "[arquivo]",
                    },
                  ],
                }
              : {},
        },
      });
    }
    if (m.type === "user") {
      out({
        type: "system",
        subtype: "init",
        session_id: "native-claude",
        model: "test-model",
      });
      const text = m.message.content[0].text;
      userMessages++;
      if (text.includes("COUNT")) responseText = `mensagens:${userMessages}`;
      const flag = (name) =>
        process.argv.includes(name)
          ? process.argv[process.argv.indexOf(name) + 1]
          : null;
      if (text.includes("OPTIONS"))
        responseText = JSON.stringify({
          model: flag("--model"),
          effort: flag("--effort"),
        });
      const delay = respondTo(text, {
        permissionMode: flag("--permission-mode"),
        dangerous: process.argv.includes(
          "--allow-dangerously-skip-permissions",
        ),
      });
      if (text.includes("GUIDE")) responseText = flag("--append-system-prompt");
      if (text.includes("BACKGROUND") || text.includes("BGWAIT")) {
        out({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "bg-1", task_type: "local_agent" }],
        });
        out({
          type: "assistant",
          parent_tool_use_id: "toolu-sub",
          message: {
            content: [
              { type: "text", text: "SUBAGENT" },
              { type: "tool_use", name: "Bash", input: { command: "sleep 1" } },
            ],
          },
        });
        responseText = "iniciado";
        setTimeout(finish, 20);
        // When the work ends, Claude starts a turn on its own to report it.
        if (text.includes("BACKGROUND"))
          setTimeout(() => {
            out({
              type: "system",
              subtype: "background_tasks_changed",
              tasks: [],
            });
            out({
              type: "system",
              subtype: "init",
              session_id: "native-claude",
              model: "test-model",
            });
            responseText = "concluído em segundo plano";
            finish();
          }, 300);
        return;
      }
      if (text.includes("EDIT"))
        out({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Edit",
                input: { file_path: "src/shared.ts" },
              },
            ],
          },
        });
      if (text.includes("HOLD")) return;
      // Local command: answers without calling the model.
      if (text === "/usage") {
        out({
          type: "result",
          is_error: false,
          result: [
            "Current session: 27% used · resets Sep 25, 7:29pm (America/Sao_Paulo)",
            "Current week (all models): 40% used · resets Sep 26, 10:59pm (America/Sao_Paulo)",
            "Current week (Fable): 0% used · resets Sep 26, 11pm (America/Sao_Paulo)",
          ].join("\n"),
        });
        return;
      }
      if (text.includes("LIMITS"))
        out({
          type: "rate_limit_event",
          rate_limit_info: {
            unifiedWindows: {
              five_hour: { utilization: 0.5, resetsAt: 1790375400 },
              seven_day: { utilization: 0.41, resetsAt: 1790474400 },
            },
          },
        });
      if (text.includes("QUESTION")) {
        out({
          type: "control_request",
          request_id: "question-1",
          request: {
            subtype: "can_use_tool",
            tool_name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Qual opção?",
                  options: [{ label: "A" }, { label: "B" }],
                },
              ],
            },
          },
        });
      } else if (text.includes("APPROVE") || text.includes("EXITPLAN")) {
        out({
          type: "control_request",
          request_id: text.includes("EXITPLAN") ? "exitplan-1" : "approval-1",
          request: {
            subtype: "can_use_tool",
            tool_name: text.includes("EXITPLAN") ? "ExitPlanMode" : "Bash",
            input: { command: "npm test" },
          },
        });
      } else setTimeout(finish, delay);
    }
    // Refusing to leave plan mode: its message becomes the answer.
    if (m.type === "control_response") {
      if (m.response.request_id === "exitplan-1")
        responseText = m.response.response.message;
      finish();
    }
  }
});
