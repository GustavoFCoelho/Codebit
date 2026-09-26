import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/main/store";
import {
  defaultImages,
  type Entry,
  type Project,
  type Task,
} from "../../src/shared/types";

test("modo multitarefa: cartões, arrastar, tirar do quadro e abrir conversa", async () => {
  const root = resolve(".codebit-test", "board-" + randomUUID());
  const data = join(root, "data");
  await mkdir(join(root, "projeto"), { recursive: true });
  const store = new Store(data);
  const project: Project = {
    id: randomUUID(),
    name: "Projeto sem confiança",
    path: join(root, "projeto"),
    git: false,
    trusted: false,
  };
  store.put("project", project);
  const now = new Date().toISOString();
  const task = (title: string, boardAt?: string): Task => ({
    id: randomUUID(),
    projectId: "",
    title,
    agent: "codex",
    model: "",
    cwd: root,
    worktree: false,
    mode: "execute",
    status: "idle",
    archived: false,
    createdAt: now,
    updatedAt: now,
    images: defaultImages,
    boardAt,
  });
  const auth = task("Refatorar autenticação", "2026-01-01T00:00:00.000Z");
  const tests = task("Gerar testes unitários", "2026-01-01T00:00:01.000Z");
  const docs = task("Revisar documentação");
  for (const t of [auth, tests, docs]) store.put("task", t);
  const entry = (kind: Entry["kind"], text: string, extra = {}): Entry => ({
    id: randomUUID(),
    taskId: auth.id,
    kind,
    text,
    createdAt: now,
    ...extra,
  });
  store.put("entry", entry("user", "Refatore o login"));
  store.put("entry", entry("activity", "Terminal · npm test"));
  store.put("entry", entry("assistant", "Atualizei o **fluxo de login**."));
  store.put(
    "entry",
    entry("request", "Permitir execução?", {
      request: {
        id: "1",
        kind: "approval",
        title: "Permitir execução?",
        detail: "npm run build",
        choices: ["decline", "accept"],
      },
    }),
  );
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
  const app = await electron.launch({
    args: process.env.CODEBIT_EXECUTABLE ? [] : ["."],
    executablePath: process.env.CODEBIT_EXECUTABLE,
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Multitarefa" }).click();
    await expect(
      page.getByRole("heading", { name: "Modo Multitarefa" }),
    ).toBeVisible();
    const cards = page.getByRole("article");
    await expect(cards).toHaveCount(2);
    const first = page.getByRole("article", { name: "Refatorar autenticação" });
    await expect(first).toContainText("fluxo de login");
    await expect(first).toContainText("Terminal · npm test");
    await expect(first.getByRole("button", { name: "Permitir" })).toBeVisible();
    // Adding from the picker and by dragging a task from the sidebar.
    await page
      .getByLabel("Adicionar tarefa ao quadro")
      .selectOption({ label: "Revisar documentação" });
    await expect(cards).toHaveCount(3);
    await page
      .getByRole("article", { name: "Gerar testes unitários" })
      .getByRole("button", { name: "Tirar do quadro" })
      .click();
    await expect(cards).toHaveCount(2);
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "Gerar testes unitários" })
      .dragTo(page.getByLabel("Soltar tarefa"));
    await expect(cards).toHaveCount(3);
    // Hidden test windows paint lazily; give the capture a settled frame.
    await page.waitForTimeout(800);
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.setBackgroundThrottling(false);
      return (
        await win.webContents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true,
        })
      )
        .toPNG()
        .toString("base64");
    });
    await writeFile(
      resolve("test-results", "05-multitarefa.png"),
      Buffer.from(png, "base64"),
    );
    // Starting in an untrusted project is refused without creating a task.
    await page.getByLabel("Projeto da nova tarefa").selectOption(project.id);
    await page.getByLabel("Nova tarefa do quadro").fill("Nova tarefa");
    await page.getByRole("button", { name: "Iniciar tarefa" }).click();
    await expect(page.getByRole("alert")).toContainText("Confie no projeto");
    await expect(cards).toHaveCount(3);
    await first.getByRole("button", { name: "Abrir conversa" }).click();
    await expect(
      page.getByRole("heading", { name: "Refatorar autenticação" }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});
