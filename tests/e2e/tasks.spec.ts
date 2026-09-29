import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/main/store";
import { defaultImages, type Task } from "../../src/shared/types";
test("tarefas: arquivar, restaurar e excluir pela barra lateral e pelo menu", async () => {
  const root = resolve(".codebit-test", "tasks-" + randomUUID());
  await mkdir(root, { recursive: true });
  const store = new Store(join(root, "data"));
  const now = new Date().toISOString();
  for (const title of ["Arquivar esta", "Excluir esta", "Pelo menu"]) {
    const id = randomUUID();
    const cwd = join(root, "data", "scratch", id);
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
    const row = (title: string) =>
      page.locator(".sidebar .task-row", { hasText: title });
    const titles = () =>
      page.evaluate(async () =>
        (await window.codebit.call<any>("snapshot")).tasks
          .filter((t: any) => !t.archived)
          .map((t: any) => t.title)
          .sort(),
      );
    await expect(row("Arquivar esta")).toBeVisible();
    // Archive from the row, find it among the archived, restore it.
    await row("Arquivar esta").hover();
    await row("Arquivar esta")
      .getByRole("button", { name: "Arquivar", exact: true })
      .click();
    await expect(row("Arquivar esta")).toHaveCount(0);
    await page.getByRole("button", { name: "Arquivadas", exact: true }).click();
    await expect(page.getByText("Tarefas arquivadas")).toBeVisible();
    await row("Arquivar esta").hover();
    await row("Arquivar esta")
      .getByRole("button", { name: "Restaurar", exact: true })
      .click();
    await page.getByRole("button", { name: "Voltar às ativas" }).click();
    await expect(row("Arquivar esta")).toBeVisible();
    // Delete asks first; Excluir removes it for good.
    await row("Excluir esta").hover();
    await row("Excluir esta")
      .getByRole("button", { name: "Excluir", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Excluir tarefa" });
    await expect(dialog).toContainText("Não dá para desfazer");
    await dialog.getByRole("button", { name: "Excluir", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row("Excluir esta")).toHaveCount(0);
    expect(await titles()).toEqual(["Arquivar esta", "Pelo menu"]);
    // Right click opens the native menu; here it answers "Excluir…".
    await app.evaluate(({ Menu }) => {
      Menu.buildFromTemplate = ((items: any[]) => ({
        popup: () => items.find((i) => i.label === "Excluir…").click(),
      })) as any;
    });
    await row("Pelo menu").click({ button: "right" });
    await expect(dialog).toContainText("Pelo menu");
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    expect(await titles()).toEqual(["Arquivar esta", "Pelo menu"]);
    // The open task also has archive and delete in the title bar.
    await row("Pelo menu").click();
    await expect(
      page.getByRole("button", { name: "Arquivar tarefa" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Excluir tarefa" }).click();
    await dialog.getByRole("button", { name: "Excluir", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "O que vamos construir?" }),
    ).toBeVisible();
    expect(await titles()).toEqual(["Arquivar esta"]);
  } finally {
    await app.close();
  }
});
