import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Store } from "../src/main/store";
import { Runtime } from "../src/main/runtime";
import { discover, checkAuth, readVersion } from "../src/main/discovery";
import { probeModels } from "../src/main/agents/catalog";
import { nativeModels } from "../src/main/agents/models";
import type { AgentId, AgentInfo, Installation } from "../src/shared/types";

vi.mock("../src/main/discovery", () => ({
  discover: vi.fn(),
  checkAuth: vi.fn(),
  readVersion: vi.fn(),
}));
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((f) => f()),
);
function installation(agent: AgentId): Installation {
  return {
    agent,
    command: process.execPath,
    path: process.execPath,
    args: [resolve("tests/fixtures/agent.mjs"), agent],
    version: "test",
  };
}
function agentInfo(id: AgentId): AgentInfo {
  const selected = installation(id);
  return {
    id,
    name: id,
    models: [],
    auth: "unknown",
    selected,
    installations: [selected],
  };
}
beforeEach(() => {
  vi.mocked(discover)
    .mockReset()
    .mockImplementation(async () => [agentInfo("codex"), agentInfo("claude")]);
  vi.mocked(checkAuth)
    .mockReset()
    .mockImplementation(async (a) => ({ ...a, auth: "ready" }));
  vi.mocked(readVersion).mockReset();
});
async function runtime() {
  const root = await mkdtemp(resolve(".codebit-test", "catalog-"));
  const store = new Store(root);
  const rt = new Runtime(
    store,
    () => {},
    () => undefined,
  );
  cleanup.push(() => {
    rt.close();
    store.close();
  });
  return rt;
}
async function ready(rt: Runtime) {
  await vi.waitFor(() =>
    expect(rt.agents.map((a) => a.catalogStatus)).toEqual(["ready", "ready"]),
  );
}

it("consulta os dois catálogos na descoberta, sem mensagem nem verificação manual", async () => {
  const rt = await runtime();
  await rt.detect();
  await ready(rt);
  expect(rt.agents.map((a) => a.models[0].efforts)).toEqual([
    ["low", "medium", "high"],
    ["low", "medium", "high"],
  ]);
  expect(rt.store.all("entry")).toEqual([]);
  expect(checkAuth).toHaveBeenCalledTimes(2);
  const a = rt.auth("codex"),
    b = rt.auth("codex");
  await Promise.all([a, b]);
  expect(checkAuth).toHaveBeenCalledTimes(3);
});

it("expõe falha de acesso e permite tentar novamente", async () => {
  const rt = await runtime();
  vi.mocked(checkAuth).mockImplementation(async (a) => ({
    ...a,
    auth: "missing",
    authMessage: "Faça login no CLI.",
  }));
  await rt.detect();
  await vi.waitFor(() =>
    expect(rt.agents.every((a) => a.catalogStatus === "error")).toBe(true),
  );
  expect(rt.agents[0].catalogError).toBe("Faça login no CLI.");
  vi.mocked(checkAuth).mockImplementation(async (a) => ({
    ...a,
    auth: "ready",
  }));
  const refreshed = await rt.auth("codex");
  expect(refreshed.catalogStatus).toBe("ready");
  expect(refreshed.catalogError).toBeUndefined();
});

it("ignora consultas antigas quando a instalação é redetectada", async () => {
  const rt = await runtime();
  let finishOld!: (a: AgentInfo) => void;
  vi.mocked(checkAuth).mockImplementationOnce(
    () =>
      new Promise((r) => {
        finishOld = r;
      }),
  );
  await rt.detect();
  const old = rt.agents[0];
  const oldLoad = rt.auth("codex");
  await rt.detect();
  await ready(rt);
  const current = rt.agents[0];
  finishOld({ ...old, auth: "missing", authMessage: "Resultado antigo" });
  await oldLoad;
  expect(rt.agents[0]).toBe(current);
  expect(current.auth).toBe("ready");
  expect(current.catalogError).toBeUndefined();
});

it("redetecta o CLI quando um agente o atualiza durante a tarefa", async () => {
  const rt = await runtime();
  await rt.detect();
  await ready(rt);
  vi.mocked(readVersion).mockResolvedValue("desconhecida");
  expect(await rt.checkVersions()).toBe(false);
  // At most one check per minute.
  vi.mocked(readVersion).mockImplementation(async (spec) =>
    spec.args[1] === "codex" ? "0.158.0" : "test",
  );
  expect(await rt.checkVersions()).toBe(false);
  expect(readVersion).toHaveBeenCalledTimes(2);
  const old = rt.agents[0];
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
  try {
    expect(await rt.checkVersions()).toBe(true);
  } finally {
    now.mockRestore();
  }
  expect(discover).toHaveBeenCalledTimes(2);
  expect(rt.agents[0]).not.toBe(old);
  await ready(rt);
});

it("preserva os níveis nativos e não inventa esforço para modelos sem suporte", () => {
  const models = nativeModels("claude", [
    {
      value: "opus",
      displayName: "Opus",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high", "max"],
    },
    { value: "haiku", displayName: "Haiku" },
  ]);
  expect(models[0].efforts).toEqual(["low", "high", "max"]);
  expect(models[1].efforts).toEqual([]);
});

for (const agent of ["codex", "claude"] as const) {
  it(`${agent}: salva modelo/esforço e aplica a escolha também na retomada`, async () => {
    const rt = await runtime();
    await rt.detect();
    await ready(rt);
    const p = await rt.project(rt.store.root);
    rt.store.put("project", { ...p, trusted: true });
    const t = await rt.createTask({ projectId: p.id, agent, title: "Esforço" });
    for (const effort of ["high", "low", ""]) {
      rt.updateTask(t.id, { model: "test-model", effort });
      await rt.send(t.id, "OPTIONS");
      await vi.waitFor(() => expect(rt.task(t.id).status).toBe("idle"));
      const reply = rt.store
        .entries(t.id)
        .filter((e) => e.kind === "assistant")
        .at(-1)!;
      expect(JSON.parse(reply.text)).toEqual({
        model: "test-model",
        effort: effort || (agent === "codex" ? "medium" : null),
      });
      expect(rt.task(t.id).nativeId).toBe(`native-${agent}`);
    }
    rt.updateTask(t.id, { effort: "high" });
    expect(() => rt.updateTask(t.id, { effort: "ultra" })).toThrow(
      "não está disponível",
    );
    const db = new Store(rt.store.root);
    expect(db.get<any>("task", t.id).effort).toBe("high");
    db.close();
    expect(rt.updateTask(t.id, { model: "manual-other-model" }).effort).toBe(
      "",
    );
    expect(() => rt.updateTask(t.id, { effort: "high" })).toThrow(
      "não está disponível",
    );
  });
}

it("encerra a consulta do catálogo quando cancelada", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    probeModels(installation("codex"), process.cwd(), controller.signal),
  ).rejects.toThrow();
});
