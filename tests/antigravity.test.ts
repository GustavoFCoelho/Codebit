import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  AntigravitySession,
  writePlugin,
  type HookDecision,
  type HookServer,
} from "../src/main/agents/antigravity";
import { antigravityModels, probeModels } from "../src/main/agents/catalog";
import { answerHook } from "../src/main/agy-hook";
import { ImageBridge } from "../src/main/bridge";
import { checkAuth, discover } from "../src/main/discovery";
import { mcpFor, nativeMcp } from "../src/main/extensions";
import { LoopGuard } from "../src/main/guard";
import * as processes from "../src/main/process";
import { Runtime } from "../src/main/runtime";
import { Store } from "../src/main/store";
import {
  defaultImages,
  type AgentEvent,
  type AgentInfo,
  type BlastPreview,
  type InspectCommand,
  type Installation,
  type RequestPrompt,
  type Task,
  type TaskMode,
} from "../src/shared/types";

const conversation = "81519a41-d90e-44ed-8751-6896089148c7";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});
async function temp() {
  const base = resolve(tmpdir());
  const root = await mkdtemp(join(base, "codebit-antigravity-"));
  cleanups.push(async () => {
    const path = relative(base, resolve(root));
    if (isAbsolute(path) || !path.startsWith("codebit-antigravity-"))
      throw new Error("Limpeza fora da pasta temporária dos testes");
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 1,
      retryDelay: 100,
    });
  });
  return root;
}
async function isolatedHome() {
  const home = await temp();
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("CODEX_HOME", join(home, ".codex"));
  vi.stubEnv("CODEBIT_AGY_TEST_HOME", home);
  // Check Node's actual home before creating anything under .gemini.
  expect(resolve(homedir())).toBe(home);
  return home;
}
function task(cwd: string, mode: TaskMode = "execute"): Task {
  return {
    id: "task-agy",
    projectId: "project",
    title: "Teste do Antigravity",
    cwd,
    agent: "antigravity",
    model: "",
    mode,
    worktree: false,
    status: "idle",
    archived: false,
    createdAt: "",
    updatedAt: "",
    images: defaultImages,
  };
}
function installation(flags: string[] = []): Installation {
  return {
    agent: "antigravity",
    path: process.execPath,
    command: process.execPath,
    args: [resolve("tests/fixtures/agent.mjs"), "antigravity", ...flags],
    version: "test",
  };
}
function agentInfo(flags: string[] = []): AgentInfo {
  const selected = installation(flags);
  return {
    id: "antigravity",
    name: "Antigravity CLI",
    installations: [selected],
    selected,
    models: [],
    auth: "unknown",
  };
}
const hookServer: HookServer = {
  command: "C:\\Codebit Test\\node.exe",
  args: ["C:\\Codebit Test\\image-mcp.cjs", "hook"],
  env: {
    CODEBIT_TOOL_URL: "http://127.0.0.1:12345/hook",
    CODEBIT_TOOL_TOKEN: "fixture-hook-token",
  },
};
async function createSession(
  options: {
    mode?: TaskMode;
    hook?: boolean;
    inspect?: InspectCommand;
    task?: Partial<Task>;
  } = {},
) {
  const root = await temp();
  const cwd = join(root, "projeto com espaços");
  await mkdir(cwd);
  const currentTask = { ...task(cwd, options.mode), ...options.task };
  const trace = join(root, "agy-trace.json");
  const release = vi.fn();
  const host = {
    dir: join(root, "plugin do Codebit"),
    hook: options.hook ? hookServer : undefined,
    release,
  };
  const events: AgentEvent[] = [];
  const session = new AntigravitySession(
    { ...installation(), env: { CODEBIT_AGY_TRACE: trace } },
    currentTask,
    {},
    (event) => events.push(event),
    "",
    options.inspect,
    host,
  );
  cleanups.push(async () => {
    session.close();
    await vi.waitFor(() => expect(existsSync(host.dir)).toBe(false), {
      timeout: 5000,
    });
  });
  return { session, events, host, task: currentTask, root, trace, release };
}
function call(name: string, args: Record<string, unknown> = {}, extra = {}) {
  return {
    toolCall: { name, args },
    conversationId: conversation,
    workspacePaths: [],
    ...extra,
  };
}
function requests(events: AgentEvent[]): RequestPrompt[] {
  return events.filter((e) => e.type === "request").map((e) => e.request);
}
async function approve(
  context: Awaited<ReturnType<typeof createSession>>,
  input: ReturnType<typeof call>,
  decision: "accept" | "decline" = "accept",
  message?: string,
) {
  const count = requests(context.events).length;
  const pending = context.session.hook(input);
  await vi.waitFor(() =>
    expect(requests(context.events)).toHaveLength(count + 1),
  );
  const request = requests(context.events)[count];
  context.session.respond(request.id, { decision, message });
  return { request, decision: await pending };
}
async function completed(
  context: Awaited<ReturnType<typeof createSession>>,
  text: string,
  attachments: string[] = [],
) {
  await context.session.send(text, attachments);
  await vi.waitFor(
    () => expect(context.events).toContainEqual({ type: "done" }),
    { timeout: 5000 },
  );
  expect(context.events.filter((e) => e.type === "error")).toEqual([]);
}
function reply(events: AgentEvent[]) {
  return events
    .filter((e) => e.type === "text")
    .map((e) => e.text)
    .join("");
}
const blast: BlastPreview = {
  summary: "2 arquivos anteriores à conversa",
  files: 2,
  dirs: 0,
  bytes: 48,
  entries: [{ path: "original.ts", bytes: 24, dir: false }],
  more: 0,
  outside: false,
};

