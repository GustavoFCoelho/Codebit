import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/main/store";
import { Runtime } from "../src/main/runtime";
import { SecretVault } from "../src/main/secrets";
import { mcpFor } from "../src/main/extensions";
import type { AgentId, Entry } from "../src/shared/types";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
// Stands in for Windows' encryption: reversible, but not the plain value.
const crypto = {
  encrypt: (v: string) => "enc:" + Buffer.from(v).toString("base64"),
  decrypt: (v: string) =>
    Buffer.from(v.replace(/^enc:/, ""), "base64").toString(),
};
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "codebit-secrets-"));
  const store = new Store(join(root, "data"));
  const vault = new SecretVault(store, crypto);
  cleanups.push(() =>
    rm(root, { recursive: true, force: true, maxRetries: 5 }),
  );
  cleanups.push(() => store.close());
  return { store, vault };
}
const installation = (agent: AgentId) => ({
  agent,
  path: process.execPath,
  command: process.execPath,
  args: [resolve("tests/fixtures/agent.mjs"), agent],
  version: "test",
});
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condição não atendida");
    await new Promise((r) => setTimeout(r, 20));
  }
}
describe("secrets", () => {
  it("guardam o valor cifrado e validam o nome", async () => {
    const { store, vault } = await setup();
    const saved = vault.save({
      name: "openai_api_key",
      value: "sk-proj-123456",
      description: "Chave do projeto de imagens",
    });
    expect(saved.name).toBe("OPENAI_API_KEY");
    // Only the name and description are kept in the clear.
    expect(JSON.stringify(store.all("user-secret"))).not.toContain("sk-proj");
    expect(store.secret(`user:${saved.id}`)).not.toContain("sk-proj");
    expect(vault.env()).toEqual({ OPENAI_API_KEY: "sk-proj-123456" });
    // An empty value on edit keeps the saved one.
    vault.save({ id: saved.id, name: "OPENAI_API_KEY", description: "Nova" });
    expect(vault.value("OPENAI_API_KEY")).toBe("sk-proj-123456");
    expect(vault.list()[0].description).toBe("Nova");
    for (const [input, error] of [
      [{ name: "1CHAVE", value: "x" }, "começando por letra"],
      [{ name: "MINHA-CHAVE", value: "x" }, "só letras"],
      [{ name: "PATH", value: "x" }, "variável do sistema"],
      [{ name: "CODEBIT_TOOLS", value: "x" }, "do Codebit"],
      [{ name: "OPENAI_API_KEY", value: "x" }, "Já existe"],
      [{ name: "OUTRA" }, "Informe o valor"],
    ] as const)
      expect(() => vault.save(input)).toThrow(error);
    vault.delete(saved.id);
    expect(vault.list()).toEqual([]);
    expect(store.secret(`user:${saved.id}`)).toBeUndefined();
    expect(vault.env()).toEqual({});
  });
  it("o agente recebe a variável, conhece só o nome e o valor fica mascarado", async () => {
    const { store, vault } = await setup();
    vault.save({
      name: "PROJETO_TOKEN",
      value: "tok-secreto-987",
      description: "API do projeto",
    });
    // Claude Code would bill this key instead of the subscription.
    vault.save({ name: "ANTHROPIC_API_KEY", value: "sk-ant-000000" });
    const rt = new Runtime(
      store,
      () => {},
      () => undefined,
    );
    cleanups.push(() => rt.close());
    rt.secrets = vault;
    rt.agents = (["codex", "claude"] as AgentId[]).map((id) => ({
      id,
      name: id,
      auth: "ready",
      models: [],
      installations: [installation(id)],
      selected: installation(id),
    }));
    const reply = async (agent: AgentId, text: string) => {
      const t = await rt.createTask({ title: text, agent });
      await rt.send(t.id, text);
      await eventually(() => rt.task(t.id).status === "idle");
      return store
        .entries(t.id)
        .filter((e: Entry) => e.kind === "assistant")
        .at(-1)!.text;
    };
    // The value reaches the process, and an echo of it is masked.
    expect(await reply("codex", "ENVVAR:PROJETO_TOKEN")).toBe(
      "valor: [secret PROJETO_TOKEN]",
    );
    expect(await reply("claude", "ENVVAR:PROJETO_TOKEN")).toBe(
      "valor: [secret PROJETO_TOKEN]",
    );
    expect(await reply("codex", "ENVVAR:ANTHROPIC_API_KEY")).toBe(
      "valor: [secret ANTHROPIC_API_KEY]",
    );
    expect(await reply("claude", "ENVVAR:ANTHROPIC_API_KEY")).toBe(
      "valor: (ausente)",
    );
    // The instructions name the secret, never its value.
    const guide = await reply("claude", "GUIDE");
    expect(guide).toContain("PROJETO_TOKEN (API do projeto)");
    expect(guide).not.toContain("tok-secreto-987");
    expect(guide).not.toContain("ANTHROPIC_API_KEY");
  });
  it("conexões MCP leem secrets com ${NOME}", () => {
    const servers = mcpFor(
      "codex",
      [
        {
          id: "s",
          name: "busca",
          agent: "both",
          enabled: true,
          transport: "stdio",
          command: "busca.exe",
          args: [],
          env: { TOKEN: "${BUSCA_TOKEN}" },
        } as any,
      ],
      {},
      { BUSCA_TOKEN: "abc123" },
    );
    expect(servers.codebit_busca.env).toEqual({ TOKEN: "abc123" });
  });
});
