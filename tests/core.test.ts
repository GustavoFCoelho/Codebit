import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/main/store";
import { JsonLines, Channel } from "../src/main/agents/protocol";
import { bindWorkflow, sdxlPreset, validateWorkflow } from "../src/main/images";
import { within, createWorktree, changes } from "../src/main/workspace";
import { capture } from "../src/main/process";
import { CodexSession } from "../src/main/agents/codex";
import { ClaudeSession } from "../src/main/agents/claude";
import { DevinSession } from "../src/main/agents/devin";
import { Runtime } from "../src/main/runtime";
import { parseClaudeUsage } from "../src/main/agents/quota";
import {
  appVersion,
  defaultGuidelines,
  defaultImages,
  type AgentEvent,
  type AgentId,
  type AgentSession,
  type Task,
} from "../src/shared/types";
const sessions = {
  codex: CodexSession,
  claude: ClaudeSession,
  devin: DevinSession,
};
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function temp() {
  const base = resolve(tmpdir());
  const path = await mkdtemp(join(base, "codebit-test-"));
  cleanups.push(() => {
    if (!resolve(path).startsWith(join(base, "codebit-test-")))
      throw new Error("Limpeza fora da pasta de testes");
    return rm(path, {
      recursive: true,
      force: true,
      maxRetries: 30,
      retryDelay: 100,
    });
  });
  return path;
}
function task(cwd: string, agent: AgentId): Task {
  return {
    id: "task",
    projectId: "project",
    title: "Teste",
    cwd,
    agent,
    model: "",
    mode: "execute",
    worktree: false,
    status: "idle",
    archived: false,
    createdAt: "",
    updatedAt: "",
    images: defaultImages,
  };
}
function installation(agent: AgentId) {
  return {
    agent,
    path: process.execPath,
    command: process.execPath,
    args: [resolve("tests/fixtures/agent.mjs"), agent],
    version: "test",
  };
}
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condição não atendida");
    await new Promise((r) => setTimeout(r, 20));
  }
}
describe("protocolo dos agentes", () => {
  it("distingue aprovação do servidor de resposta com o mesmo id", async () => {
    const requests: any[] = [];
    const errors: Error[] = [];
    const channel = new Channel(
      installation("codex"),
      [],
      await temp(),
      "codex",
      (m) => requests.push(m),
      (e) => errors.push(e),
    );
    cleanups.push(() => channel.close());
    expect(await channel.request("collision")).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("item/commandExecution/requestApproval");
    expect(errors).toEqual([]);
  });
  it("preserva UTF-8 com JSON dividido entre chunks e isola linhas inválidas", () => {
    const values: any[] = [],
      errors: Error[] = [];
    const parser = new JsonLines(
      (v) => values.push(v),
      (e) => errors.push(e),
    );
    const data = Buffer.from('{"text":"ação"}\r\n{invalid}\n{"ok":true}\n');
    for (const byte of data) parser.push(Buffer.from([byte]));
    expect(values).toEqual([{ text: "ação" }, { ok: true }]);
    expect(errors).toHaveLength(1);
  });
  for (const agent of ["codex", "claude", "devin"] as const)
    it(`${agent}: streaming, catálogo e aprovação explícita`, async () => {
      const events: AgentEvent[] = [];
      const session = new sessions[agent](
        installation(agent),
        task(await temp(), agent),
        {},
        (e) => events.push(e),
      );
      cleanups.push(() => session.close());
      await session.send("APPROVE", []);
      await eventually(() => events.some((e) => e.type === "request"));
      expect(events.some((e) => e.type === "done")).toBe(false);
      expect(await session.models()).toMatchObject([
        agent === "devin"
          ? {
              id: "swe-2-high",
              name: "SWE-2 High",
              verified: true,
              efforts: [],
            }
          : {
              id: "test-model",
              name: "Test model",
              verified: true,
              efforts: ["low", "medium", "high"],
            },
      ]);
      const request = events.find((e) => e.type === "request") as any;
      session.respond(request.request.id, { decision: "decline" });
      await eventually(() => events.some((e) => e.type === "done"));
      expect(
        events
          .filter((e) => e.type === "text")
          .map((e: any) => e.text)
          .join(""),
      ).toBe("Olá, ação concluída.");
    });
  for (const [agent, expected] of [
    ["codex", { sandbox: "danger-full-access", approvalPolicy: "never" }],
    ["claude", { permissionMode: "bypassPermissions", dangerous: true }],
    ["devin", { mode: "bypass", model: "swe-2-high" }],
  ] as const)
    it(`${agent}: modo bypass desliga os pedidos de permissão`, async () => {
      let text = "";
      let done = false;
      const session = new sessions[agent](
        installation(agent),
        { ...task(await temp(), agent), mode: "bypass" },
        {},
        (e) => {
          if (e.type === "text") text += e.text;
          if (e.type === "done") done = true;
        },
      );
      cleanups.push(() => session.close());
      await session.send("MODE", []);
      await eventually(() => done);
      expect(JSON.parse(text)).toEqual(expected);
    });
  it("Codex separa as mensagens de um mesmo turno", async () => {
    let text = "";
    let done = false;
    const session = new CodexSession(
      installation("codex"),
      task(await temp(), "codex"),
      {},
      (e) => {
        if (e.type === "text") text += e.text;
        if (e.type === "done") done = true;
      },
    );
    cleanups.push(() => session.close());
    await session.send("TWO", []);
    await eventually(() => done);
    expect(text).toBe("um\n\ndois");
  });
  it("Codex pede aprovação de ferramentas MCP em vez de cancelá-las", async () => {
    const events: AgentEvent[] = [];
    const session = new CodexSession(
      installation("codex"),
      task(await temp(), "codex"),
      {},
      (e) => events.push(e),
    );
    cleanups.push(() => session.close());
    await session.send("ELICIT", []);
    await eventually(() => events.some((e) => e.type === "request"));
    const request = events.find((e) => e.type === "request") as any;
    expect(request.request.detail).toContain("run_subagents");
    session.respond(request.request.id, { decision: "accept" });
    await eventually(() => events.some((e) => e.type === "done"));
    expect(events).toContainEqual({
      type: "activity",
      text: "Terminal · decision:accept",
    });
  });
  it("Devin retoma a sessão sem repetir o histórico na conversa", async () => {
    let text = "";
    let done = false;
    const session = new DevinSession(
      installation("devin"),
      { ...task(await temp(), "devin"), nativeId: "native-devin" },
      {},
      (e) => {
        if (e.type === "text") text += e.text;
        if (e.type === "done") done = true;
      },
    );
    cleanups.push(() => session.close());
    await session.send("MODE", []);
    await eventually(() => done);
    expect(text).not.toContain("REPLAY");
    expect(JSON.parse(text).mode).toBe("accept-edits");
  });
  it("Claude encaminha perguntas e aceita uma resposta", async () => {
    const events: AgentEvent[] = [];
    const session = new ClaudeSession(
      installation("claude"),
      task(await temp(), "claude"),
      {},
      (e) => events.push(e),
    );
    cleanups.push(() => session.close());
    await session.send("QUESTION", []);
    await eventually(() => events.some((e) => e.type === "request"));
    const request = events.find((e) => e.type === "request") as any;
    expect(request.request.kind).toBe("question");
    session.respond(request.request.id, { answers: { "Qual opção?": "B" } });
    await eventually(() => events.some((e) => e.type === "done"));
  });
  // Devin has no system prompt; ECHO returns the first prompt, which carries it.
  for (const [agent, marker] of [
    ["codex", "GUIDE"],
    ["claude", "GUIDE"],
    ["devin", "ECHO"],
  ] as const)
    it(`${agent}: recebe as diretrizes do usuário`, async () => {
      let text = "";
      let done = false;
      const session = new sessions[agent](
        installation(agent),
        task(await temp(), agent),
        {},
        (e) => {
          if (e.type === "text") text += e.text;
          if (e.type === "done") done = true;
        },
        "Atualize CLIs desatualizados.",
      );
      cleanups.push(() => session.close());
      await session.send(marker, []);
      await eventually(() => done);
      expect(text).toContain(
        "Diretrizes do usuário para este workspace:\nAtualize CLIs desatualizados.",
      );
    });
});
describe("persistência e isolamento", () => {
  it("limita um diff Git grande e mantém a listagem de arquivos", async () => {
    const root = await temp();
    await capture("git", ["init"], root);
    await writeFile(join(root, "large.txt"), "original\n");
    await capture("git", ["add", "large.txt"], root);
    await capture(
      "git",
      [
        "-c",
        "user.name=Codebit Test",
        "-c",
        "user.email=test@localhost",
        "commit",
        "-m",
        "fixture",
      ],
      root,
    );
    await writeFile(join(root, "large.txt"), "conteúdo novo\n".repeat(800_000));
    const preview = await changes(root);
    expect(preview.git).toBe(true);
    expect(preview.truncated).toBe(true);
    expect(Buffer.byteLength(preview.diff)).toBeLessThanOrEqual(512_000);
    expect(preview.diff).toContain("diff --git");
    expect(preview.status).toContain("large.txt");
  });
  it("restaura histórico e marca execuções interrompidas após reiniciar", async () => {
    const root = await temp();
    let store = new Store(root);
    store.put("task", { ...task(root, "codex"), status: "running" });
    store.put("entry", {
      id: "e1",
      taskId: "task",
      kind: "user",
      text: "Olá",
      createdAt: "",
    });
    store.close();
    store = new Store(root);
    expect(store.get<Task>("task", "task").status).toBe("interrupted");
    expect(store.entries("task")[0].text).toBe("Olá");
    store.close();
  });
  it("a versão do app acompanha o package.json", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(appVersion).toBe(pkg.version);
  });
  it("configurações antigas recebem as diretrizes padrão; texto vazio é mantido", async () => {
    const store = new Store(await temp());
    cleanups.push(() => store.close());
    const { guidelines, ...old } = store.settings();
    store.put("settings", { ...old, id: "main" });
    expect(store.settings().guidelines).toBe(defaultGuidelines);
    expect(defaultGuidelines).toContain("desatualizada");
    store.saveSettings({ ...old, guidelines: "" });
    expect(store.settings().guidelines).toBe("");
  });
  it("rejeita leitura fora da pasta do projeto", async () => {
    const root = await temp();
    const inner = join(root, "project");
    await mkdir(inner);
    await writeFile(join(root, "private.txt"), "secret");
    await writeFile(join(inner, "public.txt"), "public");
    expect(await within(inner, "public.txt")).toBe(join(inner, "public.txt"));
    await expect(within(inner, "../private.txt")).rejects.toThrow("fora");
  });
  it("várias conversas do mesmo projeto rodam ao mesmo tempo", async () => {
    const root = await temp();
    const store = new Store(join(root, "data"));
    const rt = new Runtime(
      store,
      () => {},
      () => undefined,
    );
    cleanups.push(() => {
      rt.close();
      store.close();
    });
    rt.agents = [
      {
        id: "codex",
        name: "Codex",
        auth: "ready",
        models: [],
        installations: [installation("codex")],
        selected: installation("codex"),
      },
    ];
    const p = await rt.project(root);
    store.put("project", { ...p, trusted: true });
    const a = await rt.createTask({
        projectId: p.id,
        title: "A",
        agent: "codex",
      }),
      b = await rt.createTask({ projectId: p.id, title: "B", agent: "codex" }),
      c = await rt.createTask({ projectId: p.id, title: "C", agent: "codex" });
    await rt.send(a.id, "HOLD");
    await rt.send(b.id, "HOLD");
    await rt.send(c.id, "ECHO paralelo");
    expect(rt.task(a.id).status).toBe("running");
    expect(rt.task(b.id).status).toBe("running");
    await eventually(() => rt.task(c.id).status === "idle");
    expect(
      rt.store.entries(c.id).find((e) => e.kind === "assistant")?.text,
    ).toContain("paralelo");
    await rt.interrupt(b.id);
    expect(rt.task(a.id).status).toBe("running");
    await rt.interrupt(a.id);
  });
  it("worktree parte do commit e preserva mudanças locais", async () => {
    const root = await temp();
    const repo = join(root, "repo");
    await mkdir(repo);
    await capture("git", ["init"], repo);
    await capture("git", ["config", "user.name", "Codebit Test"], repo);
    await capture("git", ["config", "user.email", "test@localhost"], repo);
    await writeFile(join(repo, "file.txt"), "original");
    await capture("git", ["add", "."], repo);
    await capture("git", ["commit", "-m", "fixture"], repo);
    await writeFile(join(repo, "file.txt"), "local edit");
    const target = join(root, "worktree");
    await createWorktree(repo, target, "12345678-test");
    expect(await readFile(join(target, "file.txt"), "utf8")).toBe("original");
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("local edit");
    expect((await changes(repo)).diff).toContain("local edit");
  });
});
async function runtime(agents: AgentId[]) {
  const root = await temp();
  const store = new Store(join(root, "data"));
  const rt = new Runtime(
    store,
    () => {},
    () => undefined,
  );
  cleanups.push(() => {
    rt.close();
    store.close();
  });
  rt.agents = agents.map((id) => ({
    id,
    name: id,
    auth: "ready",
    models: [],
    installations: [installation(id)],
    selected: installation(id),
  }));
  return rt;
}
const idle = (rt: Runtime, id: string) =>
  eventually(() => rt.task(id).status === "idle");
