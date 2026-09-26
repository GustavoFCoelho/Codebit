import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  isImagePath,
  linkedImage,
  markdownUrl,
  remarkImagePaths,
  splitImagePaths,
} from "../src/renderer/mentions";
const paths = (text: string) =>
  splitImagePaths(text)
    .filter((p) => typeof p !== "string")
    .map((p) => (p as { path: string }).path);
describe("imagens mencionadas no chat", () => {
  it("encontra caminhos de imagem absolutos, relativos e com acentos", () => {
    expect(
      paths(
        "Salvei em C:\\Users\\gugam\\.codex\\generated_images\\abc\\exec-1.png.",
      ),
    ).toEqual(["C:\\Users\\gugam\\.codex\\generated_images\\abc\\exec-1.png"]);
    expect(
      paths(
        "Veja ./docs/screenshots/tela.png e ~/imagens/ação.webp, e logo.svg",
      ),
    ).toEqual([
      "./docs/screenshots/tela.png",
      "~/imagens/ação.webp",
      "logo.svg",
    ]);
    expect(paths("Terminal · python gerar.py --saida /tmp/out.jpeg")).toEqual([
      "/tmp/out.jpeg",
    ]);
  });
  it("ignora endereços web e arquivos que não são imagens", () => {
    expect(paths("https://site.com/a.png e www.site.com/b.jpg")).toEqual([]);
    expect(paths("Edit · src/main/runtime.ts e dados.json")).toEqual([]);
    expect(isImagePath("https://site.com/a.png")).toBe(false);
    expect(isImagePath("C:\\a\\b.PNG")).toBe(true);
    expect(linkedImage("https://site.com")).toBeUndefined();
  });
  it("no markdown, texto, código e imagens locais viram links para o painel", () => {
    const html = renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        {
          remarkPlugins: [remarkGfm, remarkImagePaths],
          urlTransform: markdownUrl,
        },
        "Gerei `img/tela.png` em C:\\out\\a.png.\n\n![prévia](C:\\out\\a.png)\n\n```\nnao/linka.png\n```\n\n[site](https://x.com/b.png)",
      ),
    );
    expect(html).toContain(
      'href="codebit-open:img%2Ftela.png"><code>img/tela.png</code>',
    );
    expect(html).toContain(
      'href="codebit-open:C%3A%5Cout%5Ca.png">C:\\out\\a.png</a>',
    );
    // Markdown encodes the destination; the chat decodes it to open the file.
    expect(html).toContain('src="C:%5Cout%5Ca.png"');
    expect(linkedImage("C:%5Cout%5Ca.png")).toBe("C:\\out\\a.png");
    // Code blocks and web links stay as they are.
    expect(html).toContain("<code>nao/linka.png\n</code>");
    expect(html).toContain('href="https://x.com/b.png"');
    expect(linkedImage("codebit-open:img%2Ftela.png")).toBe("img/tela.png");
  });
});
