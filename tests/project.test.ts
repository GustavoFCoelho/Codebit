import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/main/store";
import { Runtime } from "../src/main/runtime";
import { capture } from "../src/main/process";
import type { AgentId, Project } from "../src/shared/types";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const root = await mkdtemp(join(resolve(tmpdir()), "codebit-project-"));
  cleanups.push(() =>
    rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  );
  const folder = join(root, "forja");
  await capture("git", ["init", "-q", folder], root);
  await writeFile(join(folder, "leia.md"), "# Forja");
  for (const args of [
    ["add", "."],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
  ])
    await capture("git", args, folder);
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
  const installation = (agent: AgentId) => ({
    agent,
    path: process.execPath,
    command: process.execPath,
    args: [resolve("tests/fixtures/agent.mjs"), agent],
    version: "test",
  });
  rt.agents = (["codex"] as AgentId[]).map((id) => ({
    id,
    name: id,
    auth: "ready" as const,
    models: [],
    installations: [installation(id)],
    selected: installation(id),
  }));
  const project = store.put<Project>("project", {
    id: "p1",
    name: "Forja",
    path: folder,
    git: true,
    trusted: true,
  });
  return { rt, store, folder, project };
}
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condição não atendida");
    await new Promise((r) => setTimeout(r, 20));
  }
}
describe("remover projeto", () => {
  it("apaga o que o Codebit guarda do projeto e deixa a pasta intacta", async () => {
    const s = await setup();
    const chat = await s.rt.createTask({
      title: "Conversa",
      agent: "codex",
      projectId: "p1",
    });
    await s.rt.send(chat.id, "Oi");
    await eventually(() => s.rt.task(chat.id).status === "idle");
    const local = s.rt.savePrompt({
      name: "Do projeto",
      text: "x",
      projectId: "p1",
      mode: "plan",
    });
    const global = s.rt.savePrompt({
      name: "Global",
      text: "y",
      projectId: "",
      mode: "plan",
    });
    s.store.put("post", { id: randomUUID(), projectId: "p1" });
    // Something still working blocks the removal.
    const busy = await s.rt.createTask({
      title: "Ocupada",
      agent: "codex",
      projectId: "p1",
    });
    await s.rt.send(busy.id, "HOLD");
    await eventually(() => s.rt.task(busy.id).status === "running");
    await expect(s.rt.deleteProject("p1")).rejects.toThrow("Interrompa");
    expect(s.store.all("project")).toHaveLength(1);
    await s.rt.interrupt(busy.id);
    await s.rt.deleteProject("p1");
    expect(s.store.all("project")).toEqual([]);
    expect(s.store.all("task")).toEqual([]);
    expect(s.store.entries(chat.id)).toEqual([]);
    expect(s.store.all("post")).toEqual([]);
    expect(s.store.all<any>("prompt").map((p) => p.id)).toEqual([global.id]);
    expect(s.store.all<any>("prompt").some((p) => p.id === local.id)).toBe(
      false,
    );
    // The folder on disk is untouched.
    expect(existsSync(join(s.folder, "leia.md"))).toBe(true);
    expect(existsSync(join(s.folder, ".git"))).toBe(true);
  });
  it("worktrees do Codebit só saem quando pedido", async () => {
    const s = await setup();
    const kept = await s.rt.createTask({
      title: "Isolada",
      agent: "codex",
      projectId: "p1",
      worktree: true,
    });
    expect(existsSync(kept.cwd)).toBe(true);
    await s.rt.deleteProject("p1");
    expect(existsSync(kept.cwd)).toBe(true);
    s.store.put("project", s.project);
    const gone = await s.rt.createTask({
      title: "Isolada 2",
      agent: "codex",
      projectId: "p1",
      worktree: true,
    });
    await s.rt.deleteProject("p1", true);
    expect(existsSync(gone.cwd)).toBe(false);
    expect(existsSync(join(s.folder, "leia.md"))).toBe(true);
  });
});
