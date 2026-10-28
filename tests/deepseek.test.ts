import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  deepseekModels,
  parseDeepseekModels,
} from "../src/main/agents/deepseek-api";
import {
  DeepseekSession,
  deepseekMcp,
  prepareDeepseekHome,
} from "../src/main/agents/deepseek";
import {
  defaultImages,
  type AgentEvent,
  type Installation,
  type Task,
} from "../src/shared/types";
import { Runtime } from "../src/main/runtime";
import { Store } from "../src/main/store";
import { SecretVault } from "../src/main/secrets";
import { executable } from "../src/main/discovery";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const catalog = {
  data: [
    {
      id: "deepseek-flash",
      name: "DeepSeek V4.1 Flash 1017",
      context_window: 1048576,
      effort: {
        supported_levels: ["low", "high", "max"],
        default_level: "high",
      },
    },
    {
      id: "future-model",
      name: "Novo modelo",
      effort: { supported_levels: ["medium"] },
    },
  ],
};
const fixtureKey = "fixture-key-for-tests-only";
const installation: Installation = {
  agent: "deepseek",
  path: process.execPath,
  command: process.execPath,
  args: [resolve("tests/fixtures/deepseek.mjs")],
  version: "test",
  env: { DEEPSEEK_API_KEY: fixtureKey },
};
async function temp() {
  await mkdir(resolve(".codebit-test"), { recursive: true });
  return mkdtemp(resolve(".codebit-test/deepseek-"));
}
async function setup(
  mode: Task["mode"] = "execute",
  nativeId?: string,
  inspect?: any,
) {
  const root = await temp();
  const task: Task = {
    id: "dsh-test",
    projectId: "",
    title: "DeepSeek",
    cwd: root,
    agent: "deepseek",
    model: "future-model",
    effort: "medium",
    mode,
    status: "idle",
    worktree: false,
    archived: false,
    createdAt: "",
    updatedAt: "",
    images: defaultImages,
    nativeId,
  };
  const events: AgentEvent[] = [];
  const session = new DeepseekSession(
    installation,
    task,
    { external: { url: "https://example.test/mcp" } },
    (e) => events.push(e),
    "",
    inspect,
    join(root, "home"),
  );
  cleanups.push(() => session.close());
  return { session, events, root };
}
async function done(events: AgentEvent[]) {
  await vi.waitFor(
    () => expect(events.some((e) => e.type === "done")).toBe(true),
    { timeout: 5000 },
  );
  expect(events.filter((e) => e.type === "error")).toEqual([]);
}
function answer(events: AgentEvent[]) {
  return JSON.parse(
    events
      .filter((e) => e.type === "text")
      .map((e) => e.type === "text" && e.text)
      .join(""),
  );
}
it("lê todos os modelos e suas capacidades, incluindo modelos futuros", async () => {
  const request = vi.fn().mockResolvedValue(Response.json(catalog));
  const models = await deepseekModels(fixtureKey, undefined, request);
  expect(request).toHaveBeenCalledWith(
    "https://api.deepseek.com/models",
    expect.objectContaining({
      redirect: "error",
      headers: { Authorization: `Bearer ${fixtureKey}` },
    }),
  );
  expect(models[0]).toMatchObject({
    id: "deepseek-flash",
    name: "DeepSeek V4.1 Flash 1017",
    contextWindow: 1048576,
    efforts: ["low", "high", "max"],
    defaultEffort: "high",
  });
  expect(models[1].id).toBe("future-model");
  expect(
    parseDeepseekModels({
      data: [{ id: "minimal" }, { id: "minimal" }, { id: null }],
    }),
  ).toHaveLength(1);
});
it.each([401, 403, 429, 500])(
  "trata HTTP %s sem expor o corpo ou a chave",
  async (status) => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response(fixtureKey, { status }));
    await expect(
      deepseekModels(fixtureKey, undefined, request),
    ).rejects.toThrow(`HTTP ${status}`);
    await deepseekModels(fixtureKey, undefined, request).catch((e) =>
      expect(e.message).not.toContain(fixtureKey),
    );
  },
);
it("rejeita ausência de chave, catálogo vazio ou inválido sem lista estática", async () => {
  const request = vi.fn();
  await expect(deepseekModels("", undefined, request)).rejects.toThrow(
    "DEEPSEEK_API_KEY",
  );
  expect(request).not.toHaveBeenCalled();
  expect(() => parseDeepseekModels({ data: [] })).toThrow(
    "não retornou modelos",
  );
  expect(() => parseDeepseekModels({ unexpected: true })).toThrow(
    "catálogo inválido",
  );
  await expect(
    deepseekModels(
      fixtureKey,
      undefined,
      vi.fn().mockResolvedValue(new Response("not json")),
    ),
  ).rejects.toThrow("catálogo inválido");
});
it("descobre o launcher npm do Harness com runtime separado", async () => {
  const root = await temp();
  const script = join(root, "node_modules/@deepseek-ai/dsh/lib/bin.js");
  await mkdir(join(root, "node_modules/@deepseek-ai/dsh/lib"), {
    recursive: true,
  });
  await writeFile(script, "");
  vi.stubEnv("CODEBIT_DSH_NODE_PATH", process.execPath);
  expect(executable(join(root, "dsh.cmd"))).toEqual({
    command: process.execPath,
    args: [script],
  });
});
it("retoma sem replay, seleciona modelo/esforço e envia imagem e MCP HTTP", async () => {
  const { session, events, root } = await setup("execute", "dsh-session");
  const image = join(root, "image.png");
  await writeFile(image, "fake-image");
  await session.send("HELLO", [image]);
  await done(events);
  expect(answer(events)).toMatchObject({
    resumed: true,
    model: '["deepseek-official","future-model"]',
    reasoning_effort: "medium",
    images: 1,
    servers: [
      {
        name: "external",
        type: "http",
        url: "https://example.test/mcp",
        headers: [],
      },
    ],
  });
  expect(events).toContainEqual({ type: "usage", used: 123, size: 1048576 });
  expect(
    await readFile(join(root, "home/codebit.patch.yml"), "utf8"),
  ).not.toContain(fixtureKey);
});
it("Executar aguarda aprovação com os argumentos da chamada correlacionada", async () => {
  const { session, events } = await setup();
  await session.send("APPROVE", []);
  await vi.waitFor(() =>
    expect(events.some((e) => e.type === "request")).toBe(true),
  );
  expect(events.some((e) => e.type === "done")).toBe(false);
  const request = events.find((e) => e.type === "request")!;
  if (request.type !== "request") throw new Error("request");
  expect(request.request.detail).toContain("Remove-Item old.txt");
  session.respond(request.request.id, { decision: "accept" });
  await done(events);
  expect(answer(events).decision).toBe("allow");
});
it.each(["plan", "bypass"] as const)(
  "%s decide a ferramenta conforme o modo",
  async (mode) => {
    const { session, events } = await setup(mode);
    await session.send("APPROVE", []);
    await done(events);
    expect(answer(events).decision).toBe(mode === "plan" ? "reject" : "allow");
    expect(events.some((e) => e.type === "request")).toBe(false);
  },
);
it("Bypass mantém a confirmação de exclusão e recusa chamadas desconhecidas", async () => {
  const inspect = vi.fn().mockResolvedValue({
    command: "Remove-Item old.txt",
    paths: [],
    warnings: [],
  });
  const { session, events } = await setup("bypass", undefined, inspect);
  await session.send("APPROVE", []);
  await vi.waitFor(() =>
    expect(events.some((e) => e.type === "request")).toBe(true),
  );
  expect(inspect).toHaveBeenCalledWith("Remove-Item old.txt", false);
  session.respond("permission", { decision: "decline" });
  await done(events);
  const other = await setup("bypass");
  await other.session.send("UNKNOWN APPROVE", []);
  await done(other.events);
  expect(answer(other.events).decision).toBe("reject");
});
it("interrompe um turno sem encerrar o protocolo", async () => {
  const { session, events } = await setup();
  await session.send("HOLD", []);
  await session.interrupt();
  await done(events);
});
it("a política é aplicada nas ferramentas e atualiza o modo de sessões retomadas", async () => {
  const home = await temp();
  prepareDeepseekHome(home, "deepseek-flash", "plan");
  const plugin = await import(
    pathToFileURL(join(home, "codebit-policy.mjs")).href
  );
  const handlers = new Map<string, any>();
  let guard: any;
  const set = vi.fn();
  vi.stubEnv("CODEBIT_DSH_MODE", "plan");
  plugin.apply({
    tools: {
      guard: (fn: any) => {
        guard = fn;
      },
    },
    permissionPresets: { set },
    on: (name: string, fn: any) => handlers.set(name, fn),
  });
  expect(guard({ name: "read" })).toBeUndefined();
  expect(
    guard({ name: "str_replace_editor", arguments: { command: "view" } }),
  ).toBeUndefined();
  expect(guard({ name: "write" })).toContain("Planejar");
  expect(guard({ name: "mcp__external__delete" })).toContain("Planejar");
  const pre = handlers.get("tools/pre-execute");
  expect(
    await pre({ name: "pwsh" }, async () => ({ kind: "allow" })),
  ).toMatchObject({ kind: "deny" });
  await handlers.get("agent/pre-step")(
    { agent: { session: "resumed" }, signal: new AbortController().signal },
    async () => ({ kind: "allow" }),
  );
  expect(set).toHaveBeenCalledWith("resumed", "codebit-plan");
});
it("MCP stdio usa caminho absoluto e HTTP mantém headers", () => {
  expect(
    deepseekMcp({ local: { command: process.execPath, args: ["mcp.js"] } })[0],
  ).toMatchObject({ command: process.execPath });
  expect(
    deepseekMcp({
      remote: {
        url: "https://example.test/mcp",
        headers: { Authorization: "test" },
      },
    })[0],
  ).toMatchObject({
    type: "http",
    headers: [{ name: "Authorization", value: "test" }],
  });
});
it("runtime carrega catálogo com a chave do cofre sem expô-la no agente", async () => {
  const root = await temp();
  const store = new Store(root);
  const rt = new Runtime(
    store,
    () => {},
    () => undefined,
  );
  cleanups.push(() => {
    rt.close();
    store.close();
  });
  rt.secrets = new SecretVault(store, {
    encrypt: (value) => value,
    decrypt: (value) => value,
  });
  rt.secrets.save({ name: "DEEPSEEK_API_KEY", value: fixtureKey });
  rt.agents = [
    {
      id: "deepseek",
      name: "DeepSeek",
      models: [],
      auth: "unknown",
      installations: [installation],
      selected: { ...installation, env: undefined },
    },
  ];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(catalog)));
  await rt.auth("deepseek");
  expect(rt.agents[0]).toMatchObject({
    auth: "ready",
    catalogStatus: "ready",
    models: [{ id: "deepseek-flash" }, { id: "future-model" }],
  });
  expect(JSON.stringify(rt.agents[0].selected)).not.toContain(fixtureKey);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
  );
  await rt.auth("deepseek");
  expect(rt.agents[0]).toMatchObject({
    auth: "error",
    catalogStatus: "error",
    models: [],
  });
  let finishOld!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValue(Response.json({ data: [{ id: "new-key-model" }] })),
  );
  const stale = rt.auth("deepseek");
  rt.deepseekKeyChanged();
  await rt.auth("deepseek");
  finishOld(Response.json(catalog));
  await stale;
  expect(rt.agents[0].models.map((m) => m.id)).toEqual(["new-key-model"]);
});
