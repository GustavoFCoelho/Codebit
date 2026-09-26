import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";

test("abre tarefa com diff grande sem derrubar o processo principal", async () => {
  const root = resolve(".codebit-test", "large-diff-" + randomUUID());
  const project =
    process.env.CODEBIT_REGRESSION_PROJECT || join(root, "project");
  await mkdir(root, { recursive: true });
  // An explicitly supplied regression project is inspected without writing to it.
  if (!process.env.CODEBIT_REGRESSION_PROJECT) {
    await mkdir(project, { recursive: true });
    const git = (args: string[]) =>
      promisify(execFile)("git", args, { cwd: project, windowsHide: true });
    await git(["init"]);
    await writeFile(join(project, "generated.js"), "original\n");
    await git(["add", "generated.js"]);
    await git([
      "-c",
      "user.name=Codebit Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-m",
      "fixture",
    ]);
    await writeFile(
      join(project, "generated.js"),
      `export const data = "${"x".repeat(12_000_000)}";\n`,
    );
  }
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
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("heading", { name: "O que vamos construir?" }),
    ).toBeVisible();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, project);
    const taskId = await page.evaluate(async () => {
      const p = await window.codebit.call<any>("project.add");
      const t = await window.codebit.call<any>("task.create", {
        projectId: p.id,
        title: "Regressão de diff grande",
        agent: "claude",
      });
      return t.id;
    });
    await page
      .getByRole("button", { name: "Regressão de diff grande", exact: true })
      .click();
    await expect(
      page.getByText(/Prévia de alterações reduzida:/),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Regressão de diff grande",
        exact: true,
      }),
    ).toBeVisible();
    const snapshot = await page.evaluate(() =>
      window.codebit.call<any>("snapshot"),
    );
    expect(snapshot.tasks[0].id).toBe(taskId);
    // Keep navigating after the overflowing child process has been stopped.
    await page.getByRole("button", { name: "Arquivos", exact: true }).click();
    await expect(
      page.getByText("Arquivos do projeto", { exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
