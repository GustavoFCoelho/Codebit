import { test, expect, _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

test("voz: desligada, motor ausente, revisão explícita e pausa visível, sem áudio", async () => {
  const root = resolve(".codebit-test", "voice-ui-" + randomUUID());
  await mkdir(root, { recursive: true });
  await build({
    entryPoints: ["tests/fixtures/voice-ui.tsx"],
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    outfile: join(root, "voice.js"),
  });
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="voice.css"><div id="root"></div><script src="voice.js"></script>',
  );
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    ),
    CODEBIT_VOICE_UI_DATA: join(root, "data"),
    CODEBIT_VOICE_UI_PAGE: join(root, "index.html"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [resolve("tests/fixtures/voice-ui.cjs")],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Voz · Desligada" }).click();
    await expect(
      page.getByRole("button", { name: "Ativar microfone local" }),
    ).toBeDisabled();
    await expect(page.getByLabel("Tarefa de destino da voz")).toHaveValue("");
    await page
      .getByRole("button", { name: "Verificar motor sem abrir microfone" })
      .click();
    await expect(
      page.getByText("Nenhum reconhecedor local compatível foi encontrado."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Ativar microfone local" }),
    ).toBeDisabled();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const png = await app.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(
          undefined,
          { stayHidden: true, stayAwake: true },
        )
      )
        .toPNG()
        .toString("base64"),
    );
    await writeFile(
      resolve("test-results/voice-unavailable.png"),
      Buffer.from(png, "base64"),
    );
    await page.evaluate(() =>
      (window as any).voiceTest.emit({
        phase: "review",
        enabled: true,
        taskId: "task-123456",
        draft: {
          id: "draft-1",
          taskId: "task-123456",
          text: "Texto reconhecido",
        },
      }),
    );
    await expect(page.getByLabel("Tarefa de destino da voz")).toBeDisabled();
    await expect(
      page.getByText("Confirmar instrução para Projeto / Revisar · task-123"),
    ).toBeVisible();
    await page.getByLabel("Instrução reconhecida").fill("Texto corrigido");
    await page.getByRole("button", { name: "Confirmar e enviar" }).click();
    expect(
      await page.evaluate(() =>
        (window as any).voiceTest.calls.filter(
          (c: any) => c.method === "voice.confirm",
        ),
      ),
    ).toEqual([
      {
        method: "voice.confirm",
        args: { draftId: "draft-1", text: "Texto corrigido" },
      },
    ]);
    await page.getByRole("button", { name: "Pausar microfone" }).click();
    await expect(
      page.getByRole("button", { name: "Voz · Pausada · microfone fechado" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Desligar voz" }).click();
    await expect(
      page.getByRole("button", { name: "Voz · Desligada" }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});
