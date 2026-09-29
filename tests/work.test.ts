import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/main/store";
import { Runtime } from "../src/main/runtime";
import { ImageBridge } from "../src/main/bridge";
import { codebitInstructions } from "../src/main/extensions";
import {
  defaultWork,
  workStatus,
  type AgentId,
  type Project,
} from "../src/shared/types";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(agents: AgentId[] = ["codex", "claude"]) {
  const root = await mkdtemp(join(resolve(tmpdir()), "codebit-work-"));
  cleanups.push(() =>
    rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  );
  const store = new Store(join(root, "data"));
  const notices: string[] = [];
  const rt = new Runtime(
    store,
    () => {},
    () => undefined,
  );
  rt.attention = (n) => notices.push(`${n.title}: ${n.body}`);
  cleanups.push(() => {
    rt.close();
    store.close();
  });
  const installation = (agent: AgentId) => ({
    agent,
    path: process.execPath,
    command: process.execPath,
    args: [resolve("tests/fixtures/agent.mjs"), agent],
    version: "test",
  });
  rt.agents = agents.map((id) => ({
    id,
    name: id,
    auth: "ready" as const,
    models: [],
    installations: [installation(id)],
    selected: installation(id),
  }));
  store.put<Project>("project", {
    id: "p1",
    name: "Forja",
    path: root,
    git: false,
    trusted: true,
  });
  const status = (id: string) => {
    const item = store.get<any>("work", id);
    return workStatus(
      item,
      item.taskId
        ? store.all<any>("task").find((t) => t.id === item.taskId)
        : undefined,
    );
  };
  const busy = () =>
    rt
      .workItems("p1")
      .filter((i) => ["running", "waiting"].includes(status(i.id))).length;
  return { rt, store, root, status, busy, notices };
}
async function eventually(check: () => boolean, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condição não atendida");
    await new Promise((r) => setTimeout(r, 20));
  }
}
describe("quadro de tarefas", () => {
  it("desligado, nada começa sozinho; executar agora abre uma sessão interna", async () => {
    const s = await setup();
    s.rt.setWork("p1", {
      ...defaultWork,
      agent: "claude",
      model: "sonnet",
      mode: "execute",
    });
    const item = s.rt.addWork("p1", {
      title: "Criar os mobs",
      description: "ECHO goblin e orc",
    });
    expect(item).toMatchObject({ origin: "user", state: "todo" });
    await new Promise((r) => setTimeout(r, 100));
    expect(s.status(item.id)).toBe("todo");
    await s.rt.startWork(item.id);
    await eventually(() => s.status(item.id) === "done");
    const task = s.rt.task(s.store.get<any>("work", item.id).taskId);
    expect(task).toMatchObject({
      workItemId: item.id,
      projectId: "p1",
      agent: "claude",
      model: "sonnet",
      mode: "execute",
      title: "Criar os mobs",
    });
    // The session got the task, and the reply is in its chat.
    const reply = s.store.entries(task.id).find((e) => e.kind === "assistant");
    expect(reply?.text).toContain(
      "Tarefa do quadro do projeto Forja: Criar os mobs",
    );
    expect(reply?.text).toContain("ECHO goblin e orc");
  });
  it("ligado, respeita o limite simultâneo e segue a fila; desligar deixa terminar", async () => {
    const s = await setup();
    const hold = s.rt.addWork("p1", { title: "HOLD primeira" });
    const second = s.rt.addWork("p1", { title: "SLOW segunda" });
    const third = s.rt.addWork("p1", { title: "SLOW terceira" });
    s.rt.setWork("p1", { ...defaultWork, enabled: true, max: 1 });
    await eventually(() => s.status(hold.id) === "running");
    await new Promise((r) => setTimeout(r, 300));
    expect(s.busy()).toBe(1);
    expect(s.status(second.id)).toBe("todo");
    // Raising the limit starts the next one.
    s.rt.setWork("p1", { ...defaultWork, enabled: true, max: 2 });
    await eventually(() => s.status(second.id) !== "todo");
    expect(s.status(third.id)).toBe("todo");
    await eventually(() => s.status(second.id) === "done");
    await eventually(() => s.status(third.id) === "done");
    // Turned off: what runs keeps running, nothing new starts.
    const fourth = s.rt.addWork("p1", { title: "SLOW quarta" });
    s.rt.setWork("p1", { ...defaultWork, enabled: false, max: 2 });
    await eventually(() => s.status(fourth.id) !== "todo", 400).catch(() => {});
    expect(s.status(fourth.id)).toBe("todo");
    expect(s.status(hold.id)).toBe("running");
    await s.rt.interrupt(s.store.get<any>("work", hold.id).taskId);
    expect(s.status(hold.id)).toBe("interrupted");
  });
  it("recomendações da IA ficam pendentes até aprovar; aprovadas entram na fila", async () => {
    const s = await setup();
    const item = s.rt.addWork("p1", { title: "Revisar o combate" });
    await s.rt.startWork(item.id);
    await eventually(() => s.status(item.id) === "done");
    const session = s.store.get<any>("work", item.id).taskId;
    s.rt.setWork("p1", { ...defaultWork, enabled: true });
    const reply = s.rt.tasksTool(session, {
      tool: "add_tasks",
      args: {
        tasks: [
          {
            title: "Corrigir dano do orc",
            description: "O orc causa dano dobrado.",
          },
          { title: "Balancear o troll" },
        ],
      },
    });
    expect(reply.content[0].text).toContain("pendentes de aprovação");
    const pending = s.rt.workItems("p1").filter((i) => i.state === "pending");
    expect(pending.map((i) => [i.title, i.origin, i.sourceId])).toEqual([
      ["Corrigir dano do orc", "ai", item.id],
      ["Balancear o troll", "ai", item.id],
    ]);
    // Even with the mode on, a recommendation does not start by itself.
    await new Promise((r) => setTimeout(r, 200));
    expect(pending.map((i) => s.status(i.id))).toEqual(["pending", "pending"]);
    await expect(s.rt.startWork(pending[0].id)).rejects.toThrow("Aprove");
    s.rt.approveWork(pending[0].id);
    await eventually(() => s.status(pending[0].id) === "done");
    expect(s.status(pending[1].id)).toBe("pending");
    expect(
      s.store
        .entries(session)
        .some((e) => e.text.includes("sugeridas, pendentes de aprovação")),
    ).toBe(true);
  });
  it("conversas do projeto criam tarefas no quadro: pedidas vão para a fila, sugestões esperam aprovação", async () => {
    const s = await setup();
    const chat = await s.rt.createTask({
      title: "Planejar a forja",
      agent: "codex",
      projectId: "p1",
    });
    const asked = s.rt.tasksTool(chat.id, {
      tool: "add_tasks",
      args: {
        requested_by_user: true,
        tasks: [{ title: "Criar a dungeon", description: "Doze salas." }],
      },
    });
    expect(asked.content[0].text).toContain('em "A fazer"');
    expect(asked.content[0].text).toContain("modo tarefas está desligado");
    const idea = s.rt.tasksTool(chat.id, {
      tool: "add_tasks",
      args: { tasks: [{ title: "Adicionar trilha sonora" }] },
    });
    expect(idea.content[0].text).toContain("pendentes de aprovação");
    expect(
      s.rt.workItems("p1").map((i) => [i.title, i.origin, i.state, i.chatId]),
    ).toEqual([
      ["Criar a dungeon", "user", "todo", chat.id],
      ["Adicionar trilha sonora", "ai", "pending", chat.id],
    ]);
    // With the mode off, nothing starts; the chat shows what went to the board.
    await new Promise((r) => setTimeout(r, 150));
    expect(s.rt.workItems("p1").every((i) => !i.taskId)).toBe(true);
    const log = s.store.entries(chat.id).map((e) => e.text);
    expect(log).toContain("Quadro · 1 tarefa em A fazer: Criar a dungeon");
    expect(log).toContain(
      "Quadro · 1 tarefa sugerida, pendente de aprovação: Adicionar trilha sonora",
    );
    // list_tasks shows the board with each status.
    const listed = JSON.parse(
      s.rt.tasksTool(chat.id, { tool: "list_tasks" }).content[0].text,
    );
    expect(listed).toEqual([
      expect.objectContaining({ title: "Criar a dungeon", status: "todo" }),
      expect.objectContaining({
        title: "Adicionar trilha sonora",
        status: "pending",
      }),
    ]);
    // With the mode on, what the user asked for starts by itself.
    s.rt.setWork("p1", { enabled: true });
    s.rt.tasksTool(chat.id, {
      tool: "add_tasks",
      args: { requested_by_user: true, tasks: [{ title: "SLOW baú" }] },
    });
    const chest = s.rt.workItems("p1").find((i) => i.title === "SLOW baú")!;
    await eventually(() => s.status(chest.id) === "done");
    // Conversations without a project have no board.
    const free = await s.rt.createTask({ title: "Livre", agent: "codex" });
    expect(() => s.rt.tasksTool(free.id, { tool: "list_tasks" })).toThrow(
      "não tem projeto",
    );
  });
  it("duas falhas seguidas pausam o modo e avisam", async () => {
    const s = await setup();
    const a = s.rt.addWork("p1", { title: "FAILTURN a" });
    const b = s.rt.addWork("p1", { title: "FAILTURN b" });
    const c = s.rt.addWork("p1", { title: "SLOW c" });
    s.rt.setWork("p1", { ...defaultWork, enabled: true });
    await eventually(() => s.status(b.id) === "failed");
    await eventually(
      () => !s.store.get<Project>("project", "p1").work?.enabled,
    );
    expect(s.status(a.id)).toBe("failed");
    expect(s.status(c.id)).toBe("todo");
    expect(s.notices.some((n) => n.includes("Modo tarefas pausado"))).toBe(
      true,
    );
    // Tried again, it resumes in the same session.
    const session = s.store.get<any>("work", a.id).taskId;
    s.rt.retryWork(a.id);
    expect(s.rt.workItems("p1")[0].id).toBe(a.id);
    await s.rt.startWork(a.id);
    await eventually(() => s.status(a.id) !== "todo");
    expect(s.store.get<any>("work", a.id).taskId).toBe(session);
    expect(
      s.store
        .entries(session)
        .some((e) => e.text.startsWith("Retome esta tarefa")),
    ).toBe(true);
  });
  it("ordem, edição e exclusão; a sessão interna fica fora das conversas", async () => {
    const s = await setup();
    const a = s.rt.addWork("p1", { title: "A" });
    const b = s.rt.addWork("p1", { title: "B" });
    s.rt.moveWork(b.id, -1);
    expect(s.rt.workItems("p1").map((i) => i.title)).toEqual(["B", "A"]);
    s.rt.editWork(a.id, { title: "A editada", description: "Detalhes" });
    expect(s.store.get<any>("work", a.id)).toMatchObject({
      title: "A editada",
      description: "Detalhes",
    });
    expect(() => s.rt.editWork(a.id, { title: " " })).toThrow("título");
    const hold = s.rt.addWork("p1", { title: "HOLD longa" });
    await s.rt.startWork(hold.id);
    await eventually(() => s.status(hold.id) === "running");
    await expect(s.rt.deleteWork(hold.id)).rejects.toThrow("Interrompa");
    const taskId = s.store.get<any>("work", hold.id).taskId;
    await s.rt.interrupt(taskId);
    await s.rt.deleteWork(hold.id);
    expect(s.store.all<any>("task").some((t) => t.id === taskId)).toBe(false);
    // Deleting the internal session also removes its board task.
    await s.rt.startWork(a.id);
    await eventually(() => s.status(a.id) === "done");
    await s.rt.deleteTask(s.store.get<any>("work", a.id).taskId);
    expect(s.rt.workItems("p1").map((i) => i.title)).toEqual(["B"]);
  });
  it("configurações do modo mudam campo a campo e exigem projeto confiável", async () => {
    const s = await setup();
    s.rt.setWork("p1", { agent: "claude" });
    s.rt.setWork("p1", { max: 9 });
    expect(s.store.get<Project>("project", "p1").work).toEqual({
      ...defaultWork,
      agent: "claude",
      max: 4,
    });
    s.store.put("project", {
      ...s.store.get<Project>("project", "p1"),
      trusted: false,
    });
    expect(() => s.rt.setWork("p1", { enabled: true })).toThrow("Confie");
  });
  it("toda sessão de projeto recebe codebit_tasks, com o papel certo", async () => {
    const s = await setup();
    const servers: Record<string, any>[] = [];
    s.rt.bridgeConfig = (_id, kind, env) => ({ kind, env });
    const create = (s.rt as any).createSession.bind(s.rt);
    (s.rt as any).createSession = (...args: any[]) => {
      servers.push(args[2]);
      return create(...args);
    };
    const item = s.rt.addWork("p1", { title: "Uma tarefa" });
    await s.rt.startWork(item.id);
    await eventually(() => s.status(item.id) === "done");
    expect(servers.at(-1)?.codebit_tasks.env).toEqual({
      CODEBIT_TASK_ROLE: "board",
    });
    const chat = await s.rt.createTask({
      title: "Conversa",
      agent: "codex",
      projectId: "p1",
    });
    await s.rt.send(chat.id, "Oi");
    await eventually(() => s.rt.task(chat.id).status === "idle");
    expect(servers.at(-1)?.codebit_tasks.env).toEqual({
      CODEBIT_TASK_ROLE: "chat",
    });
    const free = await s.rt.createTask({ title: "Livre", agent: "codex" });
    await s.rt.send(free.id, "Oi");
    await eventually(() => s.rt.task(free.id).status === "idle");
    expect(servers.at(-1)).not.toHaveProperty("codebit_tasks");
  });
  it("as instruções explicam o canal conforme a sessão", () => {
    const chat = codebitInstructions({
      codebit_tasks: { env: { CODEBIT_TASK_ROLE: "chat" } },
    });
    expect(chat).toContain("add_tasks com requested_by_user: true");
    expect(chat).toContain("list_tasks");
    const board = codebitInstructions({
      codebit_tasks: { env: { CODEBIT_TASK_ROLE: "board" } },
    });
    expect(board).toContain("trabalha numa tarefa do quadro");
    expect(board).not.toContain("requested_by_user: true");
    expect(codebitInstructions({})).not.toContain("codebit_tasks");
  });
  it("a ponte do quadro aceita só as ferramentas e parâmetros do canal", async () => {
    const calls: any[] = [];
    const runtime = {
      tasksTool: (id: string, args: unknown) => {
        calls.push({ id, args });
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as any;
    const bridge = new ImageBridge(runtime, process.execPath, "image-mcp.cjs");
    await bridge.start();
    try {
      const { env } = bridge.config("chat-1", "tasks", {
        CODEBIT_TASK_ROLE: "chat",
      });
      expect(env.CODEBIT_TASK_ROLE).toBe("chat");
      const send = (body: unknown) =>
        fetch(env.CODEBIT_TOOL_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.CODEBIT_TOOL_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }).then((r) => r.status);
      expect(await send({ tool: "apagar_quadro", args: {} })).toBe(400);
      expect(await send({ tool: "add_tasks", args: { tasks: [] } })).toBe(400);
      expect(
        await send({
          tool: "add_tasks",
          args: { tasks: [{ title: "x" }], requested_by_user: "sim" },
        }),
      ).toBe(400);
      expect(await send({ tool: "list_tasks" })).toBe(200);
      expect(
        await send({
          tool: "add_tasks",
          args: { tasks: [{ title: "Dungeon" }], requested_by_user: true },
        }),
      ).toBe(200);
      expect(calls.map((c) => c.args.tool)).toEqual([
        "list_tasks",
        "add_tasks",
      ]);
    } finally {
      bridge.close();
    }
  });
});
