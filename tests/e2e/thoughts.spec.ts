import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/main/store";
import { defaultImages, type Entry, type Task } from "../../src/shared/types";
test("pensamentos: recolhidos no chat e um botão para escondê-los", async () => {
  const root = resolve(".codebit-test", "thoughts-" + randomUUID());
  const data = join(root, "data");
  await mkdir(join(data, "scratch"), { recursive: true });
  const store = new Store(data);
  const now = new Date().toISOString();
  const task = store.put<Task>("task", {
    id: randomUUID(),
    projectId: "",
    title: "Revisão do texto",
    agent: "codex",
    model: "",
    cwd: join(data, "scratch"),
    worktree: false,
    mode: "bypass",
    status: "idle",
    archived: false,
    createdAt: now,
    updatedAt: now,
    images: defaultImages,
  });
  for (const [kind, text] of [
    ["user", "Revise o texto do convite."],
    ["thought", "**Lendo o convite**\n\nO tom está formal demais para o público."],
    ["assistant", "Deixei o convite mais leve."],
  ] as const)
    store.put<Entry>("entry", {
      id: randomUUID(),
      taskId: task.id,
      kind,
      text,
      createdAt: now,
      agent: "codex",
    });
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
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "Revisão do texto" })
      // Right after a build the first window can take a while.
      .click({ timeout: 45_000 });
    // A finished thought is one line, with its first line as a preview.
    const head = page.getByRole("button", { name: /Pensamento/ });
    await expect(head).toContainText("Lendo o convite");
    await expect(head).toHaveAttribute("aria-expanded", "false");
    const detail = page.getByText("O tom está formal demais para o público.");
    await expect(detail).toHaveCount(0);
    await head.click();
    await expect(detail).toBeVisible();
    // The button beside "Ocultar contexto" hides them, and remembers it.
    const toggle = page.getByRole("button", { name: "Ocultar pensamentos" });
    await toggle.click();
    await expect(head).toHaveCount(0);
    await expect(page.getByText("Deixei o convite mais leve.")).toBeVisible();
    await page.reload();
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "Revisão do texto" })
      .click({ timeout: 45_000 });
    await expect(page.getByText("Deixei o convite mais leve.")).toBeVisible();
    await expect(head).toHaveCount(0);
    await page.getByRole("button", { name: "Mostrar pensamentos" }).click();
    await expect(head).toBeVisible();
  } finally {
    await app.close();
  }
});
