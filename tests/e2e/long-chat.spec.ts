import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/main/store";
import { defaultImages, type Entry, type Task } from "../../src/shared/types";

// Mirrors a real long session: mostly tool activity, answered approvals and
// markdown replies. Typing must not re-render the whole conversation.
test("chat longo: digitar continua rápido e o contexto pode ser ocultado", async () => {
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
  for (let i = 0; i < 900; i++) {
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
    await expect(page.locator(".entry")).toHaveCount(900);
    await message.click();
    const perKey = await page.evaluate(async () => {
      const el = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Mensagem"]',
      )!;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      const times: number[] = [];
      // React commits controlled inputs synchronously; reading offsetHeight
      // then forces the style and layout work of the next frame, so this is
      // the time the text box stays blocked per key (rAF is throttled in
      // hidden windows).
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        setter.call(el, el.value + "a");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        void document.body.offsetHeight;
        times.push(performance.now() - start);
        await new Promise((r) => setTimeout(r, 10));
      }
      return times.reduce((a, b) => a + b) / times.length;
    });
    console.log(`Custo por tecla: ${perKey.toFixed(1)} ms`);
    // Re-rendering all 900 rows took ~57 ms per key and memoized rows ~1 ms,
    // but the layout of the whole conversation still took ~19 ms until the
    // message list got layout containment.
    expect(perKey).toBeLessThan(10);
    await page.getByRole("button", { name: "Ocultar contexto" }).click();
    // 450 tool runs and 270 answered approvals leave the conversation.
    await expect(page.locator(".entry")).toHaveCount(180);
    await page.getByRole("button", { name: "Mostrar contexto" }).click();
    await expect(page.locator(".entry")).toHaveCount(900);
  } finally {
    await app.close();
  }
});
