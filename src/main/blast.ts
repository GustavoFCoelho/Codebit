import { lstat, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { capture } from "./process";
import type { BlastPreview, DeleteGuardSettings } from "../shared/types";
import { formatBytes } from "../shared/types";
// Blast radius: before a command that deletes files or throws away work runs,
// what it reaches (files, folders, size, uncommitted changes), so a cleanup
// that grew beyond what was asked is caught before it happens.

// Heredoc bodies (python - <<'EOF' … EOF) are input for another program, not
// commands: a Python "del x" is no del command.
function withoutHeredocs(text: string) {
  const out: string[] = [];
  let end: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (end !== undefined) {
      if (line.trim() === end) end = undefined;
      continue;
    }
    out.push(line);
    const m = /(?:^|[\s>])<<-?\s*(['"]?)([\w.-]+)\1/.exec(line);
    if (m) end = m[2];
  }
  return out.join("\n");
}
// A command line as simple commands and their words. Quotes group words;
// backslashes stay as they are (Windows paths).
export function commands(text: string): string[][] {
  const result: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  const push = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const end = () => {
    push();
    if (words.length) result.push(words);
    words = [];
  };
  for (const c of withoutHeredocs(text)) {
    if (quote) {
      if (c === quote) quote = "";
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (";|&\n".includes(c)) end();
    else if (/\s/.test(c)) push();
    else {
      word += c;
      started = true;
    }
  }
  end();
  return result;
}
const program = (word: string) =>
  basename(word.toLowerCase().replace(/\\/g, "/")).replace(/\.exe$/, "");
// The commands inside shells: pwsh -Command '…', cmd /c …, bash -c '…'.
function flatten(line: string, depth = 0): string[][] {
  const out: string[][] = [];
  for (const words of commands(line)) {
    const name = program(words[0]);
    const at = (test: (w: string) => boolean) => words.findIndex(test);
    let inner = -1;
    if (name === "pwsh" || name === "powershell")
      inner = at((w) => /^-(c|command)$/i.test(w));
    else if (name === "cmd") inner = at((w) => /^\/[ck]$/i.test(w));
    else if (["bash", "sh", "zsh"].includes(name))
      inner = at((w) => /^-[a-z]*c$/.test(w));
    if (inner >= 0 && depth < 3)
      out.push(...flatten(words.slice(inner + 1).join(" "), depth + 1));
    else if (["sudo", "command", "builtin", "nohup"].includes(name))
      out.push(...flatten(words.slice(1).join(" "), depth + 1));
    else out.push(words);
  }
  return out;
}
type Operation =
  | { kind: "delete"; paths: string[]; filtered?: boolean }
  | { kind: "git"; action: "clean" | "discard"; args: string[]; cwd?: string };
// PowerShell parameters of Remove-Item that take a value.
const valued = new Set([
  "path",
  "literalpath",
  "include",
  "exclude",
  "filter",
  "erroraction",
  "ea",
  "warningaction",
  "wa",
  "credential",
  "stream",
]);
function operation(words: string[]): Operation | undefined {
  const name = program(words[0]);
  const args = words.slice(1);
  if (name === "remove-item" || name === "ri") {
    const paths: string[] = [];
    let filtered = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!a.startsWith("-")) {
        paths.push(...a.split(","));
        continue;
      }
      const [key, inline] = a.slice(1).toLowerCase().split(/:(.*)/s);
      if (!valued.has(key)) continue;
      const value = inline ?? args[++i] ?? "";
      if (key === "path" || key === "literalpath")
        paths.push(...value.split(","));
      if (["include", "exclude", "filter"].includes(key)) filtered = true;
    }
    return { kind: "delete", paths: paths.filter(Boolean), filtered };
  }
  // cmd's del/rd take /s /q flags; posix rm and the PowerShell aliases take -r.
  if (["rm", "unlink", "del", "erase", "rd", "rmdir"].includes(name)) {
    const cmdFlags = ["del", "erase", "rd", "rmdir"].includes(name);
    const all = args.indexOf("--");
    return {
      kind: "delete",
      paths: args.filter(
        (a, i) =>
          (all >= 0 && i > all) ||
          (!a.startsWith("-") && !(cmdFlags && /^\/[a-z](:\S*)?$/i.test(a))),
      ),
    };
  }
  // … | xargs rm: the paths come from another command.
  if (
    name === "xargs" &&
    args.some((a) => ["rm", "del", "rmdir", "unlink"].includes(program(a)))
  )
    return { kind: "delete", paths: [] };
  if (name === "find" && args.includes("-delete"))
    return {
      kind: "delete",
      paths: [args[0] && !args[0].startsWith("-") ? args[0] : "."],
      filtered: true,
    };
  if (name === "git") {
    let cwd: string | undefined;
    const rest = [...args];
    while (rest[0]?.startsWith("-")) {
      const flag = rest.shift()!;
      if (flag === "-C") cwd = rest.shift();
    }
    const [sub, ...sargs] = rest;
    if (
      sub === "clean" &&
      sargs.some((a) => a === "--force" || /^-[a-zA-Z]*f/.test(a))
    )
      return { kind: "git", action: "clean", args: sargs, cwd };
    if (sub === "reset" && sargs.includes("--hard"))
      return { kind: "git", action: "discard", args: [], cwd };
    if (sub === "checkout" && sargs.includes("--"))
      return {
        kind: "git",
        action: "discard",
        args: sargs.slice(sargs.indexOf("--") + 1),
        cwd,
      };
    if (sub === "checkout" && sargs.length === 1 && sargs[0] === ".")
      return { kind: "git", action: "discard", args: ["."], cwd };
    if (sub === "restore" && !sargs.some((a) => a.startsWith("--staged")))
      return {
        kind: "git",
        action: "discard",
        args: sargs.filter((a) => !a.startsWith("-")),
        cwd,
      };
  }
}
// Variables the command itself sets (B4=…, export X=…, $x = …); null when the
// value is computed at run time.
type Vars = Map<string, string | null>;
// /d/Agents/… (Git Bash) and /mnt/d/… (WSL) are D:/Agents/… on Windows.
const windowsPath = (p: string) =>
  process.platform === "win32"
    ? p.replace(
        /^\/(?:mnt\/)?([a-zA-Z])(?=\/|$)/,
        (_, d: string) => `${d.toUpperCase()}:`,
      )
    : p;
// A path as the shell would see it: ~ and variables expanded. Anything
// computed at run time makes the scope unknown.
function expand(path: string, vars: Vars): string | { unknown: string } {
  let value = path.replace(/^~(?=$|[\\/])/, homedir());
  let missing = "";
  value = value.replace(
    /\$env:(\w+)|%(\w+)%|\$\{(\w+)\}|\$(\w+)/gi,
    (all, env, cmd, braced, plain) => {
      const name: string = env ?? cmd ?? braced ?? plain;
      const own = env
        ? vars.get("env:" + name.toLowerCase())
        : (vars.get(name) ?? vars.get(name.toLowerCase()));
      const found = own === undefined ? process.env[name] : own;
      if (found == null) missing ||= all;
      return found ?? all;
    },
  );
  if (missing)
    return { unknown: `o caminho usa ${missing}, que só existe na hora` };
  if (/[`$]/.test(value))
    return { unknown: `o caminho ${path} é calculado na hora` };
  return windowsPath(value);
}
// What a simple command does to the variables and the folder of the ones
// after it; true when it was only that.
function track(words: string[], vars: Vars, folder: { dir: string | null }) {
  const set = (name: string, raw: string) => {
    const value = expand(raw, vars);
    vars.set(name, typeof value === "string" ? value : null);
  };
  const assignment = /^([A-Za-z_]\w*)=(.*)$/s;
  const name = program(words[0]);
  if (words.every((w) => assignment.test(w))) {
    for (const w of words) {
      const [, key, value] = assignment.exec(w)!;
      set(key, value);
    }
    return true;
  }
  if (["export", "set", "declare", "local"].includes(name)) {
    for (const w of words.slice(1)) {
      const m = assignment.exec(w);
      if (m) set(m[1], m[2]);
    }
    return true;
  }
  // PowerShell: $x = "…", $env:X = "…"
  const ps = /^\$(env:)?([A-Za-z_]\w*)$/i.exec(words[0]);
  if (ps && words[1] === "=") {
    const key = (ps[1] ? "env:" : "") + ps[2].toLowerCase();
    if (words.length === 3) set(key, words[2]);
    else vars.set(key, null);
    return true;
  }
  // A loop variable takes values only known at run time.
  if (name === "for" && words.includes("in")) {
    vars.set(words[1], null);
    return true;
  }
  if (["cd", "chdir", "pushd", "set-location", "sl"].includes(name)) {
    const target = words
      .slice(1)
      .find((w) => !w.startsWith("-") && !/^\/d$/i.test(w));
    if (!target) return true;
    const value = expand(target, vars);
    folder.dir =
      typeof value === "string" && folder.dir !== null
        ? resolve(folder.dir, value)
        : null;
    return true;
  }
  return false;
}
const keywords = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
  "time",
  "{",
  "}",
]);
const wildcard = /[*?[]/;
async function matches(path: string, cwd: string) {
  const full = resolve(cwd, path);
  if (!wildcard.test(basename(full))) return [full];
  if (wildcard.test(dirname(full))) return undefined;
  const pattern = new RegExp(
    "^" +
      basename(full)
        .replace(/[.+^${}()|\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
    "i",
  );
  const names = await readdir(dirname(full)).catch(() => []);
  return names
    .filter((n) => pattern.test(n))
    .map((n) => join(dirname(full), n));
}
interface Size {
  files: number;
  dirs: number;
  bytes: number;
  partial: boolean;
}
// Files, folders and bytes under a path, without following links. Stops at
// a deadline or a count, and says so.
async function measure(path: string, budget: { until: number; left: number }) {
  const size: Size = { files: 0, dirs: 0, bytes: 0, partial: false };
  const walk = async (p: string) => {
    if (Date.now() > budget.until || budget.left <= 0) {
      size.partial = true;
      return;
    }
    budget.left--;
    const info = await lstat(p).catch(() => undefined);
    if (!info) return;
    if (info.isDirectory() && !info.isSymbolicLink()) {
      size.dirs++;
      for (const name of await readdir(p).catch(() => [] as string[]))
        await walk(join(p, name));
    } else {
      size.files++;
      size.bytes += info.size;
    }
  };
  await walk(path);
  return size;
}
const within = (root: string, p: string) => {
  const rel = relative(root, p);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
};
// Caches and scratch folders: deleting them is routine, so they do not count
// toward the limits, nor as outside the task folder.
const scratch = new Set([
  "tmp",
  "temp",
  ".tmp",
  "cache",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "node_modules",
]);
function temporary(path: string, cwd: string) {
  const roots = [tmpdir(), process.env.TEMP, process.env.TMP].filter(
    (r): r is string => !!r,
  );
  // A task that works inside the system temp folder owns what is there.
  const inTemp = (p: string) =>
    roots.some((root) => within(root, p) || relative(root, p) === "");
  if (!inTemp(cwd) && inTemp(path)) return true;
  return (
    within(cwd, path) &&
    relative(cwd, path)
      .split(/[\\/]/)
      .some((part) => scratch.has(part.toLowerCase()))
  );
}
const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;
// What a command would delete or discard; undefined when it does neither.
export async function blastRadius(
  command: string,
  cwd: string,
): Promise<BlastPreview | undefined> {
  const vars: Vars = new Map();
  const folder: { dir: string | null } = { dir: cwd };
  const budget = { until: Date.now() + 4000, left: 300_000 };
  const targets: string[] = [];
  const unknown = new Set<string>();
  const git: string[] = [];
  let filtered = false;
  let found = false;
  // A cd inside ( … ) does not reach the commands after the subshell.
  const subshells: (string | null)[] = [];
  // Subshells closed by the previous command end before this one.
  let closing = 0;
  for (const raw of flatten(command)) {
    for (; closing > 0 && subshells.length; closing--)
      folder.dir = subshells.pop()!;
    closing = 0;
    let words = [...raw];
    let opens = 0;
    while (words[0]?.startsWith("(")) {
      words[0] = words[0].slice(1);
      opens++;
      if (!words[0]) words.shift();
    }
    let closes = 0;
    while (words.length && /^[^(]*\)$/.test(words[words.length - 1])) {
      words[words.length - 1] = words[words.length - 1].slice(0, -1);
      closes++;
      if (!words[words.length - 1]) words.pop();
    }
    for (let i = 0; i < opens; i++) subshells.push(folder.dir);
    // Shell keywords before a command: if rm …; then rm …; do rm …
    while (words.length && keywords.has(words[0])) words.shift();
    closing = closes;
    if (!words.length || track(words, vars, folder)) continue;
    // NAME=value cmd: the variables are for that command alone.
    const start = words.findIndex((w) => !/^[A-Za-z_]\w*=/.test(w));
    const op = start >= 0 ? operation(words.slice(start)) : undefined;
    if (!op) continue;
    found = true;
    if (op.kind === "delete") {
      filtered ||= !!op.filtered;
      if (!op.paths.length) unknown.add("o comando não diz o que apaga");
      for (const raw of op.paths) {
        const path = expand(raw, vars);
        if (typeof path !== "string") {
          unknown.add(path.unknown);
          continue;
        }
        if (folder.dir === null && !isAbsolute(path)) {
          unknown.add("o comando muda para uma pasta calculada na hora");
          continue;
        }
        const listed = await matches(path, folder.dir ?? cwd);
        if (!listed) unknown.add(`curingas em pastas intermediárias (${raw})`);
        else targets.push(...listed);
      }
      continue;
    }
    if (folder.dir === null) {
      unknown.add("o comando muda para uma pasta calculada na hora");
      continue;
    }
    const where = op.cwd ? resolve(folder.dir, op.cwd) : folder.dir;
    if (op.action === "clean") {
      // The same scope as asked (-d folders, -x/-X ignored files), as a dry run.
      const letters = op.args
        .filter((a) => /^-[a-zA-Z]+$/.test(a))
        .join("")
        .replace(/-/g, "");
      const flags = [...new Set(letters)]
        .filter((l) => "dxX".includes(l))
        .map((l) => "-" + l);
      const paths = op.args
        .slice(op.args.indexOf("--") + 1)
        .filter((a) => !a.startsWith("-"));
      const r = await capture(
        "git",
        ["clean", "-n", ...flags, "--", ...paths],
        where,
      ).catch(() => undefined);
      for (const line of r?.stdout.split(/\r?\n/) ?? []) {
        const m = /^Would remove (.+)$/.exec(line.trim());
        if (m) targets.push(resolve(where, m[1]));
      }
    } else {
      const r = await capture(
        "git",
        ["status", "--porcelain", "--untracked-files=no", "--", ...op.args],
        where,
      ).catch(() => undefined);
      for (const line of r?.stdout.split(/\r?\n/) ?? [])
        if (line.trim()) git.push(line.slice(3));
    }
  }
  if (!found) return;
  // Each target, and for a single folder its heaviest contents.
  const sizes: { path: string; size: Size; dir: boolean }[] = [];
  for (const path of [...new Set(targets)]) {
    const info = await lstat(path).catch(() => undefined);
    if (!info) continue;
    sizes.push({
      path,
      size: await measure(path, budget),
      dir: info.isDirectory() && !info.isSymbolicLink(),
    });
  }
  const sum = (list: typeof sizes) =>
    list.reduce(
      (t, s) => ({
        files: t.files + s.size.files,
        dirs: t.dirs + s.size.dirs,
        bytes: t.bytes + s.size.bytes,
        partial: t.partial || s.size.partial,
      }),
      { files: 0, dirs: 0, bytes: 0, partial: false },
    );
  const total = sum(sizes);
  const scratchSize = sum(sizes.filter((s) => temporary(s.path, cwd)));
  let shown = sizes;
  if (sizes.length === 1 && sizes[0].dir && !total.partial) {
    const inner: typeof sizes = [];
    for (const name of await readdir(sizes[0].path).catch(
      () => [] as string[],
    )) {
      const path = join(sizes[0].path, name);
      const info = await lstat(path).catch(() => undefined);
      if (info)
        inner.push({
          path,
          size: await measure(path, budget),
          dir: info.isDirectory() && !info.isSymbolicLink(),
        });
    }
    if (inner.length) shown = inner;
  }
  shown = [...shown].sort((a, b) => b.size.bytes - a.size.bytes);
  const outside = sizes.some(
    (s) => !within(cwd, s.path) && !temporary(s.path, cwd),
  );
  const parts: string[] = [];
  if (sizes.length)
    parts.push(
      `${filtered ? "Pode apagar até " : "Apaga "}${count(total.files, "arquivo", "arquivos")} e ${count(total.dirs, "pasta", "pastas")} · ${formatBytes(total.bytes)}${total.partial ? " ou mais" : ""}`,
    );
  else if (!git.length)
    parts.push(
      unknown.size
        ? "Não dá para medir o que o comando apaga"
        : "O que o comando apaga não existe",
    );
  if (git.length)
    parts.push(
      `${parts.length ? "descarta" : "Descarta"} alterações não salvas no Git em ${count(git.length, "arquivo", "arquivos")}`,
    );
  return {
    summary: parts.join("; "),
    files: total.files,
    dirs: total.dirs,
    bytes: total.bytes,
    entries: shown.slice(0, 10).map((s) => ({
      path: within(cwd, s.path) ? relative(cwd, s.path) : s.path,
      bytes: s.size.bytes,
      dir: s.dir,
    })),
    more: Math.max(0, shown.length - 10),
    outside,
    ...(scratchSize.files || scratchSize.dirs
      ? { temporary: { files: scratchSize.files, bytes: scratchSize.bytes } }
      : {}),
    ...(total.partial ? { partial: true } : {}),
    ...(filtered ? { filtered: true } : {}),
    ...(unknown.size ? { unknown: [...unknown].join("; ") } : {}),
    ...(git.length
      ? { git: git.slice(0, 10), gitMore: Math.max(0, git.length - 10) }
      : {}),
  };
}
// Whether a preview is worth stopping for, with the user's limits. Caches
// and scratch folders do not count.
export function risky(preview: BlastPreview, limits: DeleteGuardSettings) {
  const files = preview.files - (preview.temporary?.files ?? 0);
  const bytes = preview.bytes - (preview.temporary?.bytes ?? 0);
  return (
    !!preview.unknown ||
    preview.outside ||
    !!preview.git?.length ||
    files >= limits.files ||
    bytes >= limits.megabytes * 1024 * 1024
  );
}
// Worth showing with an approval already on screen.
export const meaningful = (preview: BlastPreview) =>
  preview.files + preview.dirs > 0 ||
  !!preview.git?.length ||
  !!preview.unknown ||
  preview.outside;
