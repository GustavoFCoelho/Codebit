import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/main/store";
import { defaultImages, type Task } from "../../src/shared/types";
test("contexto: a barra de status mostra do que o contexto é feito", async () => {
  const root = resolve(".codebit-test", "context-" + randomUUID());
  const data = join(root, "data");
  await mkdir(join(data, "scratch"), { recursive: true });
  const store = new Store(data);
  const now = new Date().toISOString();
  const task = (
    title: string,
    agent: Task["agent"],
    context: Task["context"],
  ) =>
    store.put<Task>("task", {
      id: randomUUID(),
      projectId: "",
      title,
      agent,
      model: "",
      cwd: join(data, "scratch"),
      worktree: false,
      mode: "bypass",
      status: "idle",
      archived: false,
      createdAt: now,
      updatedAt: now,
      images: defaultImages,
      context,
    });
  task("Revisão longa", "claude", {
    used: 100_000,
    size: 200_000,
    deferred: 21_000,
    parts: [
      {
        id: "instructions",
        tokens: 2_700,
        items: [
          { label: "Prompt de sistema e instruções do Codebit", tokens: 2_400 },
          { label: "CLAUDE.md (projeto)", tokens: 300 },
        ],
      },
      {
        id: "tools",
        tokens: 10_500,
        items: [
          { label: "Ferramentas do Claude Code", tokens: 9_500 },
          { label: "MCP · codebit_images", tokens: 1_000 },
        ],
      },
      {
        id: "skills",
        tokens: 5_200,
        items: [{ label: "dataviz", tokens: 480 }],
      },
      {
        id: "conversation",
        tokens: 81_600,
        items: [
          {
            label:
              "Resultados de ferramentas (arquivos lidos, saídas de comandos)",
            tokens: 60_000,
          },
          { label: "Respostas do agente", tokens: 12_000 },
        ],
      },
      { id: "reserve", tokens: 33_000 },
    ],
  });
  task("Com o Codex", "codex", { used: 50_000, size: 200_000 });
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
      .getByRole("button", { name: "Revisão longa" })
      // Right after a build the first window can take a while.
      .click({ timeout: 45_000 });
    const meter = page.locator(".statusbar button.context-meter");
    await expect(meter).toContainText("100k livres de 200k");
    await meter.click();
    const panel = page.getByRole("dialog", { name: "Uso de contexto" });
    await expect(panel).toContainText("100k de 200k · 50%");
    // One row per part, with its share of what is in use.
    for (const [name, share] of [
      ["Instruções", "2,7%"],
      ["Ferramentas", "11%"],
      ["Skills", "5,2%"],
      ["Conversa", "82%"],
    ])
      await expect(panel.locator("summary", { hasText: name })).toContainText(
        share,
      );
    await expect(panel.locator(".context-segment")).toHaveCount(4);
    // Each part opens to its heaviest pieces.
    await panel.locator("summary", { hasText: "Conversa" }).click();
    await expect(panel).toContainText("Resultados de ferramentas");
    await expect(panel).toContainText("Reserva de compactação: 33k");
    await expect(panel).toContainText("Ferramentas adiadas: 21k");
    await expect(panel.locator(".context-tip")).toContainText(
      "o que as ferramentas devolveram",
    );
    // Escape closes it.
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    // Codex tells only the total.
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "Com o Codex" })
      .click();
    await meter.click();
    await expect(panel).toContainText("informa só o total");
  } finally {
    await app.close();
  }
});