describe("Antigravity: catálogo e descoberta", () => {
  const models = [
    {
      id: "gemini-4-argon-medium",
      name: "Gemini 4 Argon (Medium)",
      verified: true,
      efforts: [],
    },
    {
      id: "claude-opus-5-5-low",
      name: "Claude Opus 5.5 (Low)",
      verified: true,
      efforts: [],
    },
  ];
  it("lê id e nome com TAB, ignora o preâmbulo e remove CRLF", () => {
    expect(
      antigravityModels(
        [
          "Fetching available models...",
          "gemini-4-argon-medium\tGemini 4 Argon (Medium)",
          "claude-opus-5-5-low\tClaude Opus 5.5 (Low)",
          "",
        ].join("\r\n"),
      ),
    ).toMatchObject(models);
    expect(antigravityModels("Fetching available models...\r\n")).toEqual([]);
  });
  it("consulta agy models sem abrir uma conversa", async () => {
    expect(await probeModels(installation(), await temp())).toMatchObject(
      models,
    );
    await expect(
      probeModels(installation(["--fixture-models-error"]), await temp()),
    ).rejects.toThrow("Entre com a sua conta Google.");
  });
  it.each([
    { flags: [], auth: "ready" },
    { flags: ["--fixture-models-error"], auth: "missing" },
    { flags: ["--fixture-models-empty"], auth: "missing" },
  ])("autenticação usa models: $auth ($flags)", async ({ flags, auth }) => {
    const checked = await checkAuth(agentInfo(flags));
    expect(checked.auth).toBe(auth);
    expect(checked.authMessage).toContain(
      auth === "ready" ? "Acesso configurado" : "agy",
    );
  });
  it.each(["PATH", "installer"])(
    "descobre o executável agy em %s",
    async (source) => {
      const home = await isolatedHome();
      const local = join(home, "local");
      const bin =
        source === "PATH" ? join(home, "bin") : join(local, "agy", "bin");
      await mkdir(bin, { recursive: true });
      const path = join(bin, process.platform === "win32" ? "agy.exe" : "agy");
      await writeFile(path, "fixture: não executar");
      vi.stubEnv("PATH", source === "PATH" ? bin : "");
      vi.stubEnv("LOCALAPPDATA", local);
      vi.stubEnv("APPDATA", join(home, "roaming"));
      const capture = vi.spyOn(processes, "capture").mockResolvedValue({
        code: 0,
        stdout: "agy 1.2.3",
        stderr: "",
        truncated: false,
      });
      const store = new Store(join(home, "data"));
      cleanups.push(() => store.close());
      const found = (await discover(store.settings())).find(
        (a) => a.id === "antigravity",
      )!;
      expect(found.name).toBe("Antigravity CLI");
      expect(found.selected).toMatchObject({
        agent: "antigravity",
        path,
        command: path,
        args: [],
        version: "1.2.3",
      });
      expect(capture).toHaveBeenCalledWith(path, ["--version"]);
    },
  );
});

describe("Antigravity: plugin da sessão", () => {
  it("grava o manifesto, servidores sem codebit_ e regras com a pasta da tarefa", async () => {
    const root = join(await temp(), "plugin");
    const cwd = join(await temp(), "tarefa");
    const mcp = {
      codebit_images: {
        command: "node",
        args: ["images.cjs"],
        env: { CODEBIT_TOOLS: "images" },
      },
      codebit_probe: { url: "http://127.0.0.1:12345/mcp", type: "http" },
      local: { command: "probe" },
    };
    writePlugin(root, task(cwd), mcp, "  Preserve a paleta do projeto.  ");
    const plugin = join(root, ".agents", "plugins", "codebit");
    expect(
      JSON.parse(await readFile(join(plugin, "plugin.json"), "utf8")),
    ).toEqual({ name: "codebit" });
    expect(
      JSON.parse(await readFile(join(plugin, "mcp_config.json"), "utf8")),
    ).toEqual({
      mcpServers: {
        images: mcp.codebit_images,
        probe: { url: mcp.codebit_probe.url },
        local: { command: "probe", args: [], env: {} },
      },
    });
    const rules = await readFile(join(plugin, "rules", "AGENTS.md"), "utf8");
    expect(rules).toContain(
      "Você está no Codebit. Responda em português do Brasil.",
    );
    expect(rules).toContain("Use o MCP codebit_images");
    expect(rules).not.toContain("depois de duas tentativas");
    expect(rules).toContain(
      "Diretrizes do usuário para este workspace:\nPreserve a paleta do projeto.",
    );
    expect(rules).toContain(`A pasta de trabalho desta conversa é ${cwd}.`);
    expect(rules).toContain(
      `A pasta ${root} só guarda a configuração do Codebit`,
    );
  });
  it.each(["plan", "execute", "bypass"] as const)(
    "%s: registra os matchers e o hook relativo com variáveis de ambiente",
    async (mode) => {
      const root = join(await temp(), "plugin com espaços");
      writePlugin(root, task(await temp(), mode), {}, "", hookServer);
      const plugin = join(root, ".agents", "plugins", "codebit");
      const hooks = JSON.parse(
        await readFile(join(plugin, "hooks.json"), "utf8"),
      );
      const [entry] = hooks.codebit.PreToolUse;
      expect(entry.matcher).toBe(
        mode === "bypass"
          ? "run_command|write_file|edit_file"
          : "run_command|send_command_input|call_mcp_tool|write_file|edit_file|.*browser.*",
      );
      expect(entry.hooks).toEqual([
        { type: "command", command: ".\\hook.cmd", timeout: 86400 },
      ]);
      const cmd = await readFile(join(plugin, "hook.cmd"), "utf8");
      expect(cmd).toContain("set ELECTRON_RUN_AS_NODE=1\r\n");
      expect(cmd).toContain(
        '"%CODEBIT_HOOK_NODE%" "%CODEBIT_HOOK_SCRIPT%" hook\r\n',
      );
      expect(cmd).not.toContain(hookServer.command);
    },
  );
  it.each([undefined, {}] as (HookServer | undefined)[])(
    "omite os arquivos do hook quando não há comando (%j), inclusive ao regravar",
    async (hook) => {
      const root = join(await temp(), "plugin");
      const currentTask = task(await temp());
      writePlugin(root, currentTask, {}, "", hookServer);
      writePlugin(root, currentTask, {}, "", hook);
      const plugin = join(root, ".agents", "plugins", "codebit");
      expect(existsSync(join(plugin, "hook.cmd"))).toBe(false);
      expect(existsSync(join(plugin, "hooks.json"))).toBe(false);
      expect(existsSync(join(plugin, "plugin.json"))).toBe(true);
    },
  );
});

