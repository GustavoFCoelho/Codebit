import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
let app: ElectronApplication;
async function screenshot(name: string) {
  // Use Electron's native capture for hidden test windows on Windows.
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.setBackgroundThrottling(false);
    const image = await win.webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    return image.toPNG().toString("base64");
  });
  await writeFile(resolve("test-results", name), Buffer.from(png, "base64"));
}
test.afterEach(async () => {
  await app?.close();
});

test("imagens: seleção independente, anexo, edição e exportação", async () => {
  const root = resolve(".codebit-test", "images-e2e-" + randomUUID());
  await mkdir(root, { recursive: true });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8uoAAAAASUVORK5CYII=",
    "base64",
  );
  const reference = join(root, "referencia.png");
  await writeFile(reference, png);
  const graphs: any[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/object_info") {
      const nodes: any = Object.fromEntries(
        [
          "CheckpointLoaderSimple",
          "EmptyLatentImage",
          "CLIPTextEncode",
          "KSampler",
          "VAEDecode",
          "SaveImage",
          "LoadImage",
          "VAEEncode",
          "ImageScale",
        ].map((n) => [n, {}]),
      );
      nodes.CheckpointLoaderSimple = {
        input: { required: { ckpt_name: [["sdxl-test.safetensors"]] } },
      };
      res.end(JSON.stringify(nodes));
    } else if (req.url === "/prompt") {
      let body = "";
      for await (const b of req) body += b;
      graphs.push(JSON.parse(body).prompt);
      res.end(JSON.stringify({ prompt_id: "test-job" }));
    } else if (req.url === "/upload/image") {
      for await (const _ of req) {
        /* drain multipart body */
      }
      res.end(JSON.stringify({ name: "reference.png", subfolder: "" }));
    } else if (req.url?.startsWith("/history/")) {
      res.end(
        JSON.stringify({
          "test-job": {
            outputs: { "9": { images: [{ filename: "result.png" }] } },
          },
        }),
      );
    } else if (req.url?.startsWith("/view?")) {
      res.setHeader("Content-Type", "image/png");
      res.end(png);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      ),
      CODEBIT_TEST_MODE: "1",
      CODEBIT_DATA_DIR: join(root, "data"),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      args: process.env.CODEBIT_EXECUTABLE ? [] : ["."],
      executablePath: process.env.CODEBIT_EXECUTABLE,
      env,
    });
    const page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "O que vamos construir?" }),
    ).toBeVisible();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, root);
    await page.getByRole("button", { name: "Abrir um projeto" }).click();
    await page.getByLabel("Título", { exact: true }).fill("Criar imagem");
    await page
      .getByRole("button", { name: "Criar tarefa", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Criar imagem", exact: true }),
    ).toBeVisible();
    const taskId = await page.evaluate(
      async (port) => {
        const s = await window.codebit.call<any>("snapshot");
        await window.codebit.call("settings.save", {
          ...s.settings,
          comfyUrl: `http://127.0.0.1:${port}`,
        });
        await window.codebit.call("task.update", {
          id: s.tasks[0].id,
          patch: {
            images: {
              ...s.tasks[0].images,
              provider: "comfyui",
              model: "sdxl-test.safetensors",
            },
          },
        });
        return s.tasks[0].id;
      },
      (server.address() as any).port,
    );
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, reference);
    await page.getByRole("button", { name: "Anexar arquivos" }).click();
    await page.getByRole("button", { name: "Usar imagem para edição" }).click();
    await expect(
      page.getByText("Imagem de referência selecionada"),
    ).toBeVisible();
    await page
      .getByLabel("Mensagem", { exact: true })
      .fill("Uma variação azul");
    await page
      .getByRole("button", { name: "Gerar imagem", exact: true })
      .first()
      .click();
    await expect(page.locator(".image-message img")).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".image-message img")
          .evaluate((el: HTMLImageElement) => el.naturalWidth),
      )
      .toBe(1);
    expect(graphs).toHaveLength(1);
    expect(graphs[0]["10"].inputs.image).toBe("reference.png");
    expect(graphs[0]["12"].inputs.width).toBe(1024);
    const read = await page.evaluate(
      (id) => window.codebit.call<any>("task.read", { id }),
      taskId,
    );
    expect(read.task.agent).toBe("codex");
    expect(read.artifacts[0].model).toBe("sdxl-test.safetensors");
    const exported = join(root, "exportado.png");
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, exported);
    await page.getByRole("button", { name: "Exportar", exact: true }).click();
    await expect
      .poll(async () =>
        readFile(exported)
          .then((b) => b.equals(png))
          .catch(() => false),
      )
      .toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("fluxo desktop: projeto, confiança, tarefa, configurações e persistência", async () => {
  const root = resolve(".codebit-test", "e2e-" + randomUUID());
  const project = join(root, "Projeto de teste");
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, "hello.ts"),
    'export const greeting = "Olá, Codebit";\n',
  );
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
  app = await electron.launch({
    args: process.env.CODEBIT_EXECUTABLE ? [] : ["."],
    executablePath: process.env.CODEBIT_EXECUTABLE,
    env,
  });
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
  await page.getByRole("button", { name: "Abrir um projeto" }).click();
  await expect(
    page.getByRole("heading", { name: "Nova tarefa", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Título", { exact: true }).fill("Revisar autenticação");
  await page.getByRole("button", { name: "Criar tarefa", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Revisar autenticação", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confiar no projeto" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confiar no projeto" }).click();
  await page
    .getByLabel("Mensagem", { exact: true })
    .fill("Revise a validação de e-mail e adicione testes.");
  await page.getByRole("button", { name: "Arquivos", exact: true }).click();
  await page.getByRole("button", { name: "hello.ts", exact: true }).click();
  await expect(page.locator(".monaco-editor")).toBeVisible();
  await expect(page.locator(".view-lines")).toContainText("Olá, Codebit");
  await expect
    .poll(async () =>
      page.locator(".monaco-editor").evaluate((el) => el.clientWidth),
    )
    .toBeGreaterThan(300);
  await screenshot("01-workspace.png");
  const initial = await page.evaluate(() =>
    window.codebit.call<any>("snapshot"),
  );
  const taskId = initial.tasks[0].id;
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".xterm")).toBeVisible();
  await page.evaluate(async (id) => {
    await window.codebit.call("terminal.open", { id });
    await window.codebit.call("terminal.write", {
      id,
      data: "Write-Output ('CODEBIT_' + 'TERMINAL_OK')\r",
    });
  }, taskId);
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const r = await window.codebit.call<any>("terminal.open", { id });
          return r.buffer.includes("CODEBIT_TERMINAL_OK");
        }, taskId),
      { timeout: 15000 },
    )
    .toBe(true);
  await expect(page.getByLabel("Agente", { exact: true })).toHaveValue("codex");
  await page.getByRole("button", { name: "Configurar sub-agentes" }).click();
  const subagents = page.getByRole("dialog", { name: "Sub-agentes" });
  // Controlled by the saved task, so it turns checked after the IPC round trip.
  const delegate = subagents.getByLabel(
    "Permitir que o agente delegue a sub-agentes",
  );
  await delegate.click();
  await expect(delegate).toBeChecked();
  await subagents.getByLabel("Quantidade de sub-agentes").fill("3");
  await expect(
    page.getByRole("button", { name: "Configurar sub-agentes" }),
  ).toHaveText(/Codex · 3/);
  await page.getByRole("button", { name: "Configurar sub-agentes" }).click();
  // New tasks start in Bypass, with no warning; the toggle shows the mode.
  const modes = page.locator(".chat .mode-toggle");
  await expect(
    modes.getByRole("button", { name: "Bypass", exact: true }),
  ).toHaveClass(/selected/);
  await expect(page.getByText("Bypass ativo")).toHaveCount(0);
  await modes.getByRole("button", { name: "Executar", exact: true }).click();
  await expect(
    modes.getByRole("button", { name: "Executar", exact: true }),
  ).toHaveClass(/selected/);
  await page.getByRole("button", { name: "Nova conversa sem projeto" }).click();
  await page.getByLabel("Título", { exact: true }).fill("Ideias soltas");
  await page.getByRole("button", { name: "Criar tarefa", exact: true }).click();
  await expect(
    page.getByText("Conversa sem projeto", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Confie nesta pasta para começar")).toHaveCount(
    0,
  );
  await page.getByLabel("Mensagem", { exact: true }).evaluate((el) => {
    const data = new DataTransfer();
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8uoAAAAASUVORK5CYII=",
      ),
      (c) => c.charCodeAt(0),
    );
    data.items.add(new File([png], "print.png", { type: "image/png" }));
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true }),
    );
  });
  await expect(page.locator(".attachment-row")).toContainText(
    "imagem-colada.png",
  );
  await expect(page.locator(".context-meter")).toContainText("Contexto");
  await expect(page.locator(".quota-meter")).toContainText(/Cota|Plano/, {
    timeout: 30000,
  });
  await page.getByLabel("Mensagem", { exact: true }).fill("/");
  const palette = page.getByRole("listbox", { name: "Skills e comandos" });
  await expect(palette).toContainText("Skills e comandos · Codex");
  await expect(palette).not.toContainText("Consultando o CLI", {
    timeout: 30000,
  });
  await expect(palette.getByRole("option").first()).toBeVisible();
  await page.getByLabel("Mensagem", { exact: true }).press("Escape");
  await expect(palette).toHaveCount(0);
  await page.getByLabel("Mensagem", { exact: true }).fill("");
  await page
    .getByRole("button", { name: "Configurações", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Agentes e modelos", exact: true }),
  ).toBeVisible();
  await screenshot("02-agentes.png");
  const guidelines = page.getByLabel("Diretrizes para os agentes");
  await expect(guidelines).toHaveValue(/desatualizada/);
  await guidelines.fill("Sempre rode os testes.");
  await page.getByRole("button", { name: "Salvar diretrizes" }).click();
  await expect(page.getByText("Configurações salvas.")).toBeVisible();
  expect(
    await page.evaluate(
      async () =>
        (await window.codebit.call<any>("snapshot")).settings.guidelines,
    ),
  ).toBe("Sempre rode os testes.");
  await page.getByRole("button", { name: "Restaurar padrão" }).click();
  await expect(guidelines).toHaveValue(/desatualizada/);
  await page.getByRole("button", { name: "Imagens", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Geração de imagens" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Codex · Login local" }),
  ).toBeVisible();
  await expect(page.getByLabel("Chave da API")).toHaveAttribute(
    "type",
    "password",
  );
  await screenshot("03-imagens-config.png");
  await page.getByRole("button", { name: "MCP", exact: true }).click();
  await expect(page.getByText("codebit_images", { exact: true })).toBeVisible();
  const snapshot = await page.evaluate(() =>
    window.codebit.call<any>("snapshot"),
  );
  expect(snapshot.projects).toHaveLength(1);
  const review = snapshot.tasks.find(
    (t: any) => t.title === "Revisar autenticação",
  );
  expect(review.cwd).toBe(project);
  expect(review.subagents).toMatchObject({ enabled: true, max: 3 });
  expect(review.mode).toBe("execute");
  expect(
    snapshot.tasks.find((t: any) => t.title === "Ideias soltas").projectId,
  ).toBe("");
  expect(snapshot.projects[0].trusted).toBe(true);
  expect(errors).toEqual([]);
  await app.close();
  app = await electron.launch({
    args: process.env.CODEBIT_EXECUTABLE ? [] : ["."],
    executablePath: process.env.CODEBIT_EXECUTABLE,
    env,
  });
  const reopened = await app.firstWindow();
  // The last selected task (the conversation) is restored.
  await expect(
    reopened.getByRole("heading", { name: "Ideias soltas", exact: true }),
  ).toBeVisible();
  // Renderer must not have Node or unrestricted IPC access.
  expect(await reopened.evaluate(() => typeof (window as any).require)).toBe(
    "undefined",
  );
  expect(
    await reopened.evaluate(() =>
      window.codebit.call("arbitrary-command").then(
        () => false,
        () => true,
      ),
    ),
  ).toBe(true);
});
test("fila de mensagens: listar, editar, reordenar e remover", async () => {
  const root = resolve(".codebit-test", "queue-e2e-" + randomUUID());
  const project = join(root, "Projeto da fila");
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
  app = await electron.launch({
    args: process.env.CODEBIT_EXECUTABLE ? [] : ["."],
    executablePath: process.env.CODEBIT_EXECUTABLE,
    env,
  });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, project);
  await page.getByRole("button", { name: "Abrir um projeto" }).click();
  await page.getByLabel("Título", { exact: true }).fill("Com fila");
  await page.getByRole("button", { name: "Criar tarefa", exact: true }).click();
  // The project is not trusted, so queued messages stay without starting a CLI.
  const taskId = await page.evaluate(async () => {
    const s = await window.codebit.call<any>("snapshot");
    for (const text of ["primeira", "segunda", "terceira"])
      await window.codebit.call("task.enqueue", { id: s.tasks[0].id, text });
    return s.tasks[0].id;
  });
  const queue = page.getByRole("list", { name: "Fila de mensagens" });
  await expect(queue.getByRole("listitem")).toHaveText([
    /primeira/,
    /segunda/,
    /terceira/,
  ]);
  const item = (n: number) => queue.getByRole("listitem").nth(n);
  await item(2).getByRole("button", { name: "Mover para cima" }).click();
  await expect(queue.getByRole("listitem")).toHaveText([
    /primeira/,
    /terceira/,
    /segunda/,
  ]);
  await item(0).getByRole("button", { name: "Editar" }).click();
  await page.getByLabel("Editar mensagem da fila").fill("primeira editada");
  await page.getByLabel("Editar mensagem da fila").press("Enter");
  await expect(item(0)).toContainText("primeira editada");
  await item(1).getByRole("button", { name: "Remover da fila" }).click();
  await expect(queue.getByRole("listitem")).toHaveText([
    /primeira editada/,
    /segunda/,
  ]);
  const read = await page.evaluate(
    (id) => window.codebit.call<any>("task.read", { id }),
    taskId,
  );
  expect(read.task.queue.map((q: any) => q.text)).toEqual([
    "primeira editada",
    "segunda",
  ]);
});
test("prompts salvos: criar, escopo por projeto, editar e excluir", async () => {
  const root = resolve(".codebit-test", "prompts-e2e-" + randomUUID());
  const project = join(root, "Projeto dos prompts");
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
  app = await electron.launch({
    args: process.env.CODEBIT_EXECUTABLE ? [] : ["."],
    executablePath: process.env.CODEBIT_EXECUTABLE,
    env,
  });
  const page = await app.firstWindow();
  const prompts = page.locator(".prompts");
  const modal = page.locator(".modal");
  async function create(name: string, scope?: string, mode?: string) {
    await page.getByRole("button", { name: "Novo prompt salvo" }).click();
    await modal.getByLabel("Nome", { exact: true }).fill(name);
    await modal.getByLabel("Pedido").fill(`Pedido de ${name}.`);
    if (scope) await modal.getByLabel("Disponível em").selectOption(scope);
    if (mode) await modal.getByRole("button", { name: mode }).click();
    await modal.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(modal).toHaveCount(0);
  }
  await create("Revisar");
  await expect(
    prompts.getByRole("button", { name: "Executar Revisar" }),
  ).toBeVisible();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, project);
  await page.getByRole("button", { name: "Abrir um projeto" }).click();
  await page.getByLabel("Título", { exact: true }).fill("Com prompts");
  await page.getByRole("button", { name: "Criar tarefa", exact: true }).click();
  await create("Só aqui", "Só no projeto Projeto dos prompts", "Executar");
  // With a task of the project open, both show up.
  await expect(prompts.getByRole("button", { name: /^Executar / })).toHaveText([
    /Revisar/,
    /Só aqui/,
  ]);
  await page
    .getByRole("button", { name: "Nova conversa sem projeto", exact: true })
    .click();
  await page.getByLabel("Título", { exact: true }).fill("Livre");
  await page.getByRole("button", { name: "Criar tarefa", exact: true }).click();
  await expect(prompts.getByRole("button", { name: /^Executar / })).toHaveText([
    /Revisar/,
  ]);
  await prompts
    .getByRole("button", { name: "Editar Revisar" })
    .click({ force: true });
  await modal.getByLabel("Nome", { exact: true }).fill("Revisar tudo");
  await modal.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(
    prompts.getByRole("button", { name: "Executar Revisar tudo" }),
  ).toBeVisible();
  const saved = await page.evaluate(async () =>
    (await window.codebit.call<any>("snapshot")).prompts.map((p: any) => [
      p.name,
      p.mode,
      !!p.projectId,
    ]),
  );
  expect(saved).toEqual([
    ["Revisar tudo", "plan", false],
    ["Só aqui", "execute", true],
  ]);
  await prompts
    .getByRole("button", { name: "Editar Revisar tudo" })
    .click({ force: true });
  await modal.getByRole("button", { name: "Excluir" }).click();
  await modal.getByRole("button", { name: "Confirmar exclusão" }).click();
  await expect(modal).toHaveCount(0);
  await expect(prompts.getByRole("button", { name: /^Executar / })).toHaveCount(
    0,
  );
  await expect(prompts).toContainText("Salve pedidos rápidos");
});
