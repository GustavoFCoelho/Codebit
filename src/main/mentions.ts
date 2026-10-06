import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
// Paths the agents write in the chat, as they write them: relative to the
// task folder or to a subfolder they were in, shortened with "…", or in the
// Git Bash and WSL styles (/d/Git/…, /mnt/d/…).
export function mentionedPath(base: string, raw: string) {
  const text = raw.trim();
  if (/^file:/i.test(text)) return fileURLToPath(text);
  if (/^~[\\/]/.test(text)) return join(homedir(), text.slice(2));
  const drive = /^\/(?:mnt\/)?([a-zA-Z])(?=\/|$)(.*)$/.exec(text);
  if (drive && process.platform === "win32")
    return resolve(`${drive[1].toUpperCase()}:\\`, "." + (drive[2] || "/"));
  return resolve(base, text);
}
// Folders never searched: dependencies, version control and caches.
const skipped = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".next",
  ".turbo",
  ".gradle",
]);
// Files and folders under a folder, relative to it, kept for a short while
// so a long chat checks its mentions against one listing.
const indexes = new Map<string, { at: number; paths: Promise<string[]> }>();
function listing(root: string, fresh = false) {
  const cached = indexes.get(root);
  if (cached && !fresh && Date.now() - cached.at < 30_000) return cached;
  const paths = (async () => {
    const found: string[] = [];
    const deadline = Date.now() + 2000;
    let folders = [""];
    for (let depth = 0; depth < 10 && folders.length; depth++) {
      const next: string[] = [];
      for (const folder of folders) {
        if (found.length > 50_000 || Date.now() > deadline) return found;
        const entries = await readdir(join(root, folder), {
          withFileTypes: true,
        }).catch(() => []);
        for (const e of entries) {
          const path = folder ? join(folder, e.name) : e.name;
          found.push(path);
          if (e.isDirectory() && !skipped.has(e.name)) next.push(path);
        }
      }
      folders = next;
    }
    return found;
  })();
  const entry = { at: Date.now(), paths };
  indexes.set(root, entry);
  return entry;
}
const segments = (path: string) => path.split(/[\\/]+/).filter(Boolean);
const shortened = (segment: string) =>
  segment === "…" || /^\.{3,}$/.test(segment);
// Where a mentioned path really is, or undefined. A path that does not
// exist as written is searched by its ending inside the folder: several
// matches go to the most recently changed; a bare name must be unique.
export async function findMentioned(base: string, raw: string) {
  const direct = mentionedPath(base, raw);
  if (existsSync(direct)) return direct;
  const parts = segments(raw.trim().replace(/^file:\/+/i, ""));
  const cut = parts.findLastIndex(shortened);
  let root = base;
  // An existing folder before the "…" is where to look.
  if (cut > 0) {
    const before = mentionedPath(base, parts.slice(0, cut).join(sep));
    if (existsSync(before)) root = before;
  }
  const tail = parts
    .slice(cut + 1)
    .filter((p) => p !== "." && !/^[A-Za-z]:$/.test(p));
  if (!tail.length || tail.includes("..")) return undefined;
  // The whole ending first, then shorter ones down to folder and name.
  const search = (paths: string[]) => {
    for (
      let start = 0;
      start <= tail.length - Math.min(2, tail.length);
      start++
    ) {
      const ending = tail.slice(start).join(sep).toLowerCase();
      const found = paths.filter((p) => {
        const path = p.toLowerCase();
        return path === ending || path.endsWith(sep + ending);
      });
      if (found.length) return found;
    }
    return [];
  };
  let index = listing(root);
  let matches = search(await index.paths);
  // A file made after the listing: list once more.
  if (!matches.length && Date.now() - index.at > 2000) {
    index = listing(root, true);
    matches = search(await index.paths);
  }
  if (!matches.length) return undefined;
  if (tail.length === 1 && cut < 0 && matches.length > 1) return undefined;
  if (matches.length === 1) return join(root, matches[0]);
  const times = await Promise.all(
    matches.map((p) =>
      stat(join(root, p)).then(
        (s) => s.mtimeMs,
        () => 0,
      ),
    ),
  );
  return join(root, matches[times.indexOf(Math.max(...times))]);
}
export interface ResolvedMention {
  path: string;
  kind: "file" | "dir";
  // Relative to the task folder, when inside it.
  relative?: string;
}
export async function resolveMention(
  base: string,
  raw: string,
): Promise<ResolvedMention | undefined> {
  const path = await findMentioned(base, raw);
  if (!path) return undefined;
  const info = await stat(path).catch(() => undefined);
  if (!info) return undefined;
  const rel = relative(base, path);
  const inside = rel && !rel.startsWith("..") && !isAbsolute(rel);
  return {
    path,
    kind: info.isDirectory() ? "dir" : "file",
    relative: inside ? rel : undefined,
  };
}
// Forgets the cached listings, after the agent changed files.
export function forgetListings() {
  indexes.clear();
}