describe("AntigravitySession: decisões do hook", () => {
  it.each(["plan", "execute", "bypass"] as const)(
    "%s: protege a configuração do Codebit antes de qualquer aprovação",
    async (mode) => {
      const inspect = vi.fn<InspectCommand>().mockResolvedValue(blast);
      const ctx = await createSession({ mode, inspect });
      for (const name of ["write_file", "edit_file"])
        for (const Path of [
          join(
            ctx.host.dir,
            ".agents",
            "plugins",
            "codebit",
            "rules",
            "AGENTS.md",
          ),
          relative(ctx.task.cwd, join(ctx.host.dir, "plugin.json")),
        ]) {
          const decision = await ctx.session.hook(
            call(name, { Path }, { artifactDirectoryPath: ctx.host.dir }),
          );
          expect(decision.decision).toBe("deny");
          expect(decision.reason).toContain(ctx.task.cwd);
        }
      expect(requests(ctx.events)).toEqual([]);
      expect(inspect).not.toHaveBeenCalled();
    },
  );
  it("bypass libera um comando sem alcance e inspeciona sem pedir aprovação", async () => {
    const inspect = vi.fn<InspectCommand>().mockResolvedValue(undefined);
    const ctx = await createSession({ mode: "bypass", inspect });
    expect(
      await ctx.session.hook(call("run_command", { CommandLine: "npm test" })),
    ).toEqual({ decision: "allow" });
    expect(inspect).toHaveBeenCalledWith("npm test", false);
    expect(requests(ctx.events)).toEqual([]);
  });
  it.each(["accept", "decline"] as const)(
    "bypass mostra o alcance e aplica %s",
    async (decision) => {
      const inspect = vi.fn<InspectCommand>().mockResolvedValue(blast);
      const ctx = await createSession({ mode: "bypass", inspect });
      const result = await approve(
        ctx,
        call("run_command", { CommandLine: "rm original.ts" }),
        decision,
      );
      expect(result.request).toMatchObject({
        kind: "approval",
        tool: "run_command",
        detail: "rm original.ts",
        choices: ["decline", "accept"],
        blast,
      });
      expect(inspect).toHaveBeenCalledWith("rm original.ts", false);
      expect(result.decision.decision).toBe(
        decision === "accept" ? "allow" : "deny",
      );
      if (decision === "decline")
        expect(result.decision.reason).toContain(blast.summary);
    },
  );
  it.each([undefined, blast])(
    "execute pede aprovação do terminal e inclui o alcance quando disponível (%j)",
    async (scope) => {
      const inspect = vi.fn<InspectCommand>().mockResolvedValue(scope);
      const ctx = await createSession({ inspect });
      const result = await approve(
        ctx,
        call("run_command", { CommandLine: "npm test" }),
      );
      expect(result.request).toMatchObject({
        kind: "approval",
        tool: "run_command",
        detail: "npm test",
      });
      expect(result.request.blast).toEqual(scope);
      expect(inspect).toHaveBeenCalledWith("npm test", true);
      expect(result.decision).toEqual({ decision: "allow" });
    },
  );
  it("execute libera os MCPs internos e pede aprovação para outro servidor", async () => {
    const ctx = await createSession();
    for (const ServerName of [
      "codebit_images",
      "codebit_agents",
      "codebit_social",
    ])
      expect(
        await ctx.session.hook(
          call("call_mcp_tool", {
            ServerName,
            ToolName: "probe",
            Arguments: {},
          }),
        ),
      ).toEqual({ decision: "allow" });
    expect(requests(ctx.events)).toEqual([]);
    const result = await approve(
      ctx,
      call("call_mcp_tool", {
        ServerName: "codebit_probe",
        ToolName: "probe_echo",
        Arguments: { message: "pitanga" },
      }),
      "decline",
      "Não envie este conteúdo.",
    );
    expect(result.request.title).toContain("codebit_probe · probe_echo");
    expect(JSON.parse(result.request.detail)).toEqual({ message: "pitanga" });
    expect(result.decision).toEqual({
      decision: "deny",
      reason: "Não envie este conteúdo.",
    });
  });
  it.each(["write_file", "edit_file"])(
    "execute libera %s na tarefa e pergunta fora dela, inclusive com ../",
    async (name) => {
      const ctx = await createSession();
      for (const Path of [join(ctx.task.cwd, "src", "a.ts"), "src/a.ts"])
        expect(await ctx.session.hook(call(name, { Path }))).toEqual({
          decision: "allow",
        });
      expect(requests(ctx.events)).toEqual([]);
      for (const Path of [
        join(ctx.task.cwd + "-vizinho", "a.ts"),
        "../fora.ts",
      ]) {
        const result = await approve(ctx, call(name, { Path }), "decline");
        expect(result.request.detail).toBe(resolve(ctx.task.cwd, Path));
        expect(result.decision.decision).toBe("deny");
      }
    },
  );
  it("plan permite somente a conversa em brain ou o diretório de artefatos e nega alterações na tarefa", async () => {
    const home = await isolatedHome();
    const ctx = await createSession({ mode: "plan" });
    const brain = join(
      home,
      ".gemini",
      "antigravity-cli",
      "brain",
      conversation,
    );
    const artifacts = join(ctx.root, "artifacts");
    for (const name of ["write_file", "edit_file"]) {
      for (const Path of [
        join(brain, "implementation_plan.md"),
        join(artifacts, "plan.md"),
      ])
        expect(
          await ctx.session.hook(
            call(name, { Path }, { artifactDirectoryPath: artifacts }),
          ),
        ).toEqual({ decision: "allow" });
      for (const Path of [
        join(ctx.task.cwd, "a.ts"),
        "a.ts",
        join(brain, "..", "outra-conversa", "plan.md"),
        join(artifacts + "-vizinho", "plan.md"),
      ]) {
        const decision = await ctx.session.hook(
          call(name, { Path }, { artifactDirectoryPath: artifacts }),
        );
        expect(decision.decision).toBe("deny");
        expect(decision.reason).toContain("Modo Planejar");
      }
    }
    expect(requests(ctx.events)).toEqual([]);
    const command = await approve(
      ctx,
      call("run_command", { CommandLine: "npm test" }),
    );
    expect(command.request.tool).toBe("run_command");
    expect(command.decision).toEqual({ decision: "allow" });
  });
  it("close nega todos os pedidos pendentes e respond rejeita ids desconhecidos ou já respondidos", async () => {
    const ctx = await createSession();
    expect(() =>
      ctx.session.respond("desconhecido", { decision: "accept" }),
    ).toThrow("não está mais ativa");
    const accepted = await approve(
      ctx,
      call("call_mcp_tool", { ServerName: "codebit_probe", ToolName: "probe" }),
    );
    expect(() =>
      ctx.session.respond(accepted.request.id, { decision: "accept" }),
    ).toThrow("não está mais ativa");
    const pending = [
      ctx.session.hook(call("run_command", { CommandLine: "npm test" })),
      ctx.session.hook(call("edit_file", { Path: "../fora.ts" })),
    ];
    await vi.waitFor(() => expect(requests(ctx.events)).toHaveLength(3));
    ctx.session.close();
    for (const decision of await Promise.all(pending)) {
      expect(decision.decision).toBe("deny");
      expect(decision.reason).toContain("sessão foi encerrada");
    }
    expect(() =>
      ctx.session.respond(requests(ctx.events)[1].id, { decision: "accept" }),
    ).toThrow("não está mais ativa");
  });
});

