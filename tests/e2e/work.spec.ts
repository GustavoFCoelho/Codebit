import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/main/store";
import {
  defaultImages,
  type Entry,
  type Task,
  type WorkItem,
} from "../../src/shared/types";
test("quadro de tarefas: criar, organizar, aprovar recomendações e abrir a sessão", async () => {
  const root = resolve(".codebit-test", "work-" + randomUUID());
  const project = join(root, "forja");
  await mkdir(project, { recursive: true });
  const store = new Store(join(root, "data"));
  const now = new Date().toISOString();
  store.put("project", {
    id: "p-work",
    name: "Forja",
    path: project,
    git: false,
    trusted: true,
  });
  const item = (title: string, extra: Partial<WorkItem> = {}): WorkItem =>
    store.put<WorkItem>("work", {
      id: randomUUID(),
      projectId: "p-work",
      title,
      description: "",
      origin: "user",
      state: "todo",
      order: 0,
      createdAt: now,
      updatedAt: now,
      ...extra,
    });
  // A finished task, with its internal session.
  const doneId = randomUUID();
  const sessionId = randomUUID();
  item("Criar os mobs", {
    id: doneId,
    state: "started",
    taskId: sessionId,
    order: 1,
  });
  store.put<Task>("task", {
    id: sessionId,
    projectId: "p-work",
    title: "Criar os mobs",
    agent: "claude",
    model: "",
    cwd: project,
    worktree: false,
    mode: "bypass",
    status: "idle",
    archived: false,
    createdAt: now,
    updatedAt: now,
    images: defaultImages,
    workItemId: doneId,
  });
  store.put<Entry>("entry", {
    id: randomUUID(),
    taskId: sessionId,
    kind: "assistant",
    text: "Mobs criados: goblin, orc e troll.",
    createdAt: now,
    agent: "claude",
  });
  // What the agent recommended when it finished.
  item("Balancear o troll", {
    origin: "ai",
    state: "pending",
    sourceId: doneId,
    description: "O troll derrota o jogador em dois golpes.",
    order: 2,
  });
  item("Revisar drops", { origin: "ai", state: "pending", order: 3 });
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
    // The internal session is not a conversation of the project.
    // The first window can take a while right after a build.
    await expect(
      sidebar.getByRole("button", { name: "Tarefas de Forja" }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      sidebar.getByRole("button", { name: "Criar os mobs" }),
    ).toHaveCount(0);
    await expect(sidebar.locator(".work-link .badge")).toHaveText("2");
    await sidebar.getByRole("button", { name: "Tarefas de Forja" }).click();
    await expect(
      page.getByRole("heading", { name: "Tarefas · Forja" }),
    ).toBeVisible();
    await expect(
      page.getByText("Desligado: nenhuma tarefa começa"),
    ).toBeVisible();
    const column = (name: string) =>
      page.getByRole("region", { name, exact: true });
    await expect(column("Concluídas")).toContainText("Criar os mobs");
    // New tasks go to the end of "A fazer" and do not start with the mode off.
    for (const title of ["Primeira", "Segunda"]) {
      await page.getByLabel("Título da nova tarefa").fill(title);
      await page
        .getByLabel("Descrição da nova tarefa")
        .fill(`Detalhes ${title}`);
      await page
        .getByRole("button", { name: "Adicionar", exact: true })
        .click();
    }
    const todo = column("A fazer").getByRole("article");
    await expect(todo).toHaveCount(2);
    await expect(todo.first()).toContainText("Primeira");
    await todo.nth(1).getByRole("button", { name: "Subir na fila" }).click();
    await expect(todo.first()).toContainText("Segunda");
    await todo.first().getByRole("button", { name: "Editar" }).click();
    await page.getByLabel("Título da tarefa").fill("Segunda editada");
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(todo.first()).toContainText("Segunda editada");
    await expect(todo.first()).toContainText("Na fila");
    await todo.nth(1).getByRole("button", { name: "Excluir" }).click();
    await todo.nth(1).getByRole("button", { name: "Excluir" }).click();
    await expect(todo).toHaveCount(1);
    // Recommendations stay apart until approved.
    await page.getByRole("tab", { name: /Pendentes de aprovação/ }).click();
    const troll = page.getByRole("article", { name: "Balancear o troll" });
    await expect(troll).toContainText("De: Criar os mobs");
    await expect(troll).toContainText("IA");
    await troll.getByRole("button", { name: "Aprovar" }).click();
    await expect(troll).toHaveCount(0);
    await page
      .getByRole("article", { name: "Revisar drops" })
      .getByRole("button", { name: "Descartar" })
      .click();
    await page
      .getByRole("article", { name: "Revisar drops" })
      .getByRole("button", { name: "Descartar" })
      .click();
    await expect(
      page.getByText("Nenhuma recomendação esperando"),
    ).toBeVisible();
    await page.getByRole("tab", { name: /Quadro/ }).click();
    await expect(todo).toHaveCount(2);
    await expect(todo.nth(1)).toContainText("Balancear o troll");
    // The mode settings apply to the next tasks.
    await page.getByLabel("Agente das tarefas").selectOption("claude");
    await page.getByLabel("Tarefas simultâneas").fill("2");
    await page
      .getByRole("group", { name: "Permissões das tarefas" })
      .getByRole("button", { name: "Executar" })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.codebit.call<any>("snapshot")).projects[0].work,
        ),
      )
      .toMatchObject({
        enabled: false,
        agent: "claude",
        max: 2,
        mode: "execute",
      });
    // The session opens like a chat and leads back to the board.
    await column("Concluídas")
      .getByRole("button", { name: "Abrir a sessão" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Criar os mobs", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Mobs criados: goblin, orc e troll."),
    ).toBeVisible();
    await expect(
      page.getByText("tarefa do quadro", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Voltar ao quadro de tarefas" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Tarefas · Forja" }),
    ).toBeVisible();
    expect(
      await page.evaluate(async () =>
        (await window.codebit.call<any>("snapshot")).work
          .filter((w: any) => w.state !== "started")
          .map((w: any) => [w.title, w.origin, w.state]),
      ),
    ).toEqual([
      ["Segunda editada", "user", "todo"],
      ["Balancear o troll", "ai", "todo"],
    ]);
  } finally {
    await app.close();
  }
});
