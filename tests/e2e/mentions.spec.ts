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
    await page.locator(".entry-assistant .file-link").click();
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
  } finally {
    await app.close();
  }
});
