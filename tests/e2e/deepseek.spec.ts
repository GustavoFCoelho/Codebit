import { test, expect, _electron as electron } from "@playwright/test";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

test("DeepSeek tem configuração de chave e catálogo na tela de agentes", async () => {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    CODEBIT_DATA_DIR: resolve(".codebit-test", "deepseek-ui-" + randomUUID()),
    CODEBIT_TEST_MODE: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DEEPSEEK_API_KEY;
  const app = await electron.launch({ args: ["."], env });
  try {
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Configurações", exact: true })
      .click({ timeout: 45000 });
    const key = page.getByLabel("Chave de API DeepSeek");
    await expect(key).toBeVisible();
    await expect(key).toHaveAttribute("type", "password");
    const save = page.getByRole("button", {
      name: "Salvar chave e consultar modelos",
    });
    await expect(save).toBeDisabled();
    await key.fill("fixture-not-a-real-key");
    await expect(save).toBeEnabled();
    await key.fill("");
    await expect(
      page.getByText("O agente usa o DeepSeek Harness", { exact: false }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});
