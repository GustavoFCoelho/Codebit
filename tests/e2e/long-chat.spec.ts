import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/main/store";
import { defaultImages, type Entry, type Task } from "../../src/shared/types";

// Mirrors a real long session: mostly tool activity, answered approvals and
// markdown replies. Typing must not re-render the whole conversation.
test("chat longo: digitar continua rápido e o contexto pode ser ocultado", async () => {
  test.setTimeout(120_000);
  const entryCount = 10_000;
  const root = resolve(".codebit-test", "long-chat-" + randomUUID());
  const data = join(root, "data");
  await mkdir(data, { recursive: true });
  const store = new Store(data);
  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    projectId: "",
    title: "Conversa longa",
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
  };
  store.put("task", task);
  const reply =
    "## Resultado\n\nAlterei `src/main/runtime.ts` e rodei os testes:\n\n```ts\nexport const value = compute(input);\n```\n\n- item um\n- item dois\n\n| a | b |\n|---|---|\n| 1 | 2 |";
  store.db.exec("BEGIN");
  for (let i = 0; i < entryCount; i++) {
    const kind: Entry["kind"] =
      i % 10 < 5
        ? "activity"
        : i % 10 < 8
          ? "request"
          : i % 10 < 9
            ? "assistant"
            : "user";
    store.put<Entry>("entry", {
      id: randomUUID(),
      taskId: task.id,
      kind,
      text:
        kind === "activity"
          ? `Terminal · npm test -- ${i}`
          : kind === "request"
            ? "Permitir execução?"
            : kind === "assistant"
              ? reply
              : `Mensagem ${i}`,
      createdAt: now,
      resolved: kind === "request" ? true : undefined,
      request:
        kind === "request"
          ? {
              id: String(i),
              kind: "approval",
              title: "Permitir execução?",
              detail: "npm test",
              choices: ["decline", "accept"],
            }
          : undefined,
    });
  }
  store.db.exec("COMMIT");
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
    await page.getByRole("button", { name: "Conversa longa" }).click();
    const message = page.getByLabel("Mensagem", { exact: true });
    await expect(message).toBeVisible();
    await expect(page.locator(".entry")).toHaveCount(entryCount);
    await expect(page.locator(".entry").last()).toBeInViewport();
    await message.click();
    const measure = (refresh: boolean) =>
      page.evaluate(
        async ({ refresh, taskId }) => {
          const el = document.querySelector<HTMLTextAreaElement>(
            'textarea[aria-label="Mensagem"]',
          )!;
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
          )!.set!;
          const times: number[] = [];
          const layoutTimes: number[] = [];
          // React commits controlled inputs synchronously; reading offsetHeight
          // then forces the style and layout work of the next frame, so this is
          // the time the text box stays blocked per key (rAF is throttled in
          // hidden windows).
          for (let i = 0; i < 20; i++) {
            if (refresh && i % 4 === 0) {
              await window.codebit.call("task.update", {
                id: taskId,
                patch: { title: "Conversa longa" },
              });
              await new Promise((r) => setTimeout(r, 20));
            }
            const start = performance.now();
            setter.call(el, el.value + "a");
            el.dispatchEvent(new Event("input", { bubbles: true }));
            const rendered = performance.now();
            void document.body.offsetHeight;
            layoutTimes.push(performance.now() - rendered);
            times.push(performance.now() - start);
            await new Promise((r) => setTimeout(r, 10));
          }
          return {
            total: times.reduce((a, b) => a + b) / times.length,
            p95: times.sort((a, b) => a - b)[Math.floor(times.length * 0.95)],
            layout: layoutTimes.reduce((a, b) => a + b) / layoutTimes.length,
          };
        },
        { refresh, taskId: task.id },
      );
    for (const refresh of [false, true]) {
      const cost = await measure(refresh);
      console.log(
        `Custo por tecla (${refresh ? "com atualizações" : "parado"}): ${cost.total.toFixed(1)} ms; p95: ${cost.p95.toFixed(1)} ms; layout: ${cost.layout.toFixed(1)} ms`,
      );
      expect(cost.total).toBeLessThan(10);
      expect(cost.p95).toBeLessThan(25);
    }
    await expect(message).toHaveValue("a".repeat(40));
    // Native keyboard input and replacement in the middle of the draft must
    // retain the caret and never be rolled back by a delayed parent commit.
    await message.press("Control+Home");
    await message.pressSequentially("Texto inicial ", { delay: 1 });
    await expect(message).toHaveValue("Texto inicial " + "a".repeat(40));
    await message.press("Control+A");
    await message.pressSequentially("Novo rascunho", { delay: 1 });
    await expect(message).toHaveValue("Novo rascunho");
    // Offscreen batches must remain reachable, including across their edges.
    for (const index of [0, 99, 100, 5_000, entryCount - 1]) {
      const row = page.locator(".entry").nth(index);
      await row.scrollIntoViewIfNeeded();
      await expect(row).toBeInViewport();
    }
    // Refreshing while reading older history must not jump to the bottom.
    const oldRow = page.locator(".entry").nth(100);
    await oldRow.scrollIntoViewIfNeeded();
    await expect(oldRow).toBeInViewport();
    await page.evaluate(
      (id) =>
        window.codebit.call("task.update", {
          id,
          patch: { title: "Conversa longa atualizada" },
        }),
      task.id,
    );
    await expect(
      page
        .locator(".sidebar")
        .getByRole("button", {
          name: "Conversa longa atualizada",
          exact: true,
        }),
    ).toBeVisible();
    await expect(oldRow).toBeInViewport();
    await page.getByRole("button", { name: "Ocultar contexto" }).click();
    // Tool runs and answered approvals leave the conversation.
    await expect(page.locator(".entry")).toHaveCount(entryCount / 5);
    await page.getByRole("button", { name: "Mostrar contexto" }).click();
    await expect(page.locator(".entry")).toHaveCount(entryCount);
  } finally {
    await app.close();
  }
});
