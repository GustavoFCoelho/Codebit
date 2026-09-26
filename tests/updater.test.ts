import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findUpdate, newer, Updater } from "../src/main/updater";
const folders: string[] = [];
afterEach(async () => {
  for (const f of folders.splice(0))
    await rm(f, { recursive: true, force: true });
});
async function releases(
  builds: Record<string, { body: string; sha?: string }>,
) {
  const folder = await mkdtemp(join(tmpdir(), "codebit-release-"));
  folders.push(folder);
  for (const [version, b] of Object.entries(builds)) {
    const file = join(folder, `Codebit-${version}-Windows.exe`);
    await writeFile(file, b.body);
    if (b.sha !== undefined)
      await writeFile(
        file + ".sha256",
        `${b.sha.toUpperCase()}  Codebit-${version}-Windows.exe\n`,
      );
  }
  return folder;
}
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const complete = (body: string) => ({ body, sha: hash(body) });
async function eventually(check: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condição não atendida");
    await new Promise((r) => setTimeout(r, 50));
  }
}
describe("atualização pela pasta de versões", () => {
  it("compara versões numericamente", () => {
    expect(newer("0.2.10", "0.2.9")).toBe(true);
    expect(newer("0.3.0", "0.2.99")).toBe(true);
    expect(newer("0.2.3", "0.2.3")).toBe(false);
    expect(newer("0.2.2", "0.2.3")).toBe(false);
  });
  it("escolhe a versão nova mais recente que está completa", async () => {
    const folder = await releases({
      "0.2.3": complete("atual"),
      "0.2.4": complete("nova"),
      // Still being written: no .sha256 yet.
      "0.2.5": { body: "pela metade" },
      // Hash that does not match the file.
      "0.3.0": { body: "corrompida", sha: hash("outra coisa") },
      "0.1.9": complete("antiga"),
    });
    expect(await findUpdate(folder, "0.2.3")).toEqual({
      version: "0.2.4",
      path: join(folder, "Codebit-0.2.4-Windows.exe"),
    });
    expect(await findUpdate(folder, "0.2.4")).toBeUndefined();
  });
  it("só troca de versão quando nada está rodando, e dá para cancelar", async () => {
    const folder = await releases({ "0.2.4": complete("nova") });
    let busy = true;
    const launched: [string, string[]][] = [];
    let quits = 0;
    const updater = new Updater("0.2.3", {
      folder: () => folder,
      busy: () => busy,
      launch: (path, args) => launched.push([path, args]),
      quit: () => quits++,
      changed: () => {},
    });
    try {
      await updater.check();
      expect(updater.state.available?.version).toBe("0.2.4");
      await updater.apply();
      expect(updater.state.status).toBe("waiting");
      updater.cancel();
      busy = false;
      await new Promise((r) => setTimeout(r, 2300));
      expect(launched).toEqual([]);
      busy = true;
      await updater.apply();
      busy = false;
      await eventually(() => quits === 1, 4000);
      expect(launched).toEqual([
        [
          join(folder, "Codebit-0.2.4-Windows.exe"),
          [`--after-update=${process.pid}`],
        ],
      ]);
      expect(updater.state.status).toBe("applying");
    } finally {
      updater.stop();
    }
  }, 15_000);
  it("não abre uma versão que mudou depois de encontrada", async () => {
    const folder = await releases({ "0.2.4": complete("nova") });
    const launched: string[] = [];
    const updater = new Updater("0.2.3", {
      folder: () => folder,
      busy: () => false,
      launch: (path) => launched.push(path),
      quit: () => {},
      changed: () => {},
    });
    await updater.check();
    await writeFile(join(folder, "Codebit-0.2.4-Windows.exe"), "trocada");
    await updater.apply();
    expect(launched).toEqual([]);
    expect(updater.state).toMatchObject({ status: "idle" });
    expect(updater.state.error).toContain("mudou");
    updater.stop();
  });
});
