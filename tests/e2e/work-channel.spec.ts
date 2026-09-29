import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/main/store";
import {
  defaultImages,
  type Task,
  type WorkItem,
} from "../../src/shared/types";
test("quadro de tarefas: tarefas criadas por uma conversa do projeto levam até ela", async () => {
  const root = resolve(".codebit-test", "work-chat-" + randomUUID());
  const project = join(root, "forja");
  await mkdir(project, { recursive: true });
  const store = new Store(join(root, "data"));
  const now = new Date().toISOString();
  store.put("project", {
    id: "p-chat",
    name: "Forja",
    path: project,
    git: false,
    trusted: true,
  });
  const chatId = randomUUID();
  store.put<Task>("task", {
    id: chatId,
    projectId: "p-chat",
    title: "Planejar a forja",
    agent: "codex",
    model: "",
    cwd: project,
    worktree: false,
    mode: "bypass",
    status: "idle",
    archived: false,
    createdAt: now,
    updatedAt: now,
    images: defaultImages,
  });
  const item = (title: string, extra: Partial<WorkItem>) =>
    store.put<WorkItem>("work", {
      id: randomUUID(),
      projectId: "p-chat",
      title,
      description: "",
      origin: "user",
      state: "todo",
      order: 1,
      createdAt: now,
      updatedAt: now,
      chatId,
      ...extra,
    });
  // What the user asked for in the chat, and an idea of the agent.
  item("Criar a dungeon", {});
  item("Adicionar trilha sonora", { origin: "ai", state: "pending", order: 2 });
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
    // The first window can take a while right after a build.
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "Tarefas de Forja" })
      .click({ timeout: 20_000 });
    const asked = page.getByRole("article", { name: "Criar a dungeon" });
    await expect(asked).toContainText("Conversa");
    await expect(asked).toContainText("Da conversa: Planejar a forja");
    await page.getByRole("tab", { name: /Pendentes de aprovação/ }).click();
    const idea = page.getByRole("article", { name: "Adicionar trilha sonora" });
    await expect(idea).toContainText("IA");
    await expect(idea).toContainText("Da conversa: Planejar a forja");
    // The origin opens the conversation, a normal chat of the project.
    await idea.getByRole("button", { name: /Da conversa/ }).click();
    await expect(
      page.getByRole("heading", { name: "Planejar a forja", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Voltar ao quadro de tarefas" }),
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});
