import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/main/store";
import { defaultImages, type Entry, type Task } from "../../src/shared/types";
test("confirmação antes de apagar: o pedido mostra o alcance do comando", async () => {
  const root = resolve(".codebit-test", "blast-" + randomUUID());
  const data = join(root, "data");
  await mkdir(join(data, "scratch"), { recursive: true });
  const store = new Store(data);
  const now = new Date().toISOString();
  const task = store.put<Task>("task", {
    id: randomUUID(),
    projectId: "",
    title: "Limpeza do projeto",
    agent: "claude",
    model: "",
    cwd: join(data, "scratch"),
    worktree: false,
    mode: "bypass",
    status: "waiting",
    archived: false,
    createdAt: now,
    updatedAt: now,
    images: defaultImages,
  });
  store.put<Entry>("entry", {
    id: randomUUID(),
    taskId: task.id,
    kind: "user",
    text: "Limpe a pasta de trabalho da armadura antiga.",
    createdAt: now,
  });
  store.put<Entry>("entry", {
    id: randomUUID(),
    taskId: task.id,
    kind: "request",
    text: "Confirmar comando que apaga arquivos?",
    createdAt: now,
    request: {
      id: "hook-1",
      kind: "approval",
      title: "Confirmar comando que apaga arquivos?",
      detail: "rm -rf work",
      choices: ["decline", "accept"],
      tool: "Bash",
      blast: {
        summary: "Apaga 4.405 arquivos e 312 pastas · 93,7 GB",
        files: 4405,
        dirs: 312,
        bytes: 100_600_000_000,
        entries: [
          { path: "work\\oraculo_astral", bytes: 64_400_000_000, dir: true },
          { path: "work\\flesh_rakshasa", bytes: 29_100_000_000, dir: true },
          { path: "work\\notas.md", bytes: 12_000, dir: false },
        ],
        more: 9,
        outside: true,
      },
    },
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
      .getByRole("button", { name: "Limpeza do projeto" })
      // Right after a build the first window can take a while.
      .click({ timeout: 45_000 });
    const scope = page.getByRole("group", { name: "Alcance do comando" });
    await expect(scope).toContainText(
      "Apaga 4.405 arquivos e 312 pastas · 93,7 GB",
    );
    await expect(scope).toContainText("Inclui itens fora da pasta da tarefa.");
    await expect(scope).toContainText("work\\oraculo_astral");
    await expect(scope).toContainText("60 GB");
    await expect(scope).toContainText("e mais 9");
    const card = page.locator(".request-card.pending");
    await expect(card.getByRole("button", { name: "Cancelar" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Permitir" })).toBeVisible();
    // The limits live in Settings → Comportamento.
    await page
      .getByRole("button", { name: "Configurações", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Comportamento", exact: true })
      .click();
    await expect(page.getByText("Confirmação antes de apagar")).toBeVisible();
    await expect(page.getByLabel("A partir de quantos arquivos")).toHaveValue(
      "50",
    );
    await expect(page.getByLabel("A partir de quantos MB")).toHaveValue("1024");
  } finally {
    await app.close();
  }
});
