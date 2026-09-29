import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/main/store";
import { defaultImages, type Entry, type Task } from "../../src/shared/types";
test("modo Planejar: o plano aparece formatado no painel lateral", async () => {
  const root = resolve(".codebit-test", "plan-" + randomUUID());
  await mkdir(root, { recursive: true });
  const text = [
    "# Plano: Forja de Escória",
    "",
    "## Etapas",
    "",
    "1. Criar os mobs",
    "2. Criar o boss",
    "",
    "| Item | Nível |",
    "|---|---|",
    "| Espada | 3 |",
    "",
    "```js",
    "const forja = true;",
    "```",
  ].join("\n");
  const path = join(root, "forja.md");
  await writeFile(path, text);
  const store = new Store(join(root, "data"));
  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    projectId: "",
    title: "Planejar a forja",
    agent: "claude",
    model: "",
    cwd: root,
    worktree: false,
    mode: "plan",
    status: "idle",
    archived: false,
    createdAt: now,
    updatedAt: now,
    images: defaultImages,
    plan: { text, path, agent: "claude", at: now },
  };
  store.put("task", task);
  const entry = (kind: Entry["kind"], body: string, extra = {}) =>
    store.put<Entry>("entry", {
      id: randomUUID(),
      taskId: task.id,
      kind,
      text: body,
      createdAt: now,
      ...extra,
    });
  entry("user", "Planeje a dungeon.");
  entry("request", "Plano pronto para revisão", {
    request: {
      id: "plan-1",
      kind: "approval",
      title: "Plano pronto para revisão",
      detail: "",
      choices: ["decline", "accept"],
      tool: "ExitPlanMode",
      plan: true,
    },
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
    await page.getByRole("button", { name: "Planejar a forja" }).click();
    // A short card in the chat instead of the tool's raw JSON.
    const card = page.locator(".request-card");
    await expect(card).toContainText("Plano pronto para revisão");
    await expect(card).toContainText("aba Plano do painel lateral");
    await expect(card.locator("pre")).toHaveCount(0);
    await expect(
      card.getByRole("button", { name: "Aprovar e executar" }),
    ).toBeVisible();
    await expect(
      card.getByRole("button", { name: "Continuar planejando" }),
    ).toBeVisible();
    await card.getByRole("button", { name: "Ver plano" }).click();
    const doc = page.locator(".plan-doc");
    await expect(
      doc.getByRole("heading", { name: "Plano: Forja de Escória" }),
    ).toBeVisible();
    await expect(doc.getByRole("listitem")).toHaveText([
      "Criar os mobs",
      "Criar o boss",
    ]);
    await expect(doc.locator("table td").first()).toHaveText("Espada");
    await expect(doc.locator("pre code")).toHaveText("const forja = true;");
    await expect(page.locator(".plan-title strong")).toHaveText("forja.md");
    await expect(page.locator(".plan-decision")).toContainText(
      "espera sua decisão",
    );
    // Open the .md with its default app, recorded instead of launched.
    await app.evaluate(({ shell }) => {
      shell.openPath = async (p: string) => {
        (globalThis as any).opened = p;
        return "";
      };
    });
    await page.getByRole("button", { name: "Abrir .md" }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as any).opened))
      .toBe(path);
  } finally {
    await app.close();
  }
});
