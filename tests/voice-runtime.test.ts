import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Runtime } from "../src/main/runtime";
import { Store } from "../src/main/store";
import type { AgentId } from "../src/shared/types";
import type { TaskSignal } from "../src/shared/voice";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function setup(agent: AgentId = "claude") {
  const root = await mkdtemp(join(resolve(tmpdir()), "codebit-voice-"));
  cleanups.push(() =>
    rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  );
  const store = new Store(root);
  const signals: TaskSignal[] = [];
  const rt = new Runtime(
    store,
    (e) => {
      if (e.type === "task-signal") signals.push(e.signal);
    },
    () => undefined,
  );
  // Only the repository's protocol simulator is launched; no installed agent.
  const install = {
    agent,
    path: process.execPath,
    command: process.execPath,
    args: [resolve("tests/fixtures/agent.mjs"), agent],
    version: "test",
  };
  rt.agents = [
    {
      id: agent,
      name: agent,
      auth: "ready",
      models: [],
      installations: [install],
      selected: install,
    },
  ];
  vi.spyOn(rt, "checkVersions").mockResolvedValue(false);
  cleanups.push(() => {
    rt.close();
    store.close();
  });
  const task = await rt.createTask({ title: "Voz", agent });
  return { rt, signals, task };
}
async function eventually(check: () => boolean) {
  const until = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > until) throw new Error("Condição não atendida");
    await new Promise((r) => setTimeout(r, 10));
  }
}
it("sinal de término espera trabalho em segundo plano e o relato final", async () => {
  const { rt, task, signals } = await setup();
  await rt.send(task.id, "BACKGROUND");
  await eventually(
    () => rt.task(task.id).status === "idle" && !!rt.task(task.id).background,
  );
  expect(signals).toEqual([]);
  await eventually(() => signals.some((s) => s.kind === "completed"));
  expect(rt.task(task.id).background).toBeUndefined();
  expect(
    rt.store
      .entries(task.id)
      .some((e) => e.text.includes("concluído em segundo plano")),
  ).toBe(true);
  expect(signals.filter((s) => s.kind === "completed")).toHaveLength(1);
});
it("fila não anuncia entrega entre instruções consecutivas", async () => {
  const { rt, task, signals } = await setup();
  await rt.send(task.id, "SLOW ECHO primeiro");
  rt.enqueue(task.id, "SLOW ECHO segundo");
  await eventually(() =>
    rt.store
      .entries(task.id)
      .some((e) => e.kind === "user" && e.text.includes("segundo")),
  );
  expect(signals.filter((s) => s.kind === "completed")).toHaveLength(0);
  await eventually(() => signals.some((s) => s.kind === "completed"));
  expect(signals.filter((s) => s.kind === "completed")).toHaveLength(1);
});
it("falha e pedido de aprovação não são conclusão", async () => {
  const { rt, task, signals } = await setup("codex");
  await rt.send(task.id, "FAILTURN");
  await eventually(() => signals.some((s) => s.kind === "failed"));
  expect(signals.some((s) => s.kind === "completed")).toBe(false);
  await rt.send(task.id, "APPROVE");
  await eventually(() => signals.some((s) => s.kind === "waiting"));
  expect(rt.task(task.id).status).toBe("waiting");
  expect(signals.some((s) => s.kind === "completed")).toBe(false);
});
