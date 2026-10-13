import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/main/store";
import { defaultImages, type Task } from "../../src/shared/types";
test("rascunhos: a mensagem sendo escrita fica guardada por conversa", async () => {
  const root = resolve(".codebit-test", "drafts-" + randomUUID());
  const data = join(root, "data");
  await mkdir(root, { recursive: true });
  const attachment = join(root, "referencia.txt");
  await writeFile(attachment, "ref");
  const store = new Store(data);
  const now = new Date().toISOString();
  for (const title of ["Conversa A", "Conversa B"]) {
    const id = randomUUID();
    const cwd = join(data, "scratch", id);
    await mkdir(cwd, { recursive: true });
    store.put<Task>("task", {
      id,
      projectId: "",
      title,
      agent: "codex",
      model: "",
      cwd,
      worktree: false,
      mode: "bypass",
      status: "idle",
      archived: false,
      createdAt: now,
      updatedAt: now,
      images: defaultImages,
    });
  }
  store.close();
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    ),
    CODEBIT_DATA_DIR: data,
    CODEBIT_TEST_MODE: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () =>
    electron.launch({
      args: process.env.CODEBIT_EXECUTABLE ? [] : ["."],
      executablePath: process.env.CODEBIT_EXECUTABLE,
      env,
    });
  let app: ElectronApplication = await launch();
  try {
    let page = await app.firstWindow();
    const open = (title: string) =>
      page.locator(".sidebar").getByRole("button", { name: title }).click();
    const message = () => page.getByLabel("Mensagem", { exact: true });
    const pencil = (title: string) =>
      page
        .locator(".sidebar .task-row", { hasText: title })
        .getByTitle("Mensagem não enviada");
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "Conversa A" })
      .click({ timeout: 20_000 });
    await message().fill("Rascunho da A, ainda pela metade");
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, attachment);
    await page.getByRole("button", { name: "Anexar arquivos" }).click();
    await expect(page.locator(".attachment-row")).toContainText(
      "referencia.txt",
    );
    // Another conversation starts with its own (empty) message.
    await open("Conversa B");
    await expect(message()).toHaveValue("");
    await expect(page.locator(".attachment-row")).toHaveCount(0);
    await message().fill("Texto da B");
    await open("Conversa A");
    await expect(message()).toHaveValue("Rascunho da A, ainda pela metade");
    await expect(page.locator(".attachment-row")).toContainText(
      "referencia.txt",
    );
    await expect(pencil("Conversa A")).toBeVisible();
    await expect(pencil("Conversa B")).toBeVisible();
    // The window reloads (as after "Interface atualizada"): still there.
    await page.reload();
    await open("Conversa A");
    await expect(message()).toHaveValue("Rascunho da A, ainda pela metade");
    // Erasing the message drops the draft.
    await message().fill("");
    await page.getByRole("button", { name: "Remover anexo" }).click();
    await expect(pencil("Conversa A")).toHaveCount(0);
    // The board's new task is kept the same way.
    await page.getByRole("button", { name: /Multitarefa/ }).click();
    await page.getByLabel("Nova tarefa do quadro").fill("Ideia para o quadro");
    await open("Conversa B");
    await page.getByRole("button", { name: /Multitarefa/ }).click();
    await expect(page.getByLabel("Nova tarefa do quadro")).toHaveValue(
      "Ideia para o quadro",
    );
    // Closing and opening Codebit keeps them too.
    await page.waitForTimeout(600);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "Conversa B" })
      .click({ timeout: 20_000 });
    await expect(message()).toHaveValue("Texto da B");
    await open("Conversa A");
    await expect(message()).toHaveValue("");
  } finally {
    await app.close();
  }
});