const lastReply = (rt: Runtime, id: string) =>
  rt.store
    .entries(id)
    .filter((e) => e.kind === "assistant")
    .at(-1)!;
describe("runtime: agentes, conversas e sub-agentes", () => {
  it("novas tarefas começam no modo padrão das configurações, Bypass se vazio", async () => {
    const rt = await runtime(["codex"]);
    const create = () => rt.createTask({ title: "Modo", agent: "codex" });
    expect((await create()).mode).toBe("bypass");
    rt.store.saveSettings({ ...rt.store.settings(), defaultMode: "execute" });
    expect((await create()).mode).toBe("execute");
  });
  it("conversa sem projeto troca de agente e envia só o contexto perdido", async () => {
    const rt = await runtime(["codex", "devin"]);
    const t = await rt.createTask({ title: "Livre", agent: "codex" });
    expect(t.projectId).toBe("");
    expect(t.cwd.startsWith(join(rt.store.root, "scratch"))).toBe(true);
    expect(rt.trusted(t)).toBe(true);
    await rt.send(t.id, "Primeira pergunta");
    await idle(rt, t.id);
    expect(lastReply(rt, t.id).agent).toBe("codex");
    const switched = rt.updateTask(t.id, { agent: "devin" });
    expect(switched).toMatchObject({
      nativeIds: { codex: "native-codex" },
      contextPending: true,
    });
    expect(switched.nativeId).toBeUndefined();
    await rt.send(t.id, "ECHO segunda");
    await idle(rt, t.id);
    const devinReply = lastReply(rt, t.id);
    expect(devinReply.agent).toBe("devin");
    expect(devinReply.text).toContain("Usuário: Primeira pergunta");
    expect(devinReply.text).toContain("Codex: Olá, ação concluída.");
    expect(rt.task(t.id).contextPending).toBe(false);
    const back = rt.updateTask(t.id, { agent: "codex" });
    expect(back.nativeId).toBe("native-codex");
    expect(back.nativeIds?.devin).toBe("native-devin");
    await rt.send(t.id, "ECHO terceira");
    await idle(rt, t.id);
    // Codex already saw the first exchange: its context starts afterwards.
    expect(lastReply(rt, t.id).text).toMatch(
      /atendeu\):\n\nUsuário: ECHO segunda\n\nDevin: /,
    );
  });
  it("sub-agentes respeitam o limite simultâneo e devolvem as respostas", async () => {
    const rt = await runtime(["codex", "devin"]);
    const parent = await rt.createTask({ title: "Pai", agent: "codex" });
    rt.updateTask(parent.id, {
      subagents: {
        enabled: true,
        agent: "devin",
        model: "",
        effort: "",
        max: 2,
      },
    });
    await rt.send(parent.id, "HOLD");
    await eventually(() => rt.task(parent.id).status === "running");
    const result = await rt.subagentTool(parent.id, {
      tasks: [{ prompt: "SLOW 1" }, { prompt: "SLOW 2" }, { prompt: "SLOW 3" }],
    });
    const rows = JSON.parse(result.content[0].text);
    expect(rows.map((r: any) => r.response)).toEqual(
      Array(3).fill("Olá, ação concluída."),
    );
    const log = rt.store
      .entries(parent.id)
      .filter((e) => e.kind === "activity")
      .map((e) => e.text);
    const started = log.flatMap((t, i) => (t.endsWith("iniciado") ? [i] : []));
    const finished = log.findIndex((t) => t.endsWith("concluído"));
    expect(started).toHaveLength(3);
    expect(started[2]).toBeGreaterThan(finished);
    await rt.interrupt(parent.id);
  });
  it("aprovação de sub-agente aparece no chat pai e volta ao sub-agente", async () => {
    const rt = await runtime(["codex", "devin"]);
    const parent = await rt.createTask({ title: "Pai", agent: "codex" });
    rt.updateTask(parent.id, {
      subagents: {
        enabled: true,
        agent: "devin",
        model: "",
        effort: "",
        max: 1,
      },
    });
    await rt.send(parent.id, "HOLD");
    await eventually(() => rt.task(parent.id).status === "running");
    const call = rt.subagentTool(parent.id, { tasks: [{ prompt: "APPROVE" }] });
    await eventually(() =>
      rt.store.entries(parent.id).some((e) => e.kind === "request"),
    );
    expect(rt.task(parent.id).status).toBe("waiting");
    const request = rt.store
      .entries(parent.id)
      .find((e) => e.kind === "request")!;
    rt.respond(parent.id, request.id, { decision: "accept" });
    const rows = JSON.parse((await call).content[0].text);
    expect(rows[0].response).toBe("Olá, ação concluída.");
    expect(
      rt.store
        .entries(parent.id)
        .some((e) => e.text.endsWith("decision:allow")),
    ).toBe(true);
    await rt.interrupt(parent.id);
  });
  it("sub-agentes desligados ou tarefa parada recusam a chamada", async () => {
    const rt = await runtime(["codex", "devin"]);
    const t = await rt.createTask({ title: "Sem", agent: "codex" });
    await expect(
      rt.subagentTool(t.id, { tasks: [{ prompt: "x" }] }),
    ).rejects.toThrow("desligados");
    rt.updateTask(t.id, {
      subagents: {
        enabled: true,
        agent: "devin",
        model: "",
        effort: "",
        max: 1,
      },
    });
    const rows = JSON.parse(
      (await rt.subagentTool(t.id, { tasks: [{ prompt: "x" }] })).content[0]
        .text,
    );
    expect(rows[0].error).toContain("encerrada");
  });
  it("salva imagem colada como anexo da tarefa", async () => {
    const rt = await runtime(["codex"]);
    const t = await rt.createTask({ title: "Anexo", agent: "codex" });
    await expect(
      rt.attachData(t.id, "imagem-colada.png", Buffer.alloc(0)),
    ).rejects.toThrow("20 MB");
    const path = await rt.attachData(
      t.id,
      "imagem-colada.png",
      Buffer.from("png"),
    );
    expect(await readFile(path, "utf8")).toBe("png");
    expect(rt.store.get<any>("attachment", path).taskId).toBe(t.id);
  });
});
describe("trabalho em segundo plano", () => {
  const open = (rt: Runtime, id: string) => (rt as any).sessions.has(id);
  const parked = (rt: Runtime, id: string, count: number) =>
    eventually(
      () => rt.task(id).status === "idle" && rt.task(id).background === count,
    );
  it("Claude: a sessão continua aberta e o agente relata sozinho o que terminou", async () => {
    const rt = await runtime(["claude"]);
    const t = await rt.createTask({ title: "Fundo", agent: "claude" });
    await rt.send(t.id, "BACKGROUND");
    await parked(rt, t.id, 1);
    expect(open(rt, t.id)).toBe(true);
    expect(lastReply(rt, t.id).text).toBe("iniciado");
    // Sub-agent messages share the stream: only their tool use is shown.
    const texts = rt.store.entries(t.id).map((e) => e.text);
    expect(texts).toContain("Sub-agente · Bash · sleep 1");
    expect(texts.some((text) => text.includes("SUBAGENT"))).toBe(false);
    await eventually(
      () => lastReply(rt, t.id).text === "concluído em segundo plano",
    );
    await eventually(() => !open(rt, t.id));
    expect(rt.task(t.id).status).toBe("idle");
    expect(rt.task(t.id).background).toBeUndefined();
  });
  it("Claude: a próxima mensagem vai para a sessão aberta e interromper encerra tudo", async () => {
    const rt = await runtime(["claude"]);
    const t = await rt.createTask({ title: "Fundo", agent: "claude" });
    await rt.send(t.id, "BGWAIT");
    await parked(rt, t.id, 1);
    await rt.send(t.id, "COUNT");
    // A new process would have received only one message.
    await eventually(() => lastReply(rt, t.id).text === "mensagens:2");
    await parked(rt, t.id, 1);
    await rt.interrupt(t.id);
    expect(open(rt, t.id)).toBe(false);
    expect(rt.task(t.id).status).toBe("interrupted");
    expect(rt.task(t.id).background).toBeUndefined();
  });
  it("Codex: um comando que o turno deixou rodando mantém a sessão até terminar", async () => {
    const rt = await runtime(["codex"]);
    rt.quietMs = 50;
    const t = await rt.createTask({ title: "Servidor", agent: "codex" });
    await rt.send(t.id, "BACKGROUND");
    await parked(rt, t.id, 1);
    expect(open(rt, t.id)).toBe(true);
    await eventually(() => !open(rt, t.id));
    expect(rt.task(t.id).status).toBe("idle");
    expect(rt.task(t.id).background).toBeUndefined();
  });
  it("Codex: a thread de um sub-agente não encerra nem preenche a conversa", async () => {
    const rt = await runtime(["codex"]);
    const t = await rt.createTask({ title: "Filho", agent: "codex" });
    await rt.send(t.id, "CHILD");
    await idle(rt, t.id);
    expect(lastReply(rt, t.id).text).toBe("Olá, ação concluída.");
    expect(rt.store.entries(t.id).some((e) => e.text.includes("FILHO"))).toBe(
      false,
    );
  });
  it("trabalho em segundo plano não sobrevive a reiniciar o app", async () => {
    const root = await temp();
    let store = new Store(root);
    store.put("task", { ...task(root, "claude"), background: 2 });
    store.close();
    store = new Store(root);
    cleanups.push(() => store.close());
    expect(store.get<Task>("task", "task")).toMatchObject({
      status: "interrupted",
    });
    expect(store.get<Task>("task", "task").background).toBeUndefined();
  });
});
describe("conversas paralelas e notificações", () => {
  it("avisa as duas conversas quando alteram o mesmo arquivo ao mesmo tempo", async () => {
    const rt = await runtime(["codex", "claude", "devin"]);
    const root = await temp();
    const p = await rt.project(root);
    rt.store.put("project", { ...p, trusted: true });
    const create = (title: string, agent: AgentId) =>
      rt.createTask({ projectId: p.id, title, agent });
    const a = await create("A", "codex"),
      b = await create("B", "claude"),
      c = await create("C", "devin");
    const warnings = (id: string) =>
      rt.store.entries(id).filter((e) => e.kind === "warning");
    // One after the other is not a conflict.
    await rt.send(a.id, "EDIT");
    await idle(rt, a.id);
    await rt.send(b.id, "EDIT");
    await idle(rt, b.id);
    expect(warnings(a.id)).toHaveLength(0);
    expect(warnings(b.id)).toHaveLength(0);
    // A is still working and already changed the file when C changes it.
    await rt.send(a.id, "EDIT HOLD");
    await eventually(
      () =>
        rt.store.entries(a.id).filter((e) => e.kind === "activity").length ===
        2,
    );
    await rt.send(c.id, "EDIT");
    await idle(rt, c.id);
    expect(warnings(c.id)).toHaveLength(1);
    expect(warnings(c.id)[0].text).toMatch(/“A” também alterou src.shared\.ts/);
    expect(warnings(a.id)).toHaveLength(1);
    expect(warnings(a.id)[0].text).toContain("“C” também alterou");
    expect(warnings(b.id)).toHaveLength(0);
    await rt.interrupt(a.id);
  });
  it("pede atenção quando a tarefa termina, falha ou precisa de você", async () => {
    const rt = await runtime(["codex"]);
    const notices: { title: string; body: string; taskId?: string }[] = [];
    rt.attention = (n) => notices.push(n);
    const t = await rt.createTask({ title: "Avisos", agent: "codex" });
    await rt.send(t.id, "SLOW");
    // The queued message keeps the task working: one notice at the end.
    rt.enqueue(t.id, "segunda");
    await eventually(
      () =>
        rt.store.entries(t.id).filter((e) => e.kind === "assistant").length ===
          2 && rt.task(t.id).status === "idle",
    );
    expect(notices).toEqual([
      { title: "Avisos", body: "Codex terminou.", taskId: t.id },
    ]);
    await rt.send(t.id, "APPROVE");
    await eventually(() => rt.task(t.id).status === "waiting");
    expect(notices.at(-1)!.body).toBe("Aguardando você: Permitir execução?");
    await rt.interrupt(t.id);
    const before = notices.length;
    await rt.send(t.id, "FAILTURN");
    await eventually(() => rt.task(t.id).status === "failed");
    expect(notices.slice(before)).toEqual([
      { title: "Avisos", body: "A execução falhou.", taskId: t.id },
    ]);
  });
});
describe("prompts salvos", () => {
  const finished = (rt: Runtime) =>
    eventually(() =>
      rt
        .quickRuns()
        .every((r) => r.status !== "running" && r.status !== "waiting"),
    );
  it("rodam à parte com o agente da tarefa aberta e podem virar conversa", async () => {
    const rt = await runtime(["codex", "claude"]);
    const t = await rt.createTask({ title: "Principal", agent: "claude" });
    await rt.send(t.id, "HOLD");
    const echo = rt.savePrompt({
      name: "Eco",
      text: "ECHO pedido rápido",
      projectId: "",
      mode: "plan",
    });
    const started = await rt.startQuick(echo.id, t.id);
    expect(started).toMatchObject({ agent: "claude", mode: "plan" });
    await finished(rt);
    const done = rt.quickRuns()[0];
    expect(done.status).toBe("done");
    expect(done.reply).toContain("ECHO pedido rápido");
    // The open task keeps working and its chat stays as it was.
    expect(rt.task(t.id).status).toBe("running");
    expect(rt.store.entries(t.id).map((e) => e.text)).toEqual(["HOLD"]);
    // Each prompt runs with its own permission mode.
    const mode = rt.savePrompt({
      name: "Modo",
      text: "MODE",
      projectId: "",
      mode: "bypass",
    });
    await rt.startQuick(mode.id, t.id);
    await finished(rt);
    expect(rt.quickRuns()[0]).toMatchObject({ name: "Modo" });
    expect(rt.quickRuns()[0].reply).toContain("bypassPermissions");
    const kept = await rt.keepQuick(done.id);
    expect(kept).toMatchObject({
      title: "Eco",
      agent: "claude",
      mode: "plan",
      nativeId: "native-claude",
    });
    expect(rt.store.entries(kept.id).map((e) => [e.kind, e.text])).toEqual([
      ["user", "ECHO pedido rápido"],
      ["assistant", done.reply],
    ]);
    expect(rt.quickRuns().map((r) => r.name)).toEqual(["Modo"]);
    await rt.interrupt(t.id);
  });
  it("Claude em só leitura responde sem pedir para sair do planejamento", async () => {
    const rt = await runtime(["claude"]);
    const ask = (mode: "plan" | "execute") =>
      rt.savePrompt({ name: mode, text: "EXITPLAN", projectId: "", mode });
    await rt.startQuick(ask("plan").id);
    await finished(rt);
    expect(rt.quickRuns()[0]).toMatchObject({ status: "done" });
    expect(rt.quickRuns()[0].reply).toContain("só de leitura");
    // With permission to execute, leaving plan mode is up to the user.
    await rt.startQuick(ask("execute").id);
    await eventually(() => rt.quickRuns()[0].status === "waiting");
    expect(rt.quickRuns()[0].request?.tool).toBe("ExitPlanMode");
    await rt.stopQuick(rt.quickRuns()[0].id);
  });
  it("aprovação no painel, confiança no projeto e exclusão", async () => {
    const rt = await runtime(["codex"]);
    const approve = rt.savePrompt({
      name: "Testes",
      text: "APPROVE",
      projectId: "",
      mode: "execute",
    });
    const started = await rt.startQuick(approve.id);
    expect(started.agent).toBe("codex");
    await eventually(() => rt.quickRuns()[0].status === "waiting");
    rt.respondQuick(started.id, { decision: "accept" });
    await finished(rt);
    expect(rt.quickRuns()[0].activity).toContain("Terminal · decision:accept");
    const p = await rt.project(await temp());
    const local = rt.savePrompt({
      name: "Local",
      text: "Olá",
      projectId: p.id,
      mode: "plan",
    });
    await expect(rt.startQuick(local.id)).rejects.toThrow("Confie no projeto");
    rt.deletePrompt(local.id);
    expect(rt.store.snapshot().prompts.map((x) => x.name)).toEqual(["Testes"]);
  });
});
describe("contexto, skills e comandos", () => {
  for (const [agent, usage, command] of [
    ["codex", { used: 1200, size: 200000 }, "revisar"],
    ["claude", { used: 1200, size: 500000 }, "revisar"],
    ["devin", { used: 900, size: 262000 }, "compact"],
  ] as const)
    it(`${agent}: informa o uso de contexto e os comandos disponíveis`, async () => {
      const events: AgentEvent[] = [];
      const session = new sessions[agent](
        installation(agent),
        task(await temp(), agent),
        {},
        (e) => events.push(e),
      );
      cleanups.push(() => session.close());
      await session.send("Olá", []);
      await eventually(() => events.some((e) => e.type === "done"));
      expect(events.filter((e) => e.type === "usage").at(-1)).toEqual({
        type: "usage",
        ...usage,
      });
      const listed = events.find((e) => e.type === "commands") as any;
      expect(listed.commands.map((c: any) => c.name)).toEqual([command]);
    });
  it("Codex envia as skills citadas com $nome", async () => {
    let text = "";
    let done = false;
    const session = new CodexSession(
      installation("codex"),
      task(await temp(), "codex"),
      {},
      (e) => {
        if (e.type === "text") text += e.text;
        if (e.type === "done") done = true;
      },
    );
    cleanups.push(() => session.close());
    await session.send("SKILLS use $revisar e $inexistente", []);
    await eventually(() => done);
    expect(JSON.parse(text)).toEqual([
      { type: "skill", name: "revisar", path: "C:/skills/revisar/SKILL.md" },
    ]);
  });
  it("lista skills e comandos de cada CLI na pasta da tarefa", async () => {
    const rt = await runtime(["codex", "claude", "devin"]);
    const list = async (agent: AgentId) => {
      const t = await rt.createTask({ title: agent, agent });
      return rt.commands(t.id);
    };
    expect(await list("codex")).toEqual([
      {
        name: "revisar",
        description: "Revisa o código",
        kind: "skill",
        path: "C:/skills/revisar/SKILL.md",
      },
    ]);
    expect(await list("claude")).toEqual([
      {
        name: "revisar",
        description: "Revisa o código",
        kind: "command",
        hint: "[arquivo]",
      },
    ]);
    // Model-only Devin skills cannot be typed by the user.
    expect(await list("devin")).toEqual([
      { name: "revisar", description: "Revisa o código", kind: "skill" },
    ]);
    const p = await rt.project(await temp());
    const untrusted = await rt.createTask({
      projectId: p.id,
      title: "x",
      agent: "claude",
    });
    expect(await rt.commands(untrusted.id)).toEqual([]);
  });
  it("guarda o contexto usado e o descarta ao trocar de modelo", async () => {
    const rt = await runtime(["claude"]);
    const t = await rt.createTask({ title: "Contexto", agent: "claude" });
    await rt.send(t.id, "Olá");
    await idle(rt, t.id);
    expect(rt.task(t.id).context).toEqual({ used: 1200, size: 500000 });
    expect(rt.updateTask(t.id, { model: "outro" }).context).toBeUndefined();
  });
  it("trocar de agente e voltar sem novas mensagens não reenvia contexto", async () => {
    const rt = await runtime(["codex", "claude"]);
    const t = await rt.createTask({ title: "Volta", agent: "claude" });
    await rt.send(t.id, "Primeira");
    await idle(rt, t.id);
    // Replies from 0.1.x did not record which agent wrote them.
    rt.store.put("entry", { ...lastReply(rt, t.id), agent: undefined });
    rt.updateTask(t.id, { agent: "codex" });
    rt.updateTask(t.id, { agent: "claude" });
    await rt.send(t.id, "ECHO volta");
    await idle(rt, t.id);
    expect(lastReply(rt, t.id).text).not.toContain("Contexto da conversa");
  });
});
describe("modo multitarefa", () => {
  it("inicia tarefas no quadro que rodam em paralelo", async () => {
    const rt = await runtime(["codex", "devin"]);
    const a = await rt.startOnBoard({ agent: "codex", text: "HOLD primeira" });
    const b = await rt.startOnBoard({
      agent: "devin",
      text: "HOLD segunda\ncom detalhes",
    });
    expect(b.title).toBe("HOLD segunda");
    // Conversations without a project have their own folders.
    await eventually(
      () =>
        rt.task(a.id).status === "running" &&
        rt.task(b.id).status === "running",
    );
    const cards = rt.board();
    expect(cards.map((c) => c.task.id)).toEqual([a.id, b.id]);
    expect(cards[0].entries.map((e) => e.text)).toContain("HOLD primeira");
    await rt.interrupt(a.id);
    await rt.interrupt(b.id);
  });
  it("mostra pedidos pendentes e tira tarefas do quadro", async () => {
    const rt = await runtime(["devin"]);
    const t = await rt.startOnBoard({ agent: "devin", text: "APPROVE" });
    await eventually(() => rt.board()[0]?.entries.some((e) => !!e.request));
    const [card] = rt.board();
    expect(card.entries.at(-1)!.kind).toBe("request");
    expect(card.entries.at(-1)!.resolved).toBeFalsy();
    const since = rt.task(t.id).boardAt;
    expect(rt.setBoard(t.id, true).boardAt).toBe(since);
    rt.setBoard(t.id, false);
    expect(rt.board()).toEqual([]);
    await rt.interrupt(t.id);
  });
  it("não cria tarefa em projeto sem confiança", async () => {
    const rt = await runtime(["codex"]);
    const p = await rt.project(await temp());
    await expect(
      rt.startOnBoard({ projectId: p.id, agent: "codex", text: "x" }),
    ).rejects.toThrow("Confie no projeto");
    expect(rt.store.all("task")).toEqual([]);
  });
});
describe("cota do plano e imagens do agente", () => {
  it("lê o /usage do Claude Code com os horários de renovação", () => {
    const windows = parseClaudeUsage(
      [
        "You are currently using your subscription",
        "",
        "Current session: 27% used · resets Sep 25, 7:29pm (America/Sao_Paulo)",
        "Current week (all models): 40% used · resets Sep 26, 10:59pm (America/Sao_Paulo)",
        "Current week (Fable): 0% used · resets Sep 26, 11pm (America/Sao_Paulo)",
      ].join("\n"),
      new Date(2026, 8, 25, 12, 0),
    );
    expect(windows).toEqual([
      {
        label: "Sessão (5 horas)",
        usedPercent: 27,
        resetsAt: new Date(2026, 8, 25, 19, 29).getTime() / 1000,
      },
      {
        label: "Semana · todos os modelos",
        usedPercent: 40,
        resetsAt: new Date(2026, 8, 26, 22, 59).getTime() / 1000,
      },
      {
        label: "Semana · Fable",
        usedPercent: 0,
        resetsAt: new Date(2026, 8, 26, 23, 0).getTime() / 1000,
      },
    ]);
  });
  it("consulta a cota de cada CLI e reaproveita a leitura recente", async () => {
    const rt = await runtime(["codex", "claude", "devin"]);
    const codex = await rt.quota("codex");
    expect(codex).toMatchObject({
      plan: "Pro",
      note: "Créditos disponíveis: 12.",
      windows: [
        { label: "Sessão (5 horas)", usedPercent: 42, resetsAt: 1790000000 },
        { label: "Semana", usedPercent: 99, resetsAt: 1790500000 },
      ],
    });
    expect(await rt.quota("codex")).toBe(codex);
    expect(
      (await rt.quota("claude")).windows.map((w) => [w.label, w.usedPercent]),
    ).toEqual([
      ["Sessão (5 horas)", 27],
      ["Semana · todos os modelos", 40],
      ["Semana · Fable", 0],
    ]);
    expect(await rt.quota("devin")).toMatchObject({
      plan: "Devin Pro",
      windows: [],
    });
  });
  it("atualiza a cota com os dados que chegam durante as respostas", async () => {
    const rt = await runtime(["codex", "claude"]);
    await rt.quota("codex");
    await rt.quota("claude");
    for (const agent of ["codex", "claude"] as const) {
      const t = await rt.createTask({ title: agent, agent });
      await rt.send(t.id, "LIMITS");
      await idle(rt, t.id);
    }
    const windows = (agent: AgentId) =>
      rt.agents
        .find((a) => a.id === agent)!
        .quota!.windows.map((w) => [w.label, w.usedPercent]);
    expect(windows("codex")).toEqual([
      ["Sessão (5 horas)", 42],
      ["Semana", 100],
    ]);
    expect(windows("claude")).toEqual([
      ["Sessão (5 horas)", 50],
      ["Semana · todos os modelos", 41],
      ["Semana · Fable", 0],
    ]);
  });
  it("publica no chat as imagens que o Codex gera com a própria ferramenta", async () => {
    const rt = await runtime(["codex"]);
    const t = await rt.createTask({ title: "Imagem", agent: "codex" });
    await rt.send(t.id, "IMAGE");
    await idle(rt, t.id);
    const image = rt.store.entries(t.id).find((e) => e.kind === "image")!;
    expect(image.text).toBe("um raio verde");
    const [artifact] = rt.store.artifacts(t.id);
    expect(artifact).toMatchObject({
      id: image.artifactId,
      provider: "codex",
      model: "gpt-image",
    });
    expect((await readFile(artifact.path)).subarray(1, 4).toString()).toBe(
      "PNG",
    );
  });
});
describe("fila de mensagens", () => {
  const userTexts = (rt: Runtime, id: string) =>
    rt.store
      .entries(id)
      .filter((e) => e.kind === "user")
      .map((e) => e.text);
  it("envia a próxima mensagem quando o agente termina", async () => {
    const rt = await runtime(["codex"]);
    const t = await rt.createTask({ title: "Fila", agent: "codex" });
    await rt.send(t.id, "SLOW primeira");
    await eventually(() => rt.task(t.id).status === "running");
    rt.enqueue(t.id, "segunda");
    expect(rt.task(t.id).queue).toHaveLength(1);
    await eventually(
      () => userTexts(rt, t.id).length === 2 && rt.task(t.id).status === "idle",
    );
    expect(userTexts(rt, t.id)).toEqual(["SLOW primeira", "segunda"]);
    expect(rt.task(t.id).queue).toEqual([]);
  });
  it("edita, reordena e remove; aguarda confiança no projeto", async () => {
    const rt = await runtime(["codex"]);
    const p = await rt.project(await temp());
    const t = await rt.createTask({
      projectId: p.id,
      title: "Fila",
      agent: "codex",
    });
    const [a, b, c] = ["a", "b", "c"].map((text) => rt.enqueue(t.id, text));
    // Untrusted projects keep the queue instead of starting the CLI.
    expect(rt.task(t.id).queue).toHaveLength(3);
    rt.setQueue(t.id, [
      { id: c.id, text: "c editada" },
      { id: a.id, text: "a" },
    ]);
    expect(rt.task(t.id).queue!.map((q) => q.text)).toEqual(["c editada", "a"]);
    expect(() => rt.setQueue(t.id, [{ id: b.id, text: "b" }])).toThrow(
      "não encontrada",
    );
    expect(() => rt.setQueue(t.id, [{ id: a.id, text: " " }])).toThrow("vazia");
  });
  it("enviar agora injeta a mensagem na resposta do Codex", async () => {
    const rt = await runtime(["codex"]);
    const t = await rt.createTask({ title: "Codex", agent: "codex" });
    await rt.send(t.id, "HOLD");
    await eventually(() => rt.task(t.id).status === "running");
    const item = rt.enqueue(t.id, "extra");
    expect(await rt.sendQueued(t.id, item.id)).toBe("steered");
    expect(rt.task(t.id).queue).toEqual([]);
    await idle(rt, t.id);
    expect(userTexts(rt, t.id)).toEqual(["HOLD", "extra"]);
    expect(lastReply(rt, t.id).text).toContain("steer:extra");
  });
  for (const agent of ["claude", "devin"] as const)
    it(`${agent}: enviar agora durante a resposta vira a próxima da fila`, async () => {
      const rt = await runtime([agent]);
      const t = await rt.createTask({ title: agent, agent });
      await rt.send(t.id, "HOLD");
      await eventually(() => rt.task(t.id).status === "running");
      const a = rt.enqueue(t.id, "a");
      const b = rt.enqueue(t.id, "b");
      expect(await rt.sendQueued(t.id, b.id)).toBe("next");
      expect(rt.task(t.id).queue!.map((q) => q.id)).toEqual([b.id, a.id]);
      await rt.interrupt(t.id);
      // An interrupted response does not release the queue.
      expect(rt.task(t.id).queue).toHaveLength(2);
      expect(await rt.sendQueued(t.id, a.id)).toBe("sent");
      await eventually(() => userTexts(rt, t.id).includes("a"));
    });
});
describe("workflows de imagens", () => {
  it("aplica prompt, modelo e seed sem alterar o preset", () => {
    const preset = sdxlPreset();
    const bound = bindWorkflow(preset, {
      prompt: "Uma paisagem",
      model: "sdxl.safetensors",
      seed: 42,
      width: 1024,
      height: 1024,
    });
    expect(bound["6"].inputs.text).toBe("Uma paisagem");
    expect(bound["3"].inputs.seed).toBe(42);
    expect(preset.graph["6"].inputs.text).toBe("");
    validateWorkflow(preset);
  });
  it("rejeita mapeamentos inexistentes e prototype pollution", () => {
    const preset = sdxlPreset();
    preset.bindings.prompt = "__proto__.inputs.text";
    expect(() => bindWorkflow(preset, { prompt: "x" })).toThrow();
    preset.bindings.prompt = "999.inputs.text";
    expect(() => bindWorkflow(preset, { prompt: "x" })).toThrow();
  });
  it("edição SDXL usa a imagem carregada como latente", () => {
    const preset = sdxlPreset(true);
    const bound = bindWorkflow(preset, { image: "input.png" });
    expect(bound["10"].inputs.image).toBe("input.png");
    expect(bound["3"].inputs.latent_image).toEqual(["11", 0]);
  });
});
