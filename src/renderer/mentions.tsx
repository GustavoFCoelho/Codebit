import { defaultUrlTransform } from "react-markdown";
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
// The local image a markdown link or image points to, if any. Markdown
// encodes destinations, so C:\out arrives as C:%5Cout.
export function linkedImage(url?: string) {
  if (!url) return undefined;
  if (url.startsWith(openScheme)) return decode(url.slice(openScheme.length));
  const path = decode(url);
  return isImagePath(path) ? path : undefined;
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
// Plain text (tool activity) with image paths as links.
export function LinkedText({
  text,
  onOpen,
}: {
  text: string;
  onOpen: (path: string) => void;
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
          >
            {p.path}
          </a>
        ),
      )}
    </>
  );
}
