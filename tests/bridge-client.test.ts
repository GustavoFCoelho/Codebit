import { createServer, type Server } from "node:http";
import { afterEach, expect, test } from "vitest";
import { postBridge } from "../src/main/bridge-client";

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});
function listen(handler: Parameters<typeof createServer>[1]) {
  server = createServer(handler);
  return new Promise<string>((resolve) =>
    server!.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server!.address() as any).port}/images`),
    ),
  );
}

test("posts with the token and returns the answer", async () => {
  let seen: any;
  const url = await listen(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    seen = { auth: req.headers.authorization, body, method: req.method };
    res.end(JSON.stringify({ content: [{ type: "text", text: "pronto" }] }));
  });
  const r = await postBridge(url, "abc", '{"prompt":"x"}', 5000);
  expect(r).toEqual({
    ok: true,
    data: { content: [{ type: "text", text: "pronto" }] },
  });
  expect(seen).toEqual({
    auth: "Bearer abc",
    body: '{"prompt":"x"}',
    method: "POST",
  });
});

test("reports refusals and empty answers as not ok", async () => {
  const url = await listen((req, res) => {
    if (req.url === "/images") res.writeHead(403).end();
    else res.writeHead(400).end(JSON.stringify({ error: "inválido" }));
  });
  expect(await postBridge(url, "abc", "{}", 5000)).toEqual({
    ok: false,
    data: {},
  });
  expect(
    await postBridge(url.replace("/images", "/agents"), "abc", "{}", 5000),
  ).toEqual({ ok: false, data: { error: "inválido" } });
});

// fetch stops waiting for an answer after 5 minutes whatever its signal
// says; the limit here is the caller's.
test("waits up to its own limit", async () => {
  const url = await listen((_req, res) => setTimeout(() => res.end("{}"), 300));
  expect(await postBridge(url, "abc", "{}", 5000)).toEqual({
    ok: true,
    data: {},
  });
  await expect(postBridge(url, "abc", "{}", 100)).rejects.toThrow(
    "O Codebit não respondeu a tempo.",
  );
});
