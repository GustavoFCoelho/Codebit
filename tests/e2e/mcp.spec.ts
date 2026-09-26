import { test, expect } from "@playwright/test";
import electronPath from "electron";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { resolve, dirname, join } from "node:path";

test("helper MCP: protocolo stdio e ponte de imagem no executável", async () => {
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({
      authorization: req.headers.authorization,
      body: JSON.parse(body),
    });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ content: [{ type: "text", text: "MCP_IMAGE_OK" }] }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const binary =
    process.env.CODEBIT_EXECUTABLE || (electronPath as unknown as string);
  const script = process.env.CODEBIT_EXECUTABLE
    ? join(
        dirname(binary),
        "resources",
        "app.asar",
        "dist",
        "main",
        "image-mcp.cjs",
      )
    : resolve("dist/main/image-mcp.cjs");
  const child = spawn(binary, [script], {
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CODEBIT_TOOL_TOKEN: "test-token",
      CODEBIT_TOOL_URL: `http://127.0.0.1:${(server.address() as any).port}/images`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses: any[] = [];
  let stderr = "";
  createInterface({ input: child.stdout }).on("line", (line) =>
    responses.push(JSON.parse(line)),
  );
  child.stderr.on("data", (data) => (stderr += data));
  let sequence = 0;
  const request = async (method: string, params: any) => {
    const id = ++sequence;
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    await expect
      .poll(() => responses.some((r) => r.id === id), { message: stderr })
      .toBe(true);
    return responses.find((r) => r.id === id).result;
  };
  try {
    expect(
      (await request("initialize", { protocolVersion: "2025-03-26" }))
        .serverInfo.name,
    ).toBe("codebit-images");
    expect(
      (await request("tools/list", {})).tools.map((t: any) => t.name),
    ).toEqual(["generate_image", "edit_image"]);
    expect(
      (
        await request("tools/call", {
          name: "edit_image",
          arguments: { prompt: "Teste", inputImage: "artifact-test" },
        })
      ).content[0].text,
    ).toBe("MCP_IMAGE_OK");
    expect(calls).toEqual([
      {
        authorization: "Bearer test-token",
        body: { prompt: "Teste", inputImage: "artifact-test" },
      },
    ]);
  } finally {
    child.stdin.end();
    child.kill();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
