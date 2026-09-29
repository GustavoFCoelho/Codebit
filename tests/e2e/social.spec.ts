import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/main/store";
import { defaultImages, type Entry, type Task } from "../../src/shared/types";
// A 1x1 PNG, enough for the preview to load.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8uoAAAAASUVORK5CYII=",
  "base64",
);
test("redes sociais: conectar o Instagram e aprovar a prévia do post", async () => {
  const root = resolve(".codebit-test", "social-" + randomUUID());
  const project = join(root, "forja");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "arte.png"), png);
  // A fake Instagram that knows one token.
  const graph = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.searchParams.get("access_token") !== "token-e2e")
      return reply(400, { error: { code: 190 } });
    if (url.pathname === "/v23.0/me")
      return reply(200, {
        user_id: "178",
        username: "forja.art",
        account_type: "MEDIA_CREATOR",
      });
    // A new token cannot be renewed before 24 hours.
    reply(400, { error: { message: "token muito novo" } });
  });
  await new Promise<void>((r) => graph.listen(0, "127.0.0.1", () => r()));
  const store = new Store(join(root, "data"));
  const now = new Date().toISOString();
  store.put("project", {
    id: "project-e2e",
    name: "Forja",
    path: project,
    git: false,
    trusted: true,
  });
  const task: Task = {
    id: randomUUID(),
    projectId: "project-e2e",
    title: "Divulgar a arte",
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
  };
  store.put("task", task);
  store.put<Entry>("entry", {
    id: randomUUID(),
    taskId: task.id,
    kind: "request",
    text: "Publicar no Instagram",
    createdAt: now,
    request: {
      id: "social-1",
      kind: "approval",
      title: "Publicar no Instagram",
      detail: "",
      choices: ["decline", "accept"],
      social: {
        network: "instagram",
        account: "@forja.art",
        images: [join(project, "arte.png")],
        text: "Nova arte da forja #pixelart",
        kind: "Feed",
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
    CODEBIT_DATA_DIR: join(root, "data"),
    CODEBIT_TEST_MODE: "1",
    CODEBIT_INSTAGRAM_API: `http://127.0.0.1:${(graph.address() as any).port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: process.env.CODEBIT_EXECUTABLE ? [] : ["."],
    executablePath: process.env.CODEBIT_EXECUTABLE,
    env,
  });
  try {
    const page = await app.firstWindow();
    // The approval shows exactly what goes out.
    await page.getByRole("button", { name: "Divulgar a arte" }).click();
    const card = page.locator(".request-card");
    await expect(card).toContainText("Publicar no Instagram");
    await expect(card.locator(".social-meta")).toContainText("@forja.art");
    await expect(card.locator(".social-text")).toHaveText(
      "Nova arte da forja #pixelart",
    );
    await expect
      .poll(() =>
        card
          .locator(".social-images img")
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(1);
    await expect(
      card.getByRole("button", { name: "Publicar", exact: true }),
    ).toBeVisible();
    await expect(
      card.getByRole("button", { name: "Não publicar" }),
    ).toBeVisible();
    // Connect the project's Instagram in Settings.
    await page
      .getByRole("button", { name: "Configurações", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Redes sociais", exact: true })
      .click();
    await expect(page.getByLabel("Projeto das redes sociais")).toHaveValue(
      "project-e2e",
    );
    await page.getByLabel("Token do Instagram").fill("token-errado");
    await page.getByRole("button", { name: "Conectar Instagram" }).click();
    await expect(page.locator(".toast")).toContainText("inválido ou expirou");
    await page.getByRole("button", { name: "Fechar aviso" }).click();
    await page.getByLabel("Token do Instagram").fill("token-e2e");
    await page.getByRole("button", { name: "Conectar Instagram" }).click();
    const social = page.locator(".social-settings");
    await expect(social).toContainText("@forja.art");
    await expect(social).toContainText("Criador de conteúdo");
    await expect(social).toContainText("Acesso válido até");
    // Only the encrypted token is kept.
    const saved = await page.evaluate(() =>
      window.codebit.call<any>("social.state", { projectId: "project-e2e" }),
    );
    expect(saved.accounts[0]).toMatchObject({
      network: "instagram",
      name: "@forja.art",
      userId: "178",
    });
    expect(JSON.stringify(saved)).not.toContain("token-e2e");
    await page.getByRole("button", { name: "MCP", exact: true }).click();
    await expect(
      page.getByText("codebit_social", { exact: true }),
    ).toBeVisible();
    // Disconnecting asks once more.
    await page
      .getByRole("button", { name: "Redes sociais", exact: true })
      .click();
    await page.getByRole("button", { name: "Desconectar" }).click();
    await page.getByRole("button", { name: "Confirmar: desconectar" }).click();
    await expect(page.getByLabel("Token do Instagram")).toBeVisible();
  } finally {
    await app.close();
    graph.closeAllConnections();
    graph.close();
  }
});
