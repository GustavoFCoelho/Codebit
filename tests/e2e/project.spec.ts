import { test, expect, _electron as electron } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/main/store";
import {
  defaultImages,
  type Task,
  type WorkItem,
} from "../../src/shared/types";
test("remover projeto: confirma, apaga do Codebit e mantém a pasta", async () => {
  const root = resolve(".codebit-test", "project-" + randomUUID());
  const store = new Store(join(root, "data"));
  const now = new Date().toISOString();
  const folders: Record<string, string> = {};
  for (const [id, name] of [
    ["p-old", "Projeto antigo"],
    ["p-keep", "Forja"],
  ]) {
    const folder = join(root, id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "leia.md"), "# " + name);
    folders[id] = folder;
    store.put("project", { id, name, path: folder, git: false, trusted: true });
    store.put<Task>("task", {
      id: randomUUID(),
      projectId: id,
      title: `Conversa de ${name}`,
      agent: "codex",
      model: "",
      cwd: folder,
      worktree: false,
      mode: "bypass",
      status: "idle",
      archived: false,
      createdAt: now,
      updatedAt: now,
      images: defaultImages,
    });
  }
  store.put<WorkItem>("work", {
    id: randomUUID(),
    projectId: "p-old",
    title: "Tarefa antiga",
    description: "",
    origin: "user",
    state: "todo",
    order: 1,
    createdAt: now,
    updatedAt: now,
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
    const sidebar = page.locator(".sidebar");
    const title = (name: string) =>
      sidebar.locator(".project-title", { hasText: name });
    // The first window can take a while right after a build.
    await expect(title("Projeto antigo")).toBeVisible({ timeout: 20_000 });
    const dialog = page.getByRole("dialog", { name: "Remover projeto" });
    // Right click offers it too; here the menu answers "Remover do Codebit…".
    await app.evaluate(({ Menu }) => {
      Menu.buildFromTemplate = ((items: any[]) => ({
        popup: () =>
          items.find((i) => i.label === "Remover do Codebit…").click(),
      })) as any;
    });
    await title("Forja").click({ button: "right" });
    await expect(dialog).toContainText("Forja");
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toHaveCount(0);
    // The trash on the project row asks first and says what goes.
    await title("Projeto antigo").hover();
    await page
      .getByRole("button", { name: "Remover o projeto Projeto antigo" })
      .click();
    await expect(dialog).toContainText("1 conversa");
    await expect(dialog).toContainText("1 tarefa do quadro");
    await expect(dialog).toContainText(folders["p-old"]);
    await expect(dialog).toContainText("não é alterada");
    await dialog.getByRole("button", { name: "Remover projeto" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(title("Projeto antigo")).toHaveCount(0);
    await expect(
      sidebar.getByRole("button", { name: "Conversa de Projeto antigo" }),
    ).toHaveCount(0);
    // The other project and the folder on disk stay.
    await expect(title("Forja")).toBeVisible();
    const left = await page.evaluate(async () => {
      const s = await window.codebit.call<any>("snapshot");
      return {
        projects: s.projects.map((p: any) => p.name),
        tasks: s.tasks.map((t: any) => t.title),
        work: s.work.length,
      };
    });
    expect(left).toEqual({
      projects: ["Forja"],
      tasks: ["Conversa de Forja"],
      work: 0,
    });
    expect(existsSync(join(folders["p-old"], "leia.md"))).toBe(true);
  } finally {
    await app.close();
  }
});