describe("AntigravitySession: stream-json real", () => {
  it("mapeia init, deltas, ferramentas, arquivos, resultados e o contexto da última resposta", async () => {
    const ctx = await createSession();
    await completed(ctx, "STREAM");
    expect(ctx.events.filter((e) => e.type === "native")).toEqual([
      { type: "native", id: conversation },
    ]);
    expect(ctx.events.filter((e) => e.type === "text")).toEqual([
      { type: "text", text: "PITAN" },
      { type: "text", text: "GA\n" },
    ]);
    const activities = ctx.events.filter((e) => e.type === "activity");
    expect(
      activities.map((e) => ({ id: e.id, text: e.text, files: e.files })),
    ).toEqual([
      { id: "2", text: "Terminal · npm test", files: undefined },
      { id: "3", text: "Terminal · echo oi", files: undefined },
      { id: "4", text: "codebit_probe · probe_echo", files: undefined },
      { id: "6", text: "write_file · src/new.ts", files: ["src/new.ts"] },
      { id: "7", text: "edit_file · src/edited.ts", files: ["src/edited.ts"] },
    ]);
    expect(activities[0].key).toContain("npm test");
    expect(activities[0].key).not.toMatch(/toolSummary|WaitMsBeforeAsync/);
    expect(ctx.events.filter((e) => e.type === "outcome")).toEqual([
      { type: "outcome", id: "2", ok: true },
      { type: "outcome", id: "3", ok: false },
      { type: "outcome", id: "4", ok: true },
      { type: "outcome", id: "6", ok: true },
      { type: "outcome", id: "7", ok: true },
    ]);
    expect(ctx.events.filter((e) => e.type === "usage")).toEqual([
      { type: "usage", used: 7409 },
    ]);
    expect(ctx.events.at(-1)).toEqual({ type: "done" });
  });
  it.each([
    { mode: "plan", hook: false, permissions: ["--mode", "plan"] },
    { mode: "execute", hook: false, permissions: ["--mode", "accept-edits"] },
    {
      mode: "bypass",
      hook: false,
      permissions: ["--dangerously-skip-permissions"],
    },
    {
      mode: "plan",
      hook: true,
      permissions: ["--mode", "plan", "--dangerously-skip-permissions"],
    },
    {
      mode: "execute",
      hook: true,
      permissions: ["--dangerously-skip-permissions"],
    },
    {
      mode: "bypass",
      hook: true,
      permissions: ["--dangerously-skip-permissions"],
    },
  ] as const)(
    "argumentos de $mode, hook=$hook e retomada preservam o protocolo e o modelo",
    async ({ mode, hook, permissions }) => {
      const ctx = await createSession({
        mode,
        hook,
        task: {
          model: "gemini-4-argon-medium",
          nativeId: conversation,
          effort: "high",
        },
      });
      await completed(ctx, "OPTIONS");
      const trace = JSON.parse(await readFile(ctx.trace, "utf8"));
      expect(trace.argv).toEqual([
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--add-dir",
        ctx.host.dir,
        ...permissions,
        "--conversation",
        conversation,
        "--model",
        "gemini-4-argon-medium",
        "--effort",
        "high",
      ]);
      expect(trace.input).toEqual({
        event: "user",
        message: { content: "OPTIONS" },
      });
      expect(ctx.events.filter((e) => e.type === "native")).toEqual([]);
      if (hook)
        expect(trace.hook).toEqual({
          NODE: hookServer.command,
          SCRIPT: hookServer.args![0],
          URL: hookServer.env!.CODEBIT_TOOL_URL,
          TOKEN: hookServer.env!.CODEBIT_TOOL_TOKEN,
        });
    },
  );
  it("envia anexos como caminhos em texto, distinguindo imagens de outros arquivos", async () => {
    const ctx = await createSession();
    const image = join(ctx.root, "referência.PNG");
    const file = join(ctx.root, "dados.txt");
    await completed(ctx, "ECHO confira", [image, file]);
    const input = JSON.parse(await readFile(ctx.trace, "utf8")).input;
    expect(input.event).toBe("user");
    expect(typeof input.message.content).toBe("string");
    expect(input.message.content).toContain(
      `Imagem anexada pelo usuário: ${image}`,
    );
    expect(input.message.content).toContain(
      "para editá-la com codebit_images, use esse caminho.",
    );
    expect(input.message.content).toContain(
      `Arquivo anexado pelo usuário: ${file}`,
    );
    expect(reply(ctx.events)).toBe(input.message.content);
  });
  it("plan publica o arquivo Markdown da conversa com seu texto e caminho", async () => {
    const home = await isolatedHome();
    const ctx = await createSession({ mode: "plan" });
    await completed(ctx, "PLANFILE");
    const path = join(
      home,
      ".gemini",
      "antigravity-cli",
      "brain",
      conversation,
      "implementation_plan.md",
    );
    const text = await readFile(path, "utf8");
    expect(ctx.events.filter((e) => e.type === "plan")).toEqual([
      { type: "plan", text, path },
    ]);
    expect(reply(ctx.events)).toBe("Plano pronto na conversa.");
    expect(ctx.events.findIndex((e) => e.type === "plan")).toBeLessThan(
      ctx.events.findIndex((e) => e.type === "done"),
    );
  });
  it.each(["PLANREPLY", "PLANMISSING", "PLANOUTSIDE"])(
    "plan usa a resposta se não há plano legível na conversa (%s)",
    async (prompt) => {
      await isolatedHome();
      const ctx = await createSession({ mode: "plan" });
      await completed(ctx, prompt);
      expect(ctx.events.filter((e) => e.type === "plan")).toEqual([
        { type: "plan", text: reply(ctx.events) },
      ]);
    },
  );
  it.each([
    { prompt: "FAILTURN", reason: "Falha informada no result." },
    { prompt: "FAILSHORT", reason: "Falha curta do agy." },
  ])(
    "falha com saída 3 usa o motivo correto ($prompt)",
    async ({ prompt, reason }) => {
      const ctx = await createSession();
      await ctx.session.send(prompt, []);
      // finish waits 300 ms for AGY_ERROR on stderr; also observe process exit.
      await vi.waitFor(
        () =>
          expect(ctx.events.filter((e) => e.type === "error")).toContainEqual({
            type: "error",
            text: reason,
          }),
        { timeout: 5000 },
      );
      await new Promise((done) => setTimeout(done, 350));
      expect(ctx.events.filter((e) => e.type === "error")).toEqual([
        { type: "error", text: reason },
      ]);
      expect(ctx.events.some((e) => e.type === "done")).toBe(false);
    },
  );
  // Antigravity CLI 1.4 repeated, at the end of a turn the agent answered,
  // a 503 it had already retried, even in a later turn of the conversation.
  it("um erro já superado no result não derruba um turno respondido", async () => {
    const ctx = await createSession();
    await ctx.session.send("STALEERROR", []);
    await vi.waitFor(
      () => expect(ctx.events).toContainEqual({ type: "done" }),
      { timeout: 5000 },
    );
    // The CLI still exits with code 3 afterwards.
    await new Promise((done) => setTimeout(done, 400));
    expect(ctx.events.filter((e) => e.type === "error")).toEqual([]);
    expect(reply(ctx.events)).toBe("PITANGA\n");
  });
  it("uma falha depois da resposta continua sendo erro", async () => {
    const ctx = await createSession();
    await ctx.session.send("ERRORAFTER", []);
    await vi.waitFor(
      () =>
        expect(ctx.events.filter((e) => e.type === "error")).toHaveLength(1),
      { timeout: 5000 },
    );
    expect(ctx.events.some((e) => e.type === "done")).toBe(false);
  });
  it("interrupt encerra o processo, remove o plugin e libera o host uma única vez", async () => {
    const ctx = await createSession();
    await ctx.session.send("HOLD", []);
    await vi.waitFor(() =>
      expect(ctx.events).toContainEqual({ type: "native", id: conversation }),
    );
    const { pid } = JSON.parse(await readFile(ctx.trace, "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();
    await ctx.session.interrupt();
    await vi.waitFor(() => expect(existsSync(ctx.host.dir)).toBe(false), {
      timeout: 5000,
    });
    expect(() => process.kill(pid, 0)).toThrow();
    ctx.session.close();
    expect(ctx.release).toHaveBeenCalledTimes(1);
    expect(
      ctx.events.some((e) => e.type === "done" || e.type === "error"),
    ).toBe(false);
  });
  it("close remove o plugin depois que o CLI sai e libera o host", async () => {
    const ctx = await createSession();
    await completed(ctx, "olá");
    expect(existsSync(ctx.host.dir)).toBe(true);
    ctx.session.close();
    await vi.waitFor(() => expect(existsSync(ctx.host.dir)).toBe(false), {
      timeout: 5000,
    });
    expect(ctx.release).toHaveBeenCalledTimes(1);
  });
});

async function server(handler: RequestListener) {
  const http = createServer(handler);
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("Servidor sem porta");
  const close = async () => {
    if (!http.listening) return;
    http.closeAllConnections();
    await new Promise<void>((done, fail) =>
      http.close((error) => (error ? fail(error) : done())),
    );
  };
  cleanups.push(close);
  return { url: `http://127.0.0.1:${address.port}/hook`, close };
}
async function invokeHook(
  input: unknown,
  env: NodeJS.ProcessEnv,
): Promise<HookDecision> {
  const body = typeof input === "string" ? input : JSON.stringify(input);
  const writes: string[] = [];
  await answerHook(
    Readable.from([body.slice(0, 7), body.slice(7)]),
    (text) => {
      writes.push(text);
    },
    env,
  );
  expect(writes).toHaveLength(1);
  return JSON.parse(writes[0]);
}
describe("answerHook: transporte HTTP", () => {
  it.each([
    { decision: "allow" },
    { decision: "deny", reason: "O usuário recusou." },
    { decision: "allow", reason: "Autorizado pelo usuário." },
  ])("repassa a decisão e o motivo: %j", async (decision) => {
    const http = await server((_req, res) => res.end(JSON.stringify(decision)));
    expect(
      await invokeHook(call("run_command", { CommandLine: "npm test" }), {
        CODEBIT_HOOK_URL: http.url,
        CODEBIT_HOOK_TOKEN: "fixture-token",
      }),
    ).toEqual(decision);
  });
  it("envia Bearer, preserva CommandLine e encurta textos longos aninhados e arrays", async () => {
    const seen: {
      authorization?: string;
      method?: string;
      contentType?: string;
      body: any;
    }[] = [];
    const http = await server(async (req, res) => {
      let body = "";
      req.setEncoding("utf8");
      for await (const chunk of req) body += chunk;
      seen.push({
        authorization: req.headers.authorization,
        method: req.method,
        contentType: req.headers["content-type"],
        body: JSON.parse(body),
      });
      res.end('{"decision":"allow"}');
    });
    const long = "á".repeat(21000);
    const input = call("run_command", {
      CommandLine: long,
      Content: long,
      Arguments: {
        nested: long,
        small: "ok",
        list: [long, ...Array(204).fill("item")],
        count: 3,
        enabled: true,
        nothing: null,
      },
    });
    expect(
      await invokeHook(input, {
        CODEBIT_HOOK_URL: http.url,
        CODEBIT_HOOK_TOKEN: "fixture-token",
      }),
    ).toEqual({ decision: "allow" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      authorization: "Bearer fixture-token",
      method: "POST",
      contentType: "application/json",
    });
    const args = seen[0].body.toolCall.args;
    expect(args.CommandLine).toBe(long);
    expect(args.Content).toBe(long.slice(0, 20000) + "…");
    expect(args.Arguments).toMatchObject({
      nested: long.slice(0, 20000) + "…",
      small: "ok",
      count: 3,
      enabled: true,
      nothing: null,
    });
    expect(args.Arguments.list).toHaveLength(200);
    expect(args.Arguments.list[0]).toBe(long.slice(0, 20000) + "…");
    expect(args.Arguments.list.slice(1)).toEqual(Array(199).fill("item"));
    expect(seen[0].body.conversationId).toBe(conversation);
  });
  it.each([
    { status: 403, body: '{"error":"credencial revogada"}' },
    { status: 400, body: '{"error":"chamada inválida"}' },
    { status: 200, body: "JSON inválido" },
    { status: 200, body: '{"decision":"maybe"}' },
  ])(
    "nega com prefixo Codebit em resposta inválida ($status, $body)",
    async ({ status, body }) => {
      const http = await server((_req, res) => res.writeHead(status).end(body));
      const decision = await invokeHook(call("run_command"), {
        CODEBIT_HOOK_URL: http.url,
      });
      expect(decision).toMatchObject({
        decision: "deny",
        reason: expect.stringMatching(/^Codebit:/),
      });
      if (status !== 200)
        expect(decision.reason).toContain(JSON.parse(body).error);
    },
  );
  it("nega se o servidor está fora do ar", async () => {
    const http = await server((_req, res) => res.end());
    await http.close();
    expect(
      await invokeHook(call("run_command"), { CODEBIT_HOOK_URL: http.url }),
    ).toMatchObject({
      decision: "deny",
      reason: expect.stringMatching(/^Codebit:/),
    });
  });
  it.each([undefined, "url inválida"])(
    "nega sem CODEBIT_HOOK_URL válida (%j)",
    async (url) => {
      expect(
        await invokeHook(call("run_command"), { CODEBIT_HOOK_URL: url }),
      ).toMatchObject({
        decision: "deny",
        reason: expect.stringMatching(/^Codebit:/),
      });
    },
  );
});

const post = (url: string, token: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
describe("Antigravity: bridge e Runtime", () => {
  it("o tipo hook valida toolCall.name, encaminha a chave da sessão e revoga seu token", async () => {
    const hookTool = vi
      .fn()
      .mockResolvedValue({ decision: "deny", reason: "Teste de recusa." });
    const bridge = new ImageBridge(
      { hookTool } as unknown as Runtime,
      process.execPath,
      "image-mcp.cjs",
    );
    await bridge.start();
    cleanups.push(() => bridge.close());
    const { env } = bridge.config("session-key", "hook");
    const body = call("run_command", { CommandLine: "npm test" });
    const response = await post(
      env.CODEBIT_TOOL_URL,
      env.CODEBIT_TOOL_TOKEN,
      body,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      decision: "deny",
      reason: "Teste de recusa.",
    });
    expect(hookTool).toHaveBeenCalledWith("session-key", body);
    for (const invalid of [
      {},
      { toolCall: {} },
      { toolCall: { name: 42 } },
      { toolCall: null },
    ]) {
      const result = await post(
        env.CODEBIT_TOOL_URL,
        env.CODEBIT_TOOL_TOKEN,
        invalid,
      );
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({
        error: "Chamada de ferramenta inválida.",
      });
    }
    expect(hookTool).toHaveBeenCalledTimes(1);
    bridge.revoke("session-key");
    expect(
      (await post(env.CODEBIT_TOOL_URL, env.CODEBIT_TOOL_TOKEN, body)).status,
    ).toBe(403);
    expect(hookTool).toHaveBeenCalledTimes(1);
  });
  async function runtime() {
    const root = await temp();
    const store = new Store(join(root, "data"));
    const rt = new Runtime(
      store,
      () => {},
      () => undefined,
    );
    const bridge = new ImageBridge(
      rt,
      process.execPath,
      resolve("tests/fixtures/agent.mjs"),
    );
    await bridge.start();
    const hookKeys: string[] = [];
    rt.bridgeConfig = (key, kind, env) => {
      if (kind === "hook") hookKeys.push(key);
      return bridge.config(key, kind, env);
    };
    const revoke = vi.fn((key: string) => bridge.revoke(key));
    rt.revokeBridge = revoke;
    rt.agents = [{ ...agentInfo(), auth: "ready" }];
    cleanups.push(async () => {
      rt.close();
      bridge.close();
      await vi.waitFor(
        async () =>
          expect(
            await readdir(join(store.root, "antigravity")).catch(() => []),
          ).toEqual([]),
        { timeout: 5000 },
      );
      store.close();
    });
    return { rt, store, hookKeys, revoke };
  }
  it("executa um turno ponta a ponta com entradas do assistente, atividades e contexto", async () => {
    const { rt, store, hookKeys, revoke } = await runtime();
    const currentTask = await rt.createTask({
      title: "Antigravity",
      agent: "antigravity",
    });
    rt.updateTask(currentTask.id, { mode: "execute" });
    await rt.send(currentTask.id, "STREAM");
    await vi.waitFor(
      () => expect(rt.task(currentTask.id).status).toBe("idle"),
      { timeout: 5000 },
    );
    const entries = store.entries(currentTask.id);
    expect(
      entries.filter((e) => e.kind === "assistant").map((e) => e.text),
    ).toEqual(["PITANGA\n"]);
    expect(
      entries.filter((e) => e.kind === "activity").map((e) => e.text),
    ).toEqual([
      "Terminal · npm test",
      "Terminal · echo oi",
      "codebit_probe · probe_echo",
      "write_file · src/new.ts",
      "edit_file · src/edited.ts",
    ]);
    expect(entries.filter((e) => e.kind === "error")).toEqual([]);
    expect(rt.task(currentTask.id)).toMatchObject({
      nativeId: conversation,
      context: { used: 7409 },
    });
    expect(hookKeys).toHaveLength(1);
    expect(hookKeys[0]).not.toBe(currentTask.id);
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith(hookKeys[0]));
    expect(existsSync(join(store.root, "antigravity", hookKeys[0]))).toBe(
      false,
    );
    expect(await rt.hookTool(hookKeys[0], call("run_command"))).toMatchObject({
      decision: "deny",
    });
    expect(
      await rt.hookTool("chave-desconhecida", call("run_command")),
    ).toEqual({
      decision: "deny",
      reason: "A sessão foi encerrada no Codebit.",
    });
  });
  it("encaminha o hook da sessão ativa e o revoga ao interromper", async () => {
    const { rt, store, hookKeys, revoke } = await runtime();
    const currentTask = await rt.createTask({
      title: "Ativa",
      agent: "antigravity",
    });
    await rt.send(currentTask.id, "HOLD");
    await vi.waitFor(() =>
      expect(rt.task(currentTask.id).nativeId).toBe(conversation),
    );
    const key = hookKeys[0];
    const plugin = join(store.root, "antigravity", key);
    expect(
      existsSync(join(plugin, ".agents", "plugins", "codebit", "hooks.json")),
    ).toBe(true);
    expect(
      await rt.hookTool(
        key,
        call("write_file", { Path: join(currentTask.cwd, "a.ts") }),
      ),
    ).toEqual({ decision: "allow" });
    expect(
      await rt.hookTool(
        key,
        call("write_file", { Path: join(plugin, "plugin.json") }),
      ),
    ).toMatchObject({ decision: "deny" });
    await rt.interrupt(currentTask.id);
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith(key));
    expect(
      await rt.hookTool(key, call("write_file", { Path: "a.ts" })),
    ).toMatchObject({ decision: "deny" });
    expect(existsSync(plugin)).toBe(false);
  });
  it("done preserva o plano do arquivo do Antigravity em vez de sobrescrevê-lo com a resposta", async () => {
    const home = await isolatedHome();
    const { rt, store } = await runtime();
    const currentTask = await rt.createTask({
      title: "Plano",
      agent: "antigravity",
    });
    rt.updateTask(currentTask.id, { mode: "plan" });
    await rt.send(currentTask.id, "PLANFILE");
    await vi.waitFor(
      () => expect(rt.task(currentTask.id).status).toBe("idle"),
      { timeout: 5000 },
    );
    const path = join(
      home,
      ".gemini",
      "antigravity-cli",
      "brain",
      conversation,
      "implementation_plan.md",
    );
    expect(rt.task(currentTask.id).plan).toMatchObject({
      agent: "antigravity",
      path,
      text: await readFile(path, "utf8"),
    });
    expect(
      store.entries(currentTask.id).find((e) => e.kind === "assistant")?.text,
    ).toBe("Plano pronto na conversa.");
    expect(existsSync(join(store.root, "plans", `${currentTask.id}.md`))).toBe(
      false,
    );
  });
});

