import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/main/store";
import { defaultImages, type Task } from "../../src/shared/types";
test("chat rápido: perguntas à parte que não ficam no histórico", async () => {
  const root = resolve(".codebit-test", "quick-chat-" + randomUUID());
  const project = join(root, "forja");
  await mkdir(project, { recursive: true });
  // A Codex "installed" as an npm script that runs the test agent.
  const bin = join(root, "bin");
  const script = join(bin, "node_modules", "@openai", "codex", "bin");
  await mkdir(script, { recursive: true });
  await writeFile(join(bin, "codex.cmd"), "@echo off\r\n");
  await writeFile(
    join(script, "codex.js"),
    `process.argv.splice(2, 0, "codex");
import(require("node:url").pathToFileURL(${JSON.stringify(
      resolve("tests/fixtures/agent.mjs"),
    )}).href);
`,
  );
  const store = new Store(join(root, "data"));
  store.saveSettings({
    ...store.settings(),
    cliPaths: { ...store.settings().cliPaths, codex: join(bin, "codex.cmd") },
  });
  store.put("project", {
    id: "p-quick",
    name: "Forja",
    path: project,
    git: false,
    trusted: true,
  });
  const now = new Date().toISOString();
  store.put<Task>("task", {
    id: randomUUID(),
    projectId: "p-quick",
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
  store.close();
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    ),
    CODEBIT_DATA_DIR: join(root, "data"),
    CODEBIT_TEST_MODE: "1",
    CODEBIT_NODE_PATH: process.execPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: process.env.CODEBIT_EXECUTABLE ? [] : ["."],
    executablePath: process.env.CODEBIT_EXECUTABLE,
    env,
  });
  try {
    const page = await app.firstWindow();
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "Planejar a forja" })
      .click({ timeout: 20_000 });
    // Ctrl+J opens it, in the project of the open conversation.
    await page.keyboard.press("Control+j");
    const panel = page.getByRole("complementary", { name: "Chat rápido" });
    await expect(panel).toContainText("Pergunte ou peça algo rápido");
    await expect(panel.getByLabel("Pasta do chat rápido")).toHaveValue(
      "p-quick",
    );
    await expect(panel.getByLabel("Agente do chat rápido")).toHaveValue(
      "codex",
    );
    await panel.getByRole("button", { name: "Só leitura" }).click();
    const box = panel.getByLabel("Mensagem do chat rápido");
    await box.fill("WHERE");
    await box.press("Enter");
    await expect(panel.locator(".quick-turn").first()).toContainText(
      '"resumed":null',
    );
    await expect(box).toHaveValue("");
    // The agent and folder are fixed once it starts.
    await expect(panel.getByLabel("Pasta do chat rápido")).toHaveCount(0);
    await expect(panel).toContainText("Forja");
    await box.fill("ECHO segunda pergunta");
    await box.press("Enter");
    await expect(panel.locator(".quick-turn").nth(1)).toContainText(
      "ECHO segunda pergunta",
      { timeout: 10_000 },
    );
    // Each message continues the same session.
    await box.fill("WHERE");
    await page
      .getByRole("button", { name: "Enviar no chat rápido", exact: true })
      .click();
    await expect(panel.locator(".quick-turn").nth(2)).toContainText(
      '"resumed":"native-codex"',
    );
    // Closing the panel or reloading the window keeps the chat.
    await box.press("Escape");
    await expect(panel).toHaveCount(0);
    await page.reload();
    await page
      .locator(".sidebar")
      .getByRole("button", { name: /Chat rápido/ })
      .click({ timeout: 20_000 });
    await expect(panel.locator(".quick-turn")).toHaveCount(3);
    // Nothing went to the history until it is kept as a conversation.
    await expect(
      page.locator(".sidebar .task-row", { hasText: "WHERE" }),
    ).toHaveCount(0);
    await panel
      .getByRole("button", { name: "Levar para uma conversa" })
      .click();
    await expect(panel).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "WHERE", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".messages")).toContainText(
      "ECHO segunda pergunta",
    );
    await page.keyboard.press("Control+j");
    await expect(panel).toContainText("Pergunte ou peça algo rápido");
    // "Nova" starts over.
    await box.fill("ECHO descartável");
    await box.press("Enter");
    await expect(panel.locator(".quick-turn")).toContainText(
      "ECHO descartável",
    );
    await expect(panel.locator(".working")).toHaveCount(0);
    await panel.getByRole("button", { name: "Novo chat rápido" }).click();
    await expect(panel.locator(".quick-turn")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
