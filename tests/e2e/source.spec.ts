import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
test("modo código: avisa do código novo, recarrega a interface e reinicia", async () => {
  // A stand-in project folder: the test writes the build stamp itself, as an
  // agent's npm run build would, so no real build runs.
  const root = resolve(".codebit-test", "source-" + randomUUID());
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  const stamp = (core: string, ui: string) =>
    writeFile(
      join(root, "dist", "build.json"),
      JSON.stringify({
        version: "0",
        builtAt: new Date().toISOString(),
        core,
        interface: ui,
      }),
    );
  await stamp("c1", "i1");
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    ),
    CODEBIT_DATA_DIR: join(root, "data"),
    CODEBIT_TEST_MODE: "1",
    CODEBIT_SOURCE_ROOT: root,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: process.env.CODEBIT_EXECUTABLE ? [] : ["."],
    executablePath: process.env.CODEBIT_EXECUTABLE,
    env,
  });
  try {
    const page = await app.firstWindow();
    const pill = page.locator(".update-pill");
    // The first window after a build can take a while to show.
    await expect(page.getByText("Seu workspace local")).toBeVisible({
      timeout: 20_000,
    });
    await expect(pill).toHaveCount(0);
    await stamp("c1", "i2");
    await expect(pill).toHaveText("Interface atualizada · Recarregar");
    const reloaded = page.waitForEvent("load");
    await pill.getByRole("button").click();
    await reloaded;
    await expect(page.getByText("Seu workspace local")).toBeVisible({
      timeout: 20_000,
    });
    await expect(pill).toHaveCount(0);
    // The core changed: a restart, intercepted so no second app starts.
    await app.evaluate(({ app }) => {
      const g = globalThis as any;
      app.relaunch = ((options: any) => (g.relaunch = options)) as any;
      app.quit = (() => (g.quit = true)) as any;
    });
    await stamp("c2", "i2");
    await expect(pill).toHaveText("App atualizado · Reiniciar");
    await pill.getByRole("button").click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as any).quit))
      .toBe(true);
    const args: string[] = await app.evaluate(
      () => (globalThis as any).relaunch.args,
    );
    expect(args.at(-1)).toMatch(/^--after-update=\d+$/);
    await page
      .getByRole("button", { name: "Configurações", exact: true })
      .click();
    await page.getByRole("button", { name: "Aplicativo", exact: true }).click();
    await expect(page.locator(".settings-page")).toContainText(
      "Rodando da pasta",
    );
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
});
