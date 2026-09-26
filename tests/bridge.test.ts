import { it, expect } from "vitest";
import { ImageBridge } from "../src/main/bridge";
import type { Runtime } from "../src/main/runtime";

const send = (url: string, token: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
it("ponte MCP limita chamadas à tarefa autorizada e revoga a credencial", async () => {
  const calls: any[] = [];
  const runtime = {
    imageTool: async (id: string, args: unknown) => {
      calls.push({ id, args });
      return { content: [{ type: "text", text: "ok" }] };
    },
  } as unknown as Runtime;
  const bridge = new ImageBridge(runtime, process.execPath, "image-mcp.cjs");
  await bridge.start();
  try {
    const { env } = bridge.config("task-a");
    expect(
      (await send(env.CODEBIT_TOOL_URL, "invalid", { prompt: "teste" })).status,
    ).toBe(403);
    expect(
      (
        await send(env.CODEBIT_TOOL_URL, env.CODEBIT_TOOL_TOKEN, {
          prompt: "teste",
        })
      ).status,
    ).toBe(200);
    expect(calls).toEqual([{ id: "task-a", args: { prompt: "teste" } }]);
    bridge.revoke("task-a");
    expect(
      (
        await send(env.CODEBIT_TOOL_URL, env.CODEBIT_TOOL_TOKEN, {
          prompt: "teste",
        })
      ).status,
    ).toBe(403);
    expect(calls).toHaveLength(1);
  } finally {
    bridge.close();
  }
});
it("credencial de sub-agentes só acessa a ferramenta de sub-agentes", async () => {
  const calls: any[] = [];
  const runtime = {
    imageTool: async () => ({ content: [] }),
    subagentTool: async (id: string, args: unknown) => {
      calls.push({ id, args });
      return { content: [{ type: "text", text: "ok" }] };
    },
  } as unknown as Runtime;
  const bridge = new ImageBridge(runtime, process.execPath, "image-mcp.cjs");
  await bridge.start();
  try {
    const images = bridge.config("task-a", "images").env;
    const agents = bridge.config("task-a", "agents").env;
    expect(agents.CODEBIT_TOOLS).toBe("agents");
    const body = { tasks: [{ prompt: "Revise o módulo" }] };
    expect(
      (await send(images.CODEBIT_TOOL_URL, agents.CODEBIT_TOOL_TOKEN, body))
        .status,
    ).toBe(403);
    expect(
      (
        await send(agents.CODEBIT_TOOL_URL, agents.CODEBIT_TOOL_TOKEN, {
          tasks: [],
        })
      ).status,
    ).toBe(400);
    expect(
      (await send(agents.CODEBIT_TOOL_URL, agents.CODEBIT_TOOL_TOKEN, body))
        .status,
    ).toBe(200);
    expect(calls).toEqual([{ id: "task-a", args: body }]);
    // Issuing the agents token must not revoke the images token.
    expect(
      (
        await send(images.CODEBIT_TOOL_URL, images.CODEBIT_TOOL_TOKEN, {
          prompt: "teste",
        })
      ).status,
    ).toBe(200);
  } finally {
    bridge.close();
  }
});
