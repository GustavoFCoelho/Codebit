import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/main/store";
test("secrets: criar, editar e excluir sem o valor voltar para a tela", async () => {
  const root = resolve(".codebit-test", "secrets-" + randomUUID());
  const data = join(root, "data");
  await mkdir(root, { recursive: true });
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
  const value = "sk-teste-valor-que-nao-aparece";
  try {
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Configurações", exact: true })
      .click({ timeout: 20_000 });
    await page.getByRole("button", { name: "Secrets", exact: true }).click();
    await expect(page.getByText("Nenhum secret ainda")).toBeVisible();
    await page.getByRole("button", { name: "Adicionar secret" }).click();
    // The name becomes a variable name as it is typed.
    await page.getByLabel("Nome do secret").fill("chave do projeto");
    await expect(page.getByLabel("Nome do secret")).toHaveValue(
      "CHAVE_DO_PROJETO",
    );
    await page.getByLabel("Valor do secret").fill(value);
    await expect(page.getByLabel("Valor do secret")).toHaveAttribute(
      "type",
      "password",
    );
    await page.getByLabel("Descrição do secret").fill("API do projeto");
    await page.getByRole("button", { name: "Salvar secret" }).click();
    const row = page.locator(".secret-row", { hasText: "CHAVE_DO_PROJETO" });
    await expect(row).toContainText("API do projeto");
    await expect(row).toContainText("••••••••");
    expect(await page.content()).not.toContain(value);
    // Editing shows an empty value field: the saved one stays.
    await page.getByRole("button", { name: "Editar CHAVE_DO_PROJETO" }).click();
    await expect(page.getByLabel("Valor do secret")).toHaveValue("");
    await page.getByLabel("Descrição do secret").fill("API do projeto, v2");
    await page.getByRole("button", { name: "Salvar secret" }).click();
    await expect(row).toContainText("API do projeto, v2");
    // A name Claude Code reads for its login is kept from it, with a notice.
    await page.getByRole("button", { name: "Adicionar secret" }).click();
    await page.getByLabel("Nome do secret").fill("ANTHROPIC_API_KEY");
    await expect(page.locator(".modal .secret-warning")).toContainText(
      "não recebe este secret",
    );
    await page.getByLabel("Valor do secret").fill("sk-ant-teste");
    await page.getByRole("button", { name: "Salvar secret" }).click();
    await expect(
      page.locator(".secret-row", { hasText: "ANTHROPIC_API_KEY" }),
    ).toContainText("Não vai para Claude: mudaria o login");
    // Deleting asks once more.
    await page
      .getByRole("button", { name: "Excluir ANTHROPIC_API_KEY" })
      .click();
    await page.getByRole("button", { name: "Confirmar exclusão" }).click();
    await expect(
      page.locator(".secret-row", { hasText: "ANTHROPIC_API_KEY" }),
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
  // On disk, the value is encrypted.
  const store = new Store(data);
  try {
    const [secret] = store.all<{ id: string }>("user-secret");
    const saved = store.secret(`user:${secret.id}`)!;
    expect(saved).toBeTruthy();
    expect(saved).not.toContain(value);
    expect(Buffer.from(saved, "base64").toString("latin1")).not.toContain(
      value,
    );
  } finally {
    store.close();
  }
});
