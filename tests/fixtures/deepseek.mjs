import { createInterface } from "node:readline";
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const update = (update) =>
  send({
    method: "session/update",
    params: { sessionId: "dsh-session", update },
  });
let prompt;
let selection = {};
let resumed = false;
let servers = [];
const finish = (decision = "none") => {
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call",
    status: decision === "reject" ? "failed" : "completed",
  });
  update({
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: JSON.stringify({
        ...selection,
        resumed,
        servers,
        decision,
        images: prompt.params.prompt.filter((p) => p.type === "image").length,
      }),
    },
  });
  update({ sessionUpdate: "usage_update", used: 123, size: 1048576 });
  send({ id: prompt.id, result: { stopReason: "end_turn" } });
};
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  const reply = (result) => send({ id: m.id, result });
  if (m.method === "initialize")
    reply({
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { image: true } },
    });
  else if (["session/new", "session/resume"].includes(m.method)) {
    resumed = m.method === "session/resume";
    servers = m.params.mcpServers;
    reply({
      sessionId: resumed ? m.params.sessionId : "dsh-session",
      configOptions: [],
    });
  } else if (m.method === "session/set_config_option") {
    selection[m.params.configId] = m.params.value;
    reply({});
  } else if (m.method === "session/prompt") {
    prompt = m;
    const text = m.params.prompt[0].text;
    if (text.includes("HOLD")) continue;
    if (text.includes("APPROVE")) {
      if (!text.includes("UNKNOWN"))
        update({
          sessionUpdate: "tool_call",
          toolCallId: "call",
          title: "pwsh",
          kind: "other",
          rawInput: { command: "Remove-Item old.txt" },
        });
      send({
        id: "permission",
        method: "session/request_permission",
        params: {
          toolCall: { toolCallId: "call" },
          options: [
            { optionId: "allow", kind: "allow_once" },
            { optionId: "reject", kind: "reject_once" },
          ],
        },
      });
    } else finish();
  } else if (m.id === "permission" && m.result)
    finish(m.result.outcome.optionId);
  else if (m.method === "session/cancel")
    send({ id: prompt.id, result: { stopReason: "cancelled" } });
  else if (m.id != null)
    send({
      id: m.id,
      error: { code: -32601, message: `Unexpected method ${m.method}` },
    });
}
