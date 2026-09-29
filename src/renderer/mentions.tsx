import type { ReactNode } from "react";
import { defaultUrlTransform } from "react-markdown";
import { api } from "./api";
// Image files mentioned in the chat (C:\…, /…, ~/…, ./… or a bare name)
// become links that open in the side panel.
const imageMention =
  /(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\p{L}\p{N}_.@()+-]+[\\/])*[\p{L}\p{N}_.@()+-]+\.(?:png|jpe?g|gif|webp|bmp|svg)(?![\p{L}\p{N}_])/giu;
const openScheme = "codebit-open:";
export const isImagePath = (text: string) => {
  const t = text.trim();
  return (
    /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(t) &&
    !/^(?:https?|data|blob|codebit):/i.test(t) &&
    !/[\n<>"|*?]/.test(t)
  );
};
// Splits text around image paths, leaving web addresses alone.
export function splitImagePaths(text: string) {
  const parts: (string | { path: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(imageMention)) {
    // The whole word around the match, to skip web addresses.
    const word = (text.slice(0, m.index).split(/\s/).pop() ?? "") + m[0];
    if (/^(?:[a-z][\w+.-]*:\/\/|www\.)/i.test(word)) continue;
    parts.push(text.slice(last, m.index), { path: m[0] });
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts.filter((p) => p !== "");
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
  /^(?:[A-Za-z]:[\\/]|~[\\/]|file:)/i.test(decode(url))
    ? url
    : defaultUrlTransform(url);
// Remark plugin: image paths in text and inline code turn into links.
export function remarkImagePaths() {
  const link = (path: string, children: any[]) => ({
    type: "link",
    url: openScheme + encodeURIComponent(path),
    children,
  });
  const walk = (node: any) => {
    if (!Array.isArray(node.children)) return;
    node.children = node.children.flatMap((child: any) => {
      if (child.type === "text")
        return splitImagePaths(child.value).map((p) =>
          typeof p === "string"
            ? { type: "text", value: p }
            : link(p.path, [{ type: "text", value: p.path }]),
        );
      if (child.type === "inlineCode" && isImagePath(child.value))
        return [link(child.value.trim(), [child])];
      if (!["link", "linkReference", "code"].includes(child.type)) walk(child);
      return [child];
    });
  };
  return (tree: any) => walk(tree);
}
// Where relative paths start: a task's folder, or a saved prompt run's.
export type PathBase = { id: string } | { cwd: string };
// Right click on any link: open, show in folder, copy path or address.
export const linkMenu = (base: PathBase, target: string, local: boolean) =>
  api("link.menu", { ...base, target, local });
// A markdown link: images open in the side panel, other local files with
// their default app, web addresses in the browser.
export function MarkdownLink({
  href,
  children,
  base,
  run,
  onOpenImage,
}: {
  href?: string;
  children?: ReactNode;
  base: PathBase;
  run: any;
  onOpenImage?: (path: string) => void;
}) {
  const path = linkedPath(href);
  const image = path && onOpenImage && isImagePath(path) ? path : undefined;
  return (
    <a
      href="#"
      className={path ? "file-link" : undefined}
      title={image ? `${image} · abre no painel lateral` : (path ?? href)}
      onClick={(e) => {
        e.preventDefault();
        if (image) onOpenImage!(image);
        else if (path) void run(() => api("file.open", { ...base, path }));
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
// Plain text (tool activity) with image paths as links.
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
      {splitImagePaths(text).map((p, i) =>
        typeof p === "string" ? (
          p
        ) : (
          <a
            key={i}
            href="#"
            className="file-link"
            title="Abrir no painel lateral"
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
