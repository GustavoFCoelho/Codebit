import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/main/store";
import { defaultImages, type Entry, type Task } from "../../src/shared/types";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8uoAAAAASUVORK5CYII=";
test("imagens mencionadas no chat abrem no painel lateral", async () => {
  const root = resolve(".codebit-test", "mentions-" + randomUUID());
  const folder = join(root, "pasta");
  await mkdir(join(folder, "img"), { recursive: true });
  const image = join(folder, "img", "tela.png");
  await writeFile(image, Buffer.from(png, "base64"));
  // PNG bytes under another extension must still be refused.
  await writeFile(join(folder, "segredo.txt"), Buffer.from(png, "base64"));
  // Files an agent links to, written as Codex writes them.
  for (const dir of ["work", "docs", "tools"]) await mkdir(join(folder, dir));
  const scene = join(folder, "work", "cena_v004.blend");
  await writeFile(scene, "blend");
  await writeFile(join(folder, "docs", "nota.md"), "# Nota");
  await writeFile(join(folder, "tools", "rodar.bat"), "echo oi");
  const store = new Store(join(root, "data"));
  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    projectId: "",
    title: "Com imagens",
    agent: "codex",
    model: "",
    cwd: folder,
    worktree: false,
    mode: "execute",
    status: "idle",
    archived: false,
    createdAt: now,
    updatedAt: now,
    images: defaultImages,
  };
  store.put("task", task);
  const entry = (kind: Entry["kind"], text: string, extra = {}) =>
    store.put<Entry>("entry", {
      id: randomUUID(),
      taskId: task.id,
      kind,
      text,
      createdAt: now,
      ...extra,
    });
  entry("user", "Veja o anexo.", { attachments: [image] });
  entry("activity", `Edit · ${image}`);
  entry("assistant", "Gerei `img/tela.png`.\n\n![prévia](img/tela.png)", {
    agent: "codex",
  });
  entry(
    "assistant",
    `[Cena Blender v004](${scene.replaceAll("\\", "/")}) · [Registro](docs/nota.md) · [Script](tools/rodar.bat) · [Sumido](nao/existe.md) · [Site](https://example.com)`,
    { agent: "codex" },
  );
  store.close();
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    ),
    CODEBIT_DATA_DIR: join(root, "data"),
    CODEBIT_TEST_MODE: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: process.env.CODEBIT_EXECUTABLE ? [] : ["."],
    executablePath: process.env.CODEBIT_EXECUTABLE,
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Com imagens" }).click();
    const loaded = (selector: string) =>
      page
        .locator(selector)
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth);
    // A markdown image with a relative path shows in the chat.
    await expect(page.locator(".chat-image")).toBeVisible();
    await expect.poll(() => loaded(".chat-image")).toBe(1);
    const path = page.locator(".inspector .image-path");
    // Tool activity (the "context").
    await page.locator(".entry-activity .file-link").click();
    await expect(path).toHaveText(image);
    await expect.poll(() => loaded(".inspector .inspector-image")).toBe(1);
    await page
      .getByRole("button", { name: "Voltar às imagens da tarefa" })
      .click();
    await expect(
      page.getByText("Imagens da tarefa", { exact: true }),
    ).toBeVisible();
    // Inline code in the reply, relative to the task folder.
    await page.getByRole("link", { name: "img/tela.png" }).click();
    await expect(path).toHaveText("img/tela.png");
    await expect.poll(() => loaded(".inspector .inspector-image")).toBe(1);
    // The attached image.
    await page.locator(".entry-user a.attachment").click();
    await expect(path).toHaveText(image);
    const refused = await page.evaluate(
      (id) =>
        new Promise((done) => {
          const img = new Image();
          img.onload = () => done("carregou");
          img.onerror = () => done("recusado");
          img.src = `codebit://file/${id}?path=segredo.txt`;
        }),
      task.id,
    );
    expect(refused).toBe("recusado");
    // Other local files open with their default app: record instead of
    // launching Blender, and capture the native context menu.
    await app.evaluate(({ shell, Menu }) => {
      const g = globalThis as any;
      g.opened = [];
      shell.openPath = async (p: string) => {
        g.opened.push(p);
        return "";
      };
      Menu.buildFromTemplate = ((items: any[]) => {
        g.menu = items;
        return { popup() {} };
      }) as any;
    });
    const opened = () => app.evaluate(() => (globalThis as any).opened);
    const link = (name: string) => page.getByRole("link", { name });
    await link("Cena Blender v004").click();
    await expect.poll(opened).toEqual([scene]);
    await link("Registro").click();
    await expect.poll(opened).toEqual([scene, join(folder, "docs", "nota.md")]);
    // Programs and scripts never open from a link.
    await link("Script").click();
    await expect(
      page.getByText(/Por segurança, programas e scripts/),
    ).toBeVisible();
    await link("Sumido").click();
    await expect(page.getByText(/Arquivo não encontrado/)).toBeVisible();
    expect(await opened()).toHaveLength(2);
    // Right click: open, show in folder and copy the path.
    const menu = () =>
      app.evaluate(() =>
        (globalThis as any).menu.map((i: any) => [i.label, i.enabled]),
      );
    await link("Cena Blender v004").click({ button: "right" });
    await expect.poll(menu).toEqual([
      ["Abrir no app padrão", true],
      ["Mostrar na pasta", undefined],
      [undefined, undefined],
      ["Copiar caminho", undefined],
    ]);
    // The user's clipboard is restored afterwards.
    const copied = await app.evaluate(async ({ clipboard }) => {
      const before = await clipboard.readText();
      await clipboard.writeText("");
      (globalThis as any).menu
        .find((i: any) => i.label === "Copiar caminho")
        .click();
      let text = "";
      for (let i = 0; i < 20 && !text; i++) {
        await new Promise((r) => setTimeout(r, 50));
        text = await clipboard.readText();
      }
      await clipboard.writeText(before);
      return text;
    });
    expect(copied).toBe(scene);
    await link("Script").click({ button: "right" });
    await expect.poll(menu).toContainEqual(["Abrir no app padrão", false]);
    await link("Site").click({ button: "right" });
    await expect.poll(menu).toEqual([
      ["Abrir no navegador", true],
      ["Copiar endereço", undefined],
    ]);
  } finally {
    await app.close();
  }
});
