import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, join } from "node:path";
import { capture } from "./process";
export async function within(root: string, path: string) {
  const base = await realpath(root),
    target = await realpath(resolve(root, path));
  const rel = relative(base, target);
  if (
    rel === ".." ||
    rel.startsWith("..\\") ||
    rel.startsWith("../") ||
    isAbsolute(rel)
  )
    throw new Error("O arquivo está fora da pasta de trabalho.");
  return target;
}
export async function isGit(cwd: string) {
  try {
    return (
      (
        await capture("git", ["rev-parse", "--is-inside-work-tree"], cwd)
      ).stdout.trim() === "true"
    );
  } catch {
    return false;
  }
}
export async function createWorktree(cwd: string, target: string, id: string) {
  const r = await capture(
    "git",
    ["worktree", "add", "-b", `codebit/${id.slice(0, 8)}`, target, "HEAD"],
    cwd,
    30000,
  );
  if (r.code !== 0)
    throw new Error(
      r.stderr ||
        "Não foi possível criar a worktree. O repositório precisa ter ao menos um commit.",
    );
}
// The branch stays in the repository, with any commits made in the worktree.
export async function removeWorktree(repo: string, target: string) {
  const r = await capture(
    "git",
    ["worktree", "remove", "--force", target],
    repo,
    30000,
  );
  if (r.code !== 0)
    throw new Error(r.stderr || "Não foi possível remover a worktree.");
}
export async function files(cwd: string, sub = "") {
  const root = await within(cwd, sub);
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        ![".git", "node_modules", "dist", ".next", ".venv"].includes(e.name) &&
        !e.isSymbolicLink(),
    )
    .slice(0, 500)
    .map((e) => ({
      name: e.name,
      path: relative(cwd, join(root, e.name)),
      directory: e.isDirectory(),
    }))
    .sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name),
    );
}
export async function fileContent(cwd: string, path: string) {
  const target = await within(cwd, path);
  if ((await stat(target)).size > 2_000_000)
    throw new Error("Prévia limitada a arquivos de até 2 MB.");
  return readFile(target, "utf8");
}
export async function changes(cwd: string) {
  if (!(await isGit(cwd)))
    return { git: false, diff: "", status: "", truncated: false };
  const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
  const diffOptions = { maxOutputBytes: 512_000, truncate: true };
  const [diff, status] = await Promise.all([
    capture("git", [...diffArgs, "HEAD", "--"], cwd, 8000, diffOptions),
    capture("git", ["status", "--short"], cwd, 8000, {
      maxOutputBytes: 128_000,
      truncate: true,
    }),
  ]);
  // A truncated preview is intentional; don't launch the same large diff again.
  const preview =
    diff.code !== 0 && !diff.truncated
      ? await capture("git", [...diffArgs, "--"], cwd, 8000, diffOptions)
      : diff;
  const completeLines = (text: string, truncated: boolean) =>
    truncated ? text.slice(0, text.lastIndexOf("\n") + 1) : text;
  return {
    git: true,
    diff: completeLines(preview.stdout, preview.truncated),
    status: completeLines(status.stdout, status.truncated),
    truncated: preview.truncated || status.truncated,
  };
}
