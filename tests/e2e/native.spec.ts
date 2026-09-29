import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

test("CLIs reais: descoberta, catálogo, conversa e retomada nativa", async () => {
  test.skip(
    process.env.CODEBIT_NATIVE_TEST !== "1",
    "Teste opt-in: utiliza os logins e a cota dos CLIs instalados.",
  );
  test.setTimeout(240000);
  const root = resolve(".codebit-test", "native-e2e-" + randomUUID());
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
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
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "O que vamos construir?" }),
    ).toBeVisible();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, project);
    const projectId = await page.evaluate(async () => {
      const p = await window.codebit.call<any>("project.add");
      await window.codebit.call("project.trust", { id: p.id, trusted: true });
      return p.id;
    });
    for (const agent of ["codex", "claude"]) {
      await expect
        .poll(
          () =>
            page.evaluate(async (agent) => {
              const snapshot = await window.codebit.call<any>("snapshot");
              return snapshot.agents.find((a: any) => a.id === agent)
                ?.catalogStatus;
            }, agent),
          { timeout: 60000 },
        )
        .toBe("ready");
      const auth = await page.evaluate(async (agent) => {
        const snapshot = await window.codebit.call<any>("snapshot");
        return snapshot.agents.find((a: any) => a.id === agent);
      }, agent);
      expect(auth.auth).toBe("ready");
      expect(auth.models.length).toBeGreaterThan(0);
      const taskId = await page.evaluate(
        async ({ projectId, agent }) => {
          const t = await window.codebit.call<any>("task.create", {
            projectId,
            agent,
            title: "Smoke " + agent,
          });
          await window.codebit.call("task.update", {
            id: t.id,
            patch: { mode: "plan" },
          });
          return t.id;
        },
        { projectId, agent },
      );
      await page
        .getByRole("button", { name: "Smoke " + agent, exact: true })
        .click();
      // Model and effort live in the agent chip of the composer.
      const openPicker = () =>
        page.getByRole("button", { name: "Agente e modelo" }).click();
      await openPicker();
      const modelPicker = page.getByLabel("Modelo do agente", { exact: true });
      const effortPicker = page.getByLabel("Esforço do agente", {
        exact: true,
      });
      await expect(effortPicker).toBeDisabled();
      const model = auth.models.find((m: any) => m.efforts?.includes("low"));
      expect(model).toBeTruthy();
      await modelPicker.selectOption(model.id);
      await expect(effortPicker).toBeEnabled();
      expect(
        await effortPicker
          .locator("option")
          .evaluateAll((options) =>
            options.map((o) => (o as HTMLOptionElement).value),
          ),
      ).toEqual(["", ...model.efforts]);
      await effortPicker.selectOption("low");
      await expect(effortPicker).toHaveValue("low");
      await page.reload();
      await openPicker();
      await expect(modelPicker).toHaveValue(model.id);
      await expect(effortPicker).toHaveValue("low");
      if (agent === "codex") {
        const png = await app.evaluate(async ({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          win.webContents.setBackgroundThrottling(false);
          return (
            await win.webContents.capturePage(undefined, {
              stayHidden: true,
              stayAwake: true,
            })
          )
            .toPNG()
            .toString("base64");
        });
        await writeFile(
          resolve("test-results/models-effort.png"),
          Buffer.from(png, "base64"),
        );
      }
      let nativeId = "";
      for (const round of process.env.CODEBIT_CATALOG_ONLY === "1"
        ? []
        : [1, 2]) {
        if (round === 2) {
          await effortPicker.selectOption("");
          await expect(effortPicker).toHaveValue("");
        }
        await page.evaluate(
          ({ id, round }) =>
            window.codebit.call("task.send", {
              id,
              text: `Responda somente CODEBIT_OK_${round}. Não use ferramentas, não leia arquivos e não altere nada.`,
            }),
          { id: taskId, round },
        );
        await expect
          .poll(
            () =>
              page.evaluate(async (id) => {
                const r = await window.codebit.call<any>("task.read", { id });
                return r.task.status;
              }, taskId),
            { timeout: 80000, intervals: [500, 1000] },
          )
          .toBe("idle");
        const read = await page.evaluate(
          (id) => window.codebit.call<any>("task.read", { id }),
          taskId,
        );
        expect(read.entries.filter((e: any) => e.kind === "error")).toEqual([]);
        expect(
          read.entries.filter((e: any) => e.kind === "assistant").at(-1).text,
        ).toContain(`CODEBIT_OK_${round}`);
        expect(read.task.nativeId).toBeTruthy();
        expect(read.task.model).toBe(model.id);
        expect(read.task.effort).toBe(round === 1 ? "low" : "");
        if (nativeId) expect(read.task.nativeId).toBe(nativeId);
        nativeId = read.task.nativeId;
      }
      const noEffort = auth.models.find((m: any) => !m.efforts?.length);
      if (noEffort) {
        await effortPicker.selectOption("low");
        await modelPicker.selectOption(noEffort.id);
        await expect(effortPicker).toBeDisabled();
        await expect(effortPicker).toHaveValue("");
      }
    }
  } finally {
    await app.close();
  }
});
