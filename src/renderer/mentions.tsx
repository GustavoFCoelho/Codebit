import { useEffect, useState, type ReactNode } from "react";
import { defaultUrlTransform } from "react-markdown";
import { api } from "./api";
// Files the chat mentions become links: images open in the side panel, text
// and code in the file viewer, folders in Explorer, the rest with the
// default app. The main process finds each file, even when the agent wrote
// it relative to a subfolder, shortened with "…" or in Git Bash style.
const segment = "[\\p{L}\\p{N}_.@()+…-]+";
const extension = "\\.(?=[\\p{L}\\p{N}]{0,9}\\p{L})[\\p{L}\\p{N}]{1,10}";
const images = "\\.(?:png|jpe?g|gif|webp|bmp|svg)";
// In running text: absolute paths, ./ ~/ and /x/y paths, relative paths with
// a folder and an extension, and image names.
const pathMention = new RegExp(
  // Paths start at a word start, never inside dates or web addresses.
  "(?<![\\p{L}\\p{N}_.@+…:\\\\/-])(?:" +
    [
      `[A-Za-z]:[\\\\/](?:${segment}[\\\\/])*(?:${segment})?`,
      `(?:~|\\.{1,2})[\\\\/](?:${segment}[\\\\/])*${segment}`,
      `[\\\\/](?:${segment}[\\\\/])+${segment}`,
      `(?:${segment}[\\\\/])+${segment}${extension}`,
      `${segment}${images}`,
    ]
      .map((p) => `(?:${p})`)
      .join("|") +
    ")(?![\\p{L}\\p{N}_])",
  "giu",
);
const whole = new RegExp(`^(?:${pathMention.source})$`, "iu");
// A name alone (README.md) or a relative folder (dist/, src/main): linked in
// inline code only once the file is found.
const maybe = new RegExp(
  `^(?:${segment}${extension}|(?:${segment}[\\\\/])+(?:${segment})?)$`,
  "iu",
);
const openScheme = "codebit-open:";
const maybeScheme = "codebit-maybe:";
const web = /^(?:[a-z][\w+.-]*:\/\/|www\.)/i;
export const isImagePath = (text: string) => {
  const t = text.trim();
  return (
    /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(t) &&
    !/^(?:https?|data|blob|codebit):/i.test(t) &&
    !/[\n<>"|*?]/.test(t)
  );
};
// Opened in the side panel's file viewer when inside the task folder.
export const isTextPath = (path: string) =>
  /\.(?:txt|md|markdown|json|jsonc|ts|tsx|js|jsx|mjs|cjs|css|scss|less|html?|xml|ya?ml|toml|ini|cfg|conf|py|cs|cpp|cc|c|h|hpp|java|kt|go|rs|rb|php|lua|gd|shader|glsl|hlsl|sql|csv|log|sh|ps1|psm1|bat|cmd|gitignore|editorconfig|env\.example)$/i.test(
    path,
  ) || /(?:^|[\\/])(?:Dockerfile|Makefile|LICENSE|README)$/i.test(path);
// Sentence punctuation after a path is not part of it.
const trimPath = (text: string) => {
  let path = text.replace(/[.,;:!?]+$/, "");
  while (path.endsWith(")") && !path.includes("(")) path = path.slice(0, -1);
  return path;
};
// Splits text around file paths, leaving web addresses alone.
export function splitPaths(text: string) {
  const parts: (string | { path: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(pathMention)) {
    // The whole word around the match, to skip web addresses.
    const word = (text.slice(0, m.index).split(/\s/).pop() ?? "") + m[0];
    if (web.test(word)) continue;
    const path = trimPath(m[0]);
    if (!path || /^[\\/]+$/.test(path)) continue;
    parts.push(text.slice(last, m.index), { path });
    last = m.index + path.length;
  }
  parts.push(text.slice(last));
  return parts.filter((p) => p !== "");
}
// Only the image paths, the other paths kept as text.
export function splitImagePaths(text: string) {
  const parts: (string | { path: string })[] = [];
  for (const p of splitPaths(text)) {
    if (typeof p !== "string" && isImagePath(p.path)) parts.push(p);
    else {
      const piece = typeof p === "string" ? p : p.path;
      const last = parts.length - 1;
      if (typeof parts[last] === "string") parts[last] += piece;
      else parts.push(piece);
    }
  }
  return parts;
}
const decode = (url: string) => {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
};
// The local file a markdown link points to: absolute (D:/…, /D:/…),
// file://, ~/… or relative to the task folder, without line anchors such as
// #L12 or :12. Markdown encodes destinations, so C:\out arrives as C:%5Cout.
// Undefined for web addresses and in-page anchors.
export function linkedPath(url?: string) {
  if (!url || url.startsWith("#")) return undefined;
  if (url.startsWith(openScheme)) return decode(url.slice(openScheme.length));
  if (url.startsWith(maybeScheme)) return decode(url.slice(maybeScheme.length));
  const path = decode(url).trim();
  if (/^file:/i.test(path)) return path;
  if (/^[a-z][\w+.-]*:/i.test(path) && !/^[A-Za-z]:[\\/]/.test(path))
    return undefined;
  return path
    .replace(/^\/(?=[A-Za-z]:[\\/])/, "")
    .replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/, "");
}
// The local image a markdown link or image points to, if any.
export function linkedImage(url?: string) {
  const path = linkedPath(url);
  return path && isImagePath(path) ? path : undefined;
}
// Keeps local paths, which the default transform would drop as unsafe.
export const markdownUrl = (url: string) =>
  url.startsWith(openScheme) ||
  url.startsWith(maybeScheme) ||
  /^(?:[A-Za-z]:[\\/]|~[\\/]|file:)/i.test(decode(url))
    ? url
    : defaultUrlTransform(url);
// Remark plugin: file paths in text and in inline code turn into links.
export function remarkFilePaths() {
  const link = (scheme: string, path: string, children: any[]) => ({
    type: "link",
    url: scheme + encodeURIComponent(path),
    children,
  });
  const walk = (node: any) => {
    if (!Array.isArray(node.children)) return;
    node.children = node.children.flatMap((child: any) => {
      if (child.type === "text")
        return splitPaths(child.value).map((p) =>
          typeof p === "string"
            ? { type: "text", value: p }
            : link(openScheme, p.path, [{ type: "text", value: p.path }]),
        );
      if (child.type === "inlineCode") {
        const code = child.value.trim();
        const path = linkedPath(code) ?? code;
        if (!path || web.test(path) || /\s{2,}|\n/.test(path)) return [child];
        if (whole.test(path) || isImagePath(path))
          return [link(openScheme, path, [child])];
        if (!/\s/.test(path) && maybe.test(path))
          return [link(maybeScheme, path, [child])];
        return [child];
      }
      if (!["link", "linkReference", "code"].includes(child.type)) walk(child);
      return [child];
    });
  };
  return (tree: any) => walk(tree);
}
export const remarkImagePaths = remarkFilePaths;
// Where relative paths start: a task's folder, or a saved prompt run's.
export type PathBase = { id: string } | { cwd: string };
export interface ResolvedPath {
  path: string;
  kind: "file" | "dir";
  relative?: string;
}
// Checks of names in inline code, shared by every message on screen.
const checks = new Map<
  string,
  { at: number; found: Promise<ResolvedPath | null> }
>();
function check(base: PathBase, path: string) {
  const key = JSON.stringify(base) + "|" + path;
  const cached = checks.get(key);
  if (cached && Date.now() - cached.at < 20_000) return cached.found;
  const found = api<ResolvedPath | null>("file.resolve", {
    ...base,
    path,
    quiet: true,
  }).catch(() => null);
  checks.set(key, { at: Date.now(), found });
  return found;
}
// Right click on any link: open, show in folder, copy path or address.
export const linkMenu = (base: PathBase, target: string, local: boolean) =>
  api("link.menu", { ...base, target, local });
// Opens a local path without a handler from the chat: the file viewer and
// image panel belong to the task screen, so here it opens with its app.
const openLocal = (base: PathBase, path: string) =>
  api("file.open", { ...base, path });
// A markdown link: local files through onOpenPath (or their default app),
// web addresses in the browser.
export function MarkdownLink({
  href,
  children,
  base,
  run,
  onOpenPath,
}: {
  href?: string;
  children?: ReactNode;
  base: PathBase;
  run: any;
  onOpenPath?: (path: string) => void;
}) {
  const path = linkedPath(href);
  const [found, setFound] = useState<ResolvedPath | null | undefined>(
    undefined,
  );
  const unsure = !!href?.startsWith(maybeScheme);
  useEffect(() => {
    if (!unsure || !path) return;
    let live = true;
    void check(base, path).then((r) => live && setFound(r));
    return () => {
      live = false;
    };
  }, [unsure, path, JSON.stringify(base)]);
  // A name in inline code that is not a file stays plain code.
  if (unsure && !found) return <>{children}</>;
  return (
    <a
      href="#"
      className={path ? "file-link" : undefined}
      title={
        path
          ? `${found?.path ?? path} · ${isImagePath(path) ? "abre no painel lateral" : "clique para abrir; botão direito para mais opções"}`
          : href
      }
      onClick={(e) => {
        e.preventDefault();
        if (path)
          void run(() =>
            onOpenPath ? onOpenPath(path) : openLocal(base, path),
          );
        else if (href) void run(() => api("external.open", { url: href }));
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (path || href) void run(() => linkMenu(base, path ?? href!, !!path));
      }}
    >
      {children}
    </a>
  );
}
// Plain text (tool activity) with file paths as links.
export function LinkedText({
  text,
  onOpen,
  onMenu,
}: {
  text: string;
  onOpen: (path: string) => void;
  onMenu?: (path: string) => void;
}) {
  return (
    <>
      {splitPaths(text).map((p, i) =>
        typeof p === "string" ? (
          p
        ) : (
          <a
            key={i}
            href="#"
            className="file-link"
            title={`${p.path} · clique para abrir`}
            onClick={(e) => {
              e.preventDefault();
              onOpen(p.path);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onMenu?.(p.path);
            }}
          >
            {p.path}
          </a>
        ),
      )}
    </>
  );
}
