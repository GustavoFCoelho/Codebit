import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceMode } from "../src/main/source";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
async function project() {
  const root = await mkdtemp(join(tmpdir(), "codebit-source-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "dist"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const stamp = (core: string, ui: string) =>
    writeFile(
      join(root, "dist", "build.json"),
      JSON.stringify({
        version: "0",
        builtAt: new Date().toISOString(),
        core,
        interface: ui,
      }),
    );
  await stamp("c1", "i1");
  return { root, stamp };
}
async function eventually(check: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condição não atendida");
    await new Promise((r) => setTimeout(r, 30));
  }
}
function mode(
  root: string,
  build: () => Promise<{ ok: boolean; output: string }>,
  busy = () => false,
) {
  const calls = { reload: 0, restart: 0 };
  const source = new SourceMode(root, {
    build,
    busy,
    reload: () => calls.reload++,
    restart: () => calls.restart++,
    changed: () => {},
    quietMs: 150,
  });
  cleanups.push(() => source.stop());
  return { source, calls };
}
describe("modo código (rodando da pasta do projeto)", () => {
  it("prepara sozinho depois das mudanças em src e separa interface de núcleo", async () => {
    const { root, stamp } = await project();
    let builds = 0;
    let next: [string, string] = ["c1", "i2"];
    const { source, calls } = mode(root, async () => {
      builds++;
      await stamp(...next);
      return { ok: true, output: "" };
    });
    await source.start();
    // Several saves in a row become one build.
    for (let i = 0; i < 4; i++) {
      await writeFile(join(root, "src", "a.ts"), `export const a = ${i};`);
      await new Promise((r) => setTimeout(r, 30));
    }
    await eventually(() => source.state.interface);
    expect(builds).toBe(1);
    expect(source.state.core).toBe(false);
    await source.reloadInterface();
    expect(calls.reload).toBe(1);
    expect(source.state.interface).toBe(false);
    // The core changed too: only a restart applies it.
    next = ["c2", "i2"];
    await writeFile(join(root, "src", "a.ts"), "export const a = 9;");
    await eventually(() => source.state.core);
    await expect(source.reloadInterface()).rejects.toThrow("reinicie");
    source.restart();
    expect(calls.restart).toBe(1);
  });
  it("um build com erro mantém a versão atual e a próxima mudança tenta de novo", async () => {
    const { root, stamp } = await project();
    let ok = false;
    const { source } = mode(root, async () => {
      if (!ok)
        return {
          ok: false,
          output: "src/a.ts(1,7): error TS2322: tipo errado",
        };
      await stamp("c1", "i2");
      return { ok: true, output: "" };
    });
    await source.start();
    await writeFile(join(root, "src", "a.ts"), "export const a: number = '';");
    await eventually(() => !!source.state.error);
    expect(source.state.error).toContain("TS2322");
    expect(source.state.interface).toBe(false);
    ok = true;
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;");
    await eventually(() => source.state.interface);
    expect(source.state.error).toBeUndefined();
  });
  it("ler um arquivo (a verificação de tipos lê todo o src) não dispara outro preparo", async () => {
    const { root } = await project();
    const file = join(root, "src", "a.ts");
    await writeFile(file, "export const a = 1;");
    let builds = 0;
    const { source } = mode(root, async () => {
      builds++;
      return { ok: true, output: "" };
    });
    await source.start();
    // Only the access time changes, as when the file is read.
    await utimes(file, new Date(), (await stat(file)).mtime);
    await new Promise((r) => setTimeout(r, 600));
    expect(builds).toBe(0);
    await writeFile(file, "export const a = 2;");
    await eventually(() => builds === 1);
  });
  it("percebe o build feito por um agente (npm run build) sem mudar src", async () => {
    const { root, stamp } = await project();
    const { source } = mode(root, async () => ({ ok: true, output: "" }));
    await source.start();
    await stamp("c1", "i9");
    await eventually(() => source.state.interface);
  });
  it("o reinício espera as tarefas terminarem e pode ser cancelado", async () => {
    const { root } = await project();
    let busy = true;
    const { source, calls } = mode(
      root,
      async () => ({ ok: true, output: "" }),
      () => busy,
    );
    await source.start();
    source.restart();
    expect(source.state.waiting).toBe(true);
    source.cancel();
    busy = false;
    await new Promise((r) => setTimeout(r, 2300));
    expect(calls.restart).toBe(0);
    busy = true;
    source.restart();
    busy = false;
    await eventually(() => calls.restart === 1, 4000);
  }, 10_000);
});
