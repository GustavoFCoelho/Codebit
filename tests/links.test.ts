import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fileContent, files } from "../src/main/workspace";
import {
  findMentioned,
  forgetListings,
  mentionedPath,
  resolveMention,
} from "../src/main/mentions";
import {
  markdownUrl,
  MarkdownLink,
  remarkFilePaths,
  splitPaths,
} from "../src/renderer/mentions";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  forgetListings();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function tree(files: string[]) {
  const root = await mkdtemp(join(resolve(tmpdir()), "codebit-links-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const file of files) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), file);
  }
  return root;
}
const paths = (text: string) =>
  splitPaths(text)
    .filter((p) => typeof p !== "string")
    .map((p) => (p as { path: string }).path);
const markdown = (text: string) =>
  renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkFilePaths],
        urlTransform: markdownUrl,
      },
      text,
    ),
  );
describe("links para arquivos no chat", () => {
  it("caminhos do Git Bash, do WSL e da pasta do usuário", () => {
    if (process.platform === "win32") {
      expect(mentionedPath("C:\\x", "/d/Git/Codebit/dist/a.zip")).toBe(
        "D:\\Git\\Codebit\\dist\\a.zip",
      );
      expect(mentionedPath("C:\\x", "/mnt/c/Users/gugam")).toBe(
        "C:\\Users\\gugam",
      );
    }
    expect(mentionedPath("C:\\x", "~/notas.md")).toBe(
      join(homedir(), "notas.md"),
    );
    expect(mentionedPath(resolve("base"), "dist/a.zip")).toBe(
      resolve("base", "dist/a.zip"),
    );
  });
  it("acha o arquivo citado de uma subpasta, encurtado ou com caminho antigo", async () => {
    const root = await tree([
      "blender/dist/pacote_saia.zip",
      "node_modules/dist/pacote_saia.zip",
      "docs/notas.md",
    ]);
    const found = join(root, "blender", "dist", "pacote_saia.zip");
    // Relative to the subfolder the agent was working in.
    expect(await findMentioned(root, "dist/pacote_saia.zip")).toBe(found);
    // Shortened with "…" or "...", at the start or in the middle.
    expect(await findMentioned(root, "…/pacote_saia.zip")).toBe(found);
    expect(await findMentioned(root, ".../dist/pacote_saia.zip")).toBe(found);
    expect(await findMentioned(root, "blender/…/pacote_saia.zip")).toBe(found);
    // An absolute path from elsewhere that ends the same way.
    expect(
      await findMentioned(root, "Z:/outra/maquina/dist/pacote_saia.zip"),
    ).toBe(found);
    // A bare name, when it is the only one.
    expect(await findMentioned(root, "notas.md")).toBe(
      join(root, "docs", "notas.md"),
    );
    expect(await findMentioned(root, "nao_existe.zip")).toBeUndefined();
    expect(
      await findMentioned(root, "../fora/pacote_saia.zip"),
    ).toBeUndefined();
  });
  it("nome repetido: só com a pasta; várias versões vão para a mais recente", async () => {
    const root = await tree([
      "a/dist/build.zip",
      "b/dist/build.zip",
      "a/leia.txt",
      "b/leia.txt",
    ]);
    const past = new Date(Date.now() - 60_000);
    await utimes(join(root, "a/dist/build.zip"), past, past);
    // Bare names must be unique.
    expect(await findMentioned(root, "leia.txt")).toBeUndefined();
    expect(await findMentioned(root, "b/leia.txt")).toBe(
      join(root, "b", "leia.txt"),
    );
    expect(await findMentioned(root, "dist/build.zip")).toBe(
      join(root, "b", "dist", "build.zip"),
    );
  });
  it("diz se é pasta ou arquivo e o caminho dentro da tarefa", async () => {
    const root = await tree(["src/main/index.ts"]);
    expect(await resolveMention(root, "src/main")).toEqual({
      path: join(root, "src", "main"),
      kind: "dir",
      relative: join("src", "main"),
    });
    expect(await resolveMention(root, "main/index.ts")).toMatchObject({
      kind: "file",
      relative: join("src", "main", "index.ts"),
    });
    // A file made after the listing is found once the listing is renewed.
    expect(await findMentioned(root, "novo/arquivo.md")).toBeUndefined();
    await mkdir(join(root, "sub", "novo"), { recursive: true });
    await writeFile(join(root, "sub", "novo", "arquivo.md"), "x");
    forgetListings();
    expect(await findMentioned(root, "novo/arquivo.md")).toBe(
      join(root, "sub", "novo", "arquivo.md"),
    );
  });
  it("arquivo sumido da pasta: mensagem clara em vez do erro do sistema", async () => {
    const root = await tree(["docs/a.md"]);
    expect(await fileContent(root, "docs/a.md")).toBe("docs/a.md");
    await expect(fileContent(root, "docs/sumiu.md")).rejects.toThrow(
      "Não encontrado na pasta da tarefa: docs/sumiu.md",
    );
    await expect(files(root, "pasta/removida")).rejects.toThrow(
      "Não encontrado na pasta da tarefa",
    );
  });
  it("no texto, caminhos de arquivos viram links; palavras comuns não", () => {
    expect(
      paths(
        "Preparei a física da saia. O novo pacote de teste é o dist/Idus_Knight_Silver_Grooved_teste_v003_fisica_saia.zip.",
      ),
    ).toEqual(["dist/Idus_Knight_Silver_Grooved_teste_v003_fisica_saia.zip"]);
    expect(
      paths(
        "Veja C:\\Users\\gugam\\Desktop e /d/Git/Codebit/README.md (ou ./docs/a.md).",
      ),
    ).toEqual([
      "C:\\Users\\gugam\\Desktop",
      "/d/Git/Codebit/README.md",
      "./docs/a.md",
    ]);
    expect(
      paths(
        "Node.js e Vue.js, e/ou TCP/IP, em 12/05/2026, digite /help, https://x.com/a/b.zip",
      ),
    ).toEqual([]);
  });
  it("no código inline: caminhos viram links; nomes soltos só depois de achados", () => {
    const html = markdown(
      "O pacote é o `dist/Idus_Knight_teste_v003_fisica_saia.zip`, o texto `README.md`, a pasta `src/main` e `console.log`; rode `npm run build`.",
    );
    expect(html).toContain(
      'href="codebit-open:dist%2FIdus_Knight_teste_v003_fisica_saia.zip"><code>',
    );
    expect(html).toContain('href="codebit-maybe:README.md"><code>README.md');
    expect(html).toContain('href="codebit-maybe:src%2Fmain"><code>src/main');
    expect(html).toContain('href="codebit-maybe:console.log"');
    expect(html).toContain("<code>npm run build</code>");
    // A name not checked yet stays plain code, without a link.
    const link = renderToStaticMarkup(
      createElement(
        MarkdownLink,
        { href: "codebit-maybe:console.log", base: { id: "t" }, run: () => {} },
        createElement("code", null, "console.log"),
      ),
    );
    expect(link).toBe("<code>console.log</code>");
  });
});
