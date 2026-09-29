import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
test("atualização: avisa da versão nova e troca ao clicar", async () => {
  const root = resolve(".codebit-test", "update-" + randomUUID());
  const releases = join(root, "release");
  await mkdir(releases, { recursive: true });
  // A harmless program stands in for the new build: it prints and exits.
  const build = join(releases, "Codebit-9.9.9-Windows.exe");
  await copyFile(
    join(process.env.SystemRoot!, "System32", "whoami.exe"),
    build,
  );
  const sha = createHash("sha256")
    .update(await readFile(build))
    .digest("hex");
  await writeFile(build + ".sha256", `${sha}  Codebit-9.9.9-Windows.exe\n`);
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
  const page = await app.firstWindow();
  await page.evaluate(async (folder) => {
    const s = await window.codebit.call<any>("snapshot");
    await window.codebit.call("settings.save", {
      ...s.settings,
      updateFolder: folder,
    });
    await window.codebit.call("update.check");
  }, releases);
  const pill = page.locator(".update-pill");
  await expect(pill).toHaveText("v9.9.9 disponível · Atualizar");
  await page
    .getByRole("button", { name: "Configurações", exact: true })
    .click();
  await page.getByRole("button", { name: "Aplicativo", exact: true }).click();
  await expect(page.locator(".settings-page")).toContainText("v9.9.9");
  await expect(page.locator(".update-folder")).toHaveText(releases);
  // Nothing is running, so the click starts the new build and quits.
  const closed = app.waitForEvent("close");
  await pill.getByRole("button").click();
  await closed;
});
