import { spawn } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SourceState } from "../shared/types";
// Written last by scripts/build.mjs.
export interface BuildStamp {
  version: string;
  builtAt: string;
  core: string;
  interface: string;
}
// Running from the project folder instead of a packaged build: changes in
// src are built automatically, and a new build is applied by the user's
// click — the interface by reloading the window, the app core (main process
// and preload) by restarting once nothing is running.
export class SourceMode {
  state: SourceState = { building: false, interface: false, core: false };
  private loaded?: BuildStamp;
  private timer?: NodeJS.Timeout;
  private waiting?: NodeJS.Timeout;
  private again = false;
  private watchers: FSWatcher[] = [];
  // Last modification time of each entry in src.
  private mtimes = new Map<string, number>();
  constructor(
    public root: string,
    private options: {
      build: () => Promise<{ ok: boolean; output: string }>;
      busy: () => boolean;
      reload: () => void;
      restart: () => void;
      changed: () => void;
      // Quiet time after the last change before building.
      quietMs?: number;
    },
  ) {}
  async start() {
    this.loaded = await this.stamp();
    const src = join(this.root, "src");
    for (const file of await readdir(src, { recursive: true }))
      this.mtimes.set(file, await this.mtime(file));
    this.watchers.push(
      watch(src, { recursive: true }, (_, file) => void this.touched(file)),
      // Any build, including npm run build by an agent, rewrites the stamp.
      watch(join(this.root, "dist"), (_, file) => {
        if (file === "build.json") void this.compare();
      }),
    );
  }
  stop() {
    clearTimeout(this.timer);
    clearInterval(this.waiting);
    for (const w of this.watchers) w.close();
  }
  // On Windows the watcher also fires when a file is only read (the type
  // check reads all of src), which rebuilt everything a second time. Only a
  // new modification time, a new file or a deleted one counts.
  private async touched(file: string | null) {
    if (!file) return this.schedule();
    const mtime = await this.mtime(file);
    // A real write moves the time far more than the rounding of timestamps.
    if (Math.abs((this.mtimes.get(file) ?? NaN) - mtime) < 2) return;
    this.mtimes.set(file, mtime);
    this.schedule();
  }
  private mtime(file: string) {
    return stat(join(this.root, "src", file)).then(
      (s) => s.mtimeMs,
      () => -1,
    );
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.build(),
      this.options.quietMs ?? 4000,
    );
  }
  async build() {
    if (this.state.building) {
      this.again = true;
      return;
    }
    this.set({ building: true });
    const result = await this.options.build().catch((e: Error) => ({
      ok: false,
      output: e.message,
    }));
    // A failed build (often an edit still in progress) keeps the current
    // version; the next change tries again.
    this.set({
      building: false,
      error: result.ok ? undefined : result.output.trim().slice(-2000),
    });
    await this.compare();
    if (this.again) {
      this.again = false;
      this.schedule();
    }
  }
  async compare() {
    const current = await this.stamp();
    if (!current || !this.loaded) return;
    this.set({
      interface: current.interface !== this.loaded.interface,
      core: current.core !== this.loaded.core,
      builtAt: current.builtAt,
    });
  }
  // A new interface only: the window reloads and agents keep running.
  async reloadInterface() {
    if (this.state.core)
      throw new Error("O núcleo também mudou: reinicie o Codebit.");
    const current = await this.stamp();
    if (current && this.loaded)
      this.loaded = { ...this.loaded, interface: current.interface };
    this.set({ interface: false });
    this.options.reload();
  }
  // The core changed: restart as soon as nothing is running.
  restart() {
    if (!this.options.busy()) return this.options.restart();
    this.set({ waiting: true });
    clearInterval(this.waiting);
    this.waiting = setInterval(() => {
      if (this.options.busy()) return;
      clearInterval(this.waiting);
      this.options.restart();
    }, 2000);
  }
  cancel() {
    clearInterval(this.waiting);
    this.set({ waiting: false });
  }
  private async stamp(): Promise<BuildStamp | undefined> {
    try {
      return JSON.parse(
        await readFile(join(this.root, "dist", "build.json"), "utf8"),
      );
    } catch {
      return undefined;
    }
  }
  private set(patch: Partial<SourceState>) {
    this.state = { ...this.state, ...patch };
    this.options.changed();
  }
}
// Type check, then build, with the Electron binary acting as Node, so the
// app needs nothing else installed to rebuild itself.
export async function buildProject(root: string) {
  const run = (command: string, args: string[]) =>
    new Promise<{ code: number; output: string }>((resolve) => {
      const child = spawn(command, args, {
        cwd: root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
      });
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      child.on("error", (e) => resolve({ code: 1, output: e.message }));
      child.on("close", (code) => resolve({ code: code ?? 1, output }));
    });
  // TypeScript 7 is a native tsc.exe that its JS launcher starts without
  // hiding the console, which popped up a cmd window on every build. Start
  // it directly, hidden; older versions run the JS compiler.
  const native = join(
    root,
    "node_modules",
    "@typescript",
    `typescript-${process.platform}-${process.arch}`,
    "lib",
    process.platform === "win32" ? "tsc.exe" : "tsc",
  );
  const check = existsSync(native)
    ? await run(native, ["--noEmit"])
    : await run(process.execPath, [
        join(root, "node_modules", "typescript", "bin", "tsc"),
        "--noEmit",
      ]);
  if (check.code) return { ok: false, output: check.output };
  const built = await run(process.execPath, [
    join(root, "scripts", "build.mjs"),
  ]);
  return { ok: built.code === 0, output: built.output };
}