describe("Antigravity: extensões e proteção contra repetição", () => {
  it("mcpFor usa {url} para HTTP e preserva stdio, servidores internos e filtros", () => {
    const internal = {
      codebit_images: { command: "node", args: ["images.cjs"], env: {} },
    };
    const config = {
      id: "probe",
      name: "probe",
      agent: "antigravity",
      enabled: true,
      transport: "http",
      url: "http://127.0.0.1:4567/mcp",
    } as const;
    expect(
      mcpFor(
        "antigravity",
        [
          config,
          { ...config, name: "disabled", enabled: false },
          { ...config, name: "claude", agent: "claude" },
          { ...config, name: "shared", agent: "both" },
          {
            ...config,
            name: "stdio",
            transport: "stdio",
            command: "node",
            args: ["probe.cjs"],
            env: { TEST_VAR: "valor de teste" },
          },
        ],
        internal,
      ),
    ).toEqual({
      ...internal,
      codebit_probe: { url: config.url },
      codebit_shared: { url: config.url },
      codebit_stdio: {
        command: "node",
        args: ["probe.cjs"],
        env: { TEST_VAR: "valor de teste" },
      },
    });
  });
  it("nativeMcp lê ~/.gemini/config/mcp_config.json com BOM em uma pasta pessoal temporária", async () => {
    const home = await isolatedHome();
    const folder = join(home, ".gemini", "config");
    const path = join(folder, "mcp_config.json");
    await mkdir(folder, { recursive: true });
    await writeFile(
      path,
      "\uFEFF" +
        JSON.stringify({
          mcpServers: {
            probe: { url: "http://127.0.0.1/mcp" },
            images: { command: "node" },
          },
        }),
    );
    expect(
      (await nativeMcp()).filter((row) => row.agent === "antigravity"),
    ).toEqual([
      { name: "probe", agent: "antigravity", source: path },
      { name: "images", agent: "antigravity", source: path },
    ]);
  });
  it.each([
    "read_file · x",
    "list_dir",
    'read_file {"Path":"x"}',
    "list_dir: x",
  ])("LoopGuard deixa leituras repetirem: %s", (key) => {
    const guard = new LoopGuard({ enabled: true, repeats: 2, failures: 2 });
    for (let i = 0; i < 5; i++)
      expect(guard.action(key, key, false)).toBeUndefined();
  });
  it.each([
    "read_file_extra · x",
    "list_directory · x",
    "run_command npm test",
  ])("LoopGuard exige a fronteira do nome da ferramenta: %s", (key) => {
    const guard = new LoopGuard({ enabled: true, repeats: 2, failures: 2 });
    expect(guard.action(key, key, false)).toBeUndefined();
    expect(guard.action(key, key, false)).toContain("2 vezes");
  });
});
