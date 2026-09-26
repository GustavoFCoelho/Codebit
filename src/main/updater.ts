import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { UpdateState } from "../shared/types";
// Self update from a folder of portable builds (the project's release folder
// by default): the user clicks, Codebit waits for idle, starts the new build
// and quits; the new build waits for this process to exit before starting.
const build = /^Codebit-(\d+)\.(\d+)\.(\d+)-Windows\.exe$/i;
export function newer(a: string, b: string) {
  const x = a.split(".").map(Number),
    y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
function sha256(path: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}
// The newest complete build newer than the running one. A build is complete
// once its .sha256 exists and matches, so one still being written is skipped.
export async function findUpdate(
  folder: string,
  current: string,
  hashes = new Map<string, string>(),
) {
  const builds = (await readdir(folder))
    .map((name) => ({ name, m: build.exec(name) }))
    .filter((b) => b.m)
    .map((b) => ({
      version: `${b.m![1]}.${b.m![2]}.${b.m![3]}`,
      path: join(folder, b.name),
    }))
    .filter((b) => newer(b.version, current))
    .sort((a, b) => (newer(a.version, b.version) ? -1 : 1));
  for (const b of builds) {
    const expected = (
      await readFile(b.path + ".sha256", "utf8").catch(() => "")
    )
      .trim()
      .split(/\s+/)[0]
      .toLowerCase();
    if (!expected) continue;
    const s = await stat(b.path);
    // Hashing ~100 MB every minute would be wasteful: cache by file state.
    const key = `${b.path}|${s.size}|${s.mtimeMs}`;
    if (!hashes.has(key)) hashes.set(key, await sha256(b.path));
    if (hashes.get(key) === expected) return b;
  }
  return undefined;
}
export class Updater {
  state: UpdateState;
  private hashes = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private waiting?: NodeJS.Timeout;
  constructor(
    current: string,
    private options: {
      folder: () => string | undefined;
      // Work a restart would cut (running turns, approvals, background).
      busy: () => boolean;
      launch: (path: string, args: string[]) => void;
      quit: () => void;
      changed: () => void;
    },
  ) {
    this.state = { current, status: "idle" };
  }
  start() {
    void this.check();
    this.timer = setInterval(() => void this.check(), 60_000);
  }
  stop() {
    clearInterval(this.timer);
    clearInterval(this.waiting);
  }
  async check() {
    const folder = this.options.folder();
    try {
      const available = folder
        ? await findUpdate(folder, this.state.current, this.hashes)
        : undefined;
      this.set({ folder, available, error: undefined });
    } catch (e) {
      this.set({ folder, available: undefined, error: (e as Error).message });
    }
    return this.state;
  }
  // Updates now, or as soon as nothing is running.
  async apply() {
    if (!this.state.available) throw new Error("Nenhuma versão nova.");
    if (!this.options.busy()) return this.launch();
    this.set({ status: "waiting" });
    clearInterval(this.waiting);
    this.waiting = setInterval(() => {
      if (!this.options.busy()) void this.launch();
    }, 2000);
    return this.state;
  }
  cancel() {
    clearInterval(this.waiting);
    this.set({ status: "idle" });
    return this.state;
  }
  private async launch() {
    clearInterval(this.waiting);
    // The build may have changed since it was found; check it again.
    const target = this.state.available;
    await this.check();
    if (!target || this.state.available?.path !== target.path) {
      this.set({
        status: "idle",
        error: "A versão nova mudou ou sumiu. Verifique de novo.",
      });
      return this.state;
    }
    this.set({ status: "applying" });
    this.options.launch(target.path, [`--after-update=${process.pid}`]);
    this.options.quit();
    return this.state;
  }
  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    this.options.changed();
  }
}
// Used by a new build started by the updater: the old one must release the
// single-instance lock and its files first.
export async function waitForExit(pid: number, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
