import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  Notification,
  protocol,
  safeStorage,
  shell,
} from "electron";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { z } from "zod";
import { Store } from "./store";
import { Runtime } from "./runtime";
import { ImageBridge } from "./bridge";
import { files, fileContent, changes } from "./workspace";
import { skills, nativeMcp } from "./extensions";
import { validateWorkflow } from "./images";
import { Updater, waitForExit } from "./updater";
import { appVersion } from "../shared/types";
import type {
  Artifact,
  AppEvent,
  Project,
  Settings,
  Task,
} from "../shared/types";
protocol.registerSchemesAsPrivileged([
  {
    scheme: "codebit",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);
if (process.env.CODEBIT_DATA_DIR)
  app.setPath("userData", process.env.CODEBIT_DATA_DIR);
let win: BrowserWindow;
let store: Store;
let runtime: Runtime;
let bridge: ImageBridge;
let updater: Updater;
let shuttingDown = false;
const terminals = new Map<string, import("node-pty").IPty>();
// Shown notifications, kept so a click still reaches its handler.
const notices = new Set<Notification>();
const appId = "local.codebit.desktop";
const terminalBuffers = new Map<string, string>();
const id = z.string().min(1).max(500);
const agent = z.enum(["codex", "claude", "devin"]);
const imageProvider = z.enum(["codex", "openai", "comfyui"]);
const imageOptions = z.object({
  provider: imageProvider,
  model: z.string().min(1).max(500),
  quality: z.enum(["auto", "low", "medium", "high"]),
  size: z.enum(["auto", "1024x1024", "1536x1024", "1024x1536", "2048x1152"]),
  workflow: z.string().max(200),
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 32 - 1),
  inputImage: z.string().max(2000).optional(),
});
const settingsSchema = z.object({
  cliPaths: z.object({
    codex: z.string().optional(),
    claude: z.string().optional(),
    devin: z.string().optional(),
  }),
  comfyUrl: z.url().refine((v) => /^https?:\/\//.test(v), "Use HTTP ou HTTPS."),
  defaultModels: z.object({
    codex: z.string(),
    claude: z.string(),
    devin: z.string().default(""),
  }),
  mcp: z.array(
    z.object({
      id,
      name: z.string().min(1).max(100),
      agent: z.enum(["codex", "claude", "devin", "both"]),
      enabled: z.boolean(),
      transport: z.enum(["stdio", "http"]),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
    }),
  ),
  workflows: z.array(z.any()),
  guidelines: z.string().max(20000).optional(),
  notifications: z.boolean().optional(),
  defaultMode: z.enum(["plan", "execute", "bypass"]).optional(),
  updateFolder: z.string().max(1000).optional(),
});
function emit(event: AppEvent) {
  if (win && !win.isDestroyed()) win.webContents.send("codebit:event", event);
}
// Only while the window is in the background; a click opens the task.
function notify(notice: { title: string; body: string; taskId?: string }) {
  if (
    store.settings().notifications === false ||
    !win ||
    win.isDestroyed() ||
    win.isFocused() ||
    !Notification.isSupported()
  )
    return;
  const n = new Notification({ title: notice.title, body: notice.body });
  notices.add(n);
  n.on("click", () => {
    notices.delete(n);
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (notice.taskId) emit({ type: "open-task", taskId: notice.taskId });
  });
  n.on("close", () => notices.delete(n));
  n.show();
}
function key() {
  const encrypted = store.secret("openai-image");
  if (encrypted) {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("O armazenamento seguro do Windows não está disponível.");
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  }
  return process.env.OPENAI_API_KEY;
}
function snapshot() {
  return {
    ...store.snapshot(),
    agents: runtime.agents,
    update: updater?.state,
    settings: {
      ...store.settings(),
      hasOpenAIKey: !!(
        store.secret("openai-image") || process.env.OPENAI_API_KEY
      ),
    },
  };
}
// An image the chat mentions: absolute, file://, ~/… or relative to the task
// folder. Only images are served, so chat text cannot expose other files.
function mentionedImage(taskId: string, raw: string) {
  const text = raw.trim();
  const path = /^file:/i.test(text)
    ? fileURLToPath(text)
    : /^~[\\/]/.test(text)
      ? join(homedir(), text.slice(2))
      : resolve(runtime.task(taskId).cwd, text);
  if (!/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path))
    throw new Error("Só imagens podem ser abertas por aqui.");
  return path;
}
function inactive(taskId: string) {
  const task = runtime.task(taskId);
  // A session kept open for background work must keep its settings.
  if (["running", "queued", "waiting"].includes(task.status) || task.background)
    throw new Error("Encerre a execução antes de alterar esta tarefa.");
  return task;
}
async function handle(method: string, args: any = {}) {
  switch (method) {
    case "snapshot":
      return snapshot();
    case "detect":
      return runtime.detect();
    case "auth":
      return runtime.auth(agent.parse(args.agent));
    case "agent.quota": {
      const a = z
        .object({ agent, refresh: z.boolean().optional() })
        .parse(args);
      return runtime.quota(a.agent, a.refresh);
    }
    case "project.add": {
      const selected = await dialog.showOpenDialog(win, {
        properties: ["openDirectory"],
        title: "Abrir projeto",
      });
      return selected.canceled ? null : runtime.project(selected.filePaths[0]);
    }
    case "project.trust": {
      const p = store.get<Project>("project", id.parse(args.id));
      p.trusted = z.boolean().parse(args.trusted);
      store.put("project", p);
      runtime.refresh();
      return p;
    }
    case "task.create":
      return runtime.createTask(
        z
          .object({
            // Empty for a conversation without a project.
            projectId: z.string().max(500),
            title: z.string().max(150),
            agent,
            worktree: z.boolean().optional(),
          })
          .parse(args),
      );
    case "task.update": {
      const input = z
        .object({
          id,
          patch: z.object({
            title: z.string().min(1).max(150).optional(),
            model: z.string().max(200).optional(),
            effort: z.string().max(50).optional(),
            mode: z.enum(["plan", "execute", "bypass"]).optional(),
            agent: agent.optional(),
            archived: z.boolean().optional(),
            images: imageOptions.optional(),
            subagents: z
              .object({
                enabled: z.boolean(),
                agent,
                model: z.string().max(200),
                effort: z.string().max(50),
                max: z.number().int().min(1).max(8),
              })
              .optional(),
          }),
        })
        .parse(args);
      inactive(input.id);
      return runtime.updateTask(input.id, input.patch);
    }
    case "task.read": {
      const task = runtime.task(id.parse(args.id));
      return {
        task,
        entries: store.entries(task.id),
        artifacts: store.artifacts(task.id),
      };
    }
    case "task.send": {
      const a = z
        .object({
          id,
          text: z.string().max(100000),
          attachments: z.array(z.string()).max(10).default([]),
        })
        .parse(args);
      return runtime.send(a.id, a.text, a.attachments);
    }
    case "task.interrupt":
      return runtime.interrupt(id.parse(args.id));
    case "prompt.save":
      return runtime.savePrompt(
        z
          .object({
            id: id.optional(),
            name: z.string().trim().min(1).max(100),
            text: z.string().trim().min(1).max(20000),
            projectId: z.string().max(500),
            mode: z.enum(["plan", "execute", "bypass"]),
          })
          .parse(args),
      );
    case "prompt.delete":
      return runtime.deletePrompt(id.parse(args.id));
    case "quick.start":
      return runtime.startQuick(
        id.parse(args.promptId),
        args.taskId ? id.parse(args.taskId) : undefined,
      );
    case "quick.list":
      return runtime.quickRuns();
    case "quick.respond":
      return runtime.respondQuick(
        id.parse(args.id),
        z
          .object({
            decision: z.enum(["accept", "decline"]).optional(),
            answers: z
              .record(z.string(), z.union([z.string(), z.array(z.string())]))
              .optional(),
          })
          .parse(args.value),
      );
    case "quick.stop":
      return runtime.stopQuick(id.parse(args.id));
    case "quick.dismiss":
      return runtime.dismissQuick(id.parse(args.id));
    case "quick.keep":
      return runtime.keepQuick(id.parse(args.id));
    case "task.respond": {
      const a = z
        .object({
          id,
          entryId: id,
          value: z.object({
            decision: z.enum(["accept", "decline"]).optional(),
            answers: z
              .record(z.string(), z.union([z.string(), z.array(z.string())]))
              .optional(),
          }),
        })
        .parse(args);
      return runtime.respond(a.id, a.entryId, a.value);
    }
    case "board.read":
      return runtime.board();
    case "board.start": {
      const a = z
        .object({
          // Empty for a conversation without a project.
          projectId: z.string().max(500),
          agent,
          worktree: z.boolean().optional(),
          text: z.string().min(1).max(100000),
        })
        .parse(args);
      return runtime.startOnBoard(a);
    }
    case "task.board": {
      const a = z.object({ id, on: z.boolean() }).parse(args);
      return runtime.setBoard(a.id, a.on);
    }
    case "task.enqueue": {
      const a = z
        .object({
          id,
          text: z.string().max(100000),
          attachments: z.array(z.string()).max(10).default([]),
        })
        .parse(args);
      return runtime.enqueue(a.id, a.text, a.attachments);
    }
    case "task.queue": {
      const a = z
        .object({
          id,
          items: z
            .array(z.object({ id, text: z.string().max(100000) }))
            .max(100),
        })
        .parse(args);
      return runtime.setQueue(a.id, a.items);
    }
    case "task.sendQueued": {
      const a = z.object({ id, itemId: id }).parse(args);
      return runtime.sendQueued(a.id, a.itemId);
    }
    case "task.commands": {
      const a = z.object({ id, refresh: z.boolean().optional() }).parse(args);
      return runtime.commands(a.id, a.refresh);
    }
    case "task.handoffSummary":
      return runtime.handoffSummary(id.parse(args.id));
    case "task.handoff": {
      const a = z
        .object({ id, agent, summary: z.string().max(30000) })
        .parse(args);
      return runtime.handoff(a.id, a.agent, a.summary);
    }
    case "attachments.add": {
      const taskId = id.parse(args.id);
      runtime.task(taskId);
      const result = await dialog.showOpenDialog(win, {
        properties: ["openFile", "multiSelections"],
        title: "Anexar arquivos",
      });
      return result.canceled ? [] : runtime.attach(taskId, result.filePaths);
    }
    case "attachments.paste": {
      const a = z
        .object({
          id,
          name: z.string().regex(/^[\w-]{1,80}\.(png|jpe?g|webp|gif)$/i),
          data: z.base64().max(27_000_000),
        })
        .parse(args);
      return runtime.attachData(a.id, a.name, Buffer.from(a.data, "base64"));
    }
    case "settings.save": {
      const settings = settingsSchema.parse(args) as Settings;
      for (const w of settings.workflows) validateWorkflow(w);
      for (const m of settings.mcp)
        if (
          m.transport === "stdio"
            ? !m.command
            : !m.url || !/^https?:\/\//.test(m.url)
        )
          throw new Error("Configure o comando ou URL do servidor MCP.");
      store.saveSettings(settings);
      runtime.refresh();
      return snapshot().settings;
    }
    case "settings.cliPath": {
      const a = agent.parse(args.agent);
      const r = await dialog.showOpenDialog(win, {
        properties: ["openFile"],
        title: "Selecionar executável do CLI",
        filters: [{ name: "Executáveis", extensions: ["exe", "cmd", "ps1"] }],
      });
      if (r.canceled) return;
      const s = store.settings();
      s.cliPaths[a] = r.filePaths[0];
      store.saveSettings(s);
      return runtime.detect();
    }
    case "settings.key": {
      const value = z.string().max(1000).parse(args.key).trim();
      if (value && !safeStorage.isEncryptionAvailable())
        throw new Error("Armazenamento seguro indisponível.");
      store.setSecret(
        "openai-image",
        value ? safeStorage.encryptString(value).toString("base64") : "",
      );
      runtime.refresh();
      return { saved: !!value };
    }
    case "images.models":
      return runtime.images.models(imageProvider.parse(args.provider));
    case "images.generate": {
      const a = z
        .object({
          id,
          prompt: z.string().min(1).max(32000),
          options: imageOptions.optional(),
        })
        .parse(args);
      return runtime.generate(a.id, a.prompt, a.options);
    }
    case "images.cancel":
      return runtime.images.cancel(id.parse(args.id));
    case "images.export": {
      const a = store.get<Artifact>("artifact", id.parse(args.id));
      const r = await dialog.showSaveDialog(win, {
        defaultPath: "imagem-" + a.id.slice(0, 8) + ".png",
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (!r.canceled && r.filePath) {
        await copyFile(a.path, r.filePath);
        return r.filePath;
      }
      return null;
    }
    case "workflow.import": {
      const r = await dialog.showOpenDialog(win, {
        properties: ["openFile"],
        filters: [{ name: "Workflow API JSON", extensions: ["json"] }],
      });
      if (r.canceled) return null;
      const text = await readFile(r.filePaths[0], "utf8");
      if (text.length > 2000000) throw new Error("Workflow excede 2 MB.");
      const json = JSON.parse(text);
      return {
        id: randomUUID(),
        name: "Meu workflow",
        kind: "generate",
        graph: json.prompt || json,
        bindings: {
          prompt: "6.inputs.text",
          model: "4.inputs.ckpt_name",
          seed: "3.inputs.seed",
          width: "5.inputs.width",
          height: "5.inputs.height",
        },
      };
    }
    case "extensions": {
      const cwd = args.taskId
        ? runtime.task(id.parse(args.taskId)).cwd
        : undefined;
      const [list, native] = await Promise.all([skills(cwd), nativeMcp(cwd)]);
      return { skills: list, nativeMcp: native };
    }
    case "workspace.files":
      return files(
        runtime.task(id.parse(args.id)).cwd,
        z
          .string()
          .max(2000)
          .parse(args.path || ""),
      );
    case "workspace.read":
      return fileContent(
        runtime.task(id.parse(args.id)).cwd,
        z.string().max(2000).parse(args.path),
      );
    case "workspace.changes":
      return changes(runtime.task(id.parse(args.id)).cwd);
    case "terminal.open": {
      const taskId = id.parse(args.id);
      const t = runtime.task(taskId);
      if (!runtime.trusted(t))
        throw new Error("Confie no projeto antes de abrir o terminal.");
      if (terminals.has(taskId))
        return { buffer: terminalBuffers.get(taskId) || "" };
      const pty = await import("node-pty");
      const command =
        process.platform === "win32"
          ? join(
              process.env.SystemRoot || "C:\\Windows",
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe",
            )
          : process.env.SHELL || "/bin/bash";
      const term = pty.spawn(command, [], {
        name: "xterm-256color",
        cols: 100,
        rows: 24,
        cwd: t.cwd,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (p): p is [string, string] => typeof p[1] === "string",
          ),
        ),
      });
      terminals.set(taskId, term);
      terminalBuffers.set(taskId, "");
      term.onData((data) => {
        terminalBuffers.set(
          taskId,
          ((terminalBuffers.get(taskId) || "") + data).slice(-1000000),
        );
        emit({ type: "terminal", taskId, data });
      });
      term.onExit(() => {
        terminals.delete(taskId);
        emit({
          type: "terminal",
          taskId,
          data: "\r\n[Terminal encerrado]\r\n",
        });
      });
      return { buffer: "" };
    }
    case "terminal.write": {
      const a = z.object({ id, data: z.string().max(64000) }).parse(args);
      terminals.get(a.id)?.write(a.data);
      return;
    }
    case "terminal.resize": {
      const a = z
        .object({
          id,
          cols: z.number().int().min(2).max(500),
          rows: z.number().int().min(2).max(300),
        })
        .parse(args);
      terminals.get(a.id)?.resize(a.cols, a.rows);
      return;
    }
    case "terminal.close":
      terminals.get(id.parse(args.id))?.kill();
      return;
    case "external.open": {
      const url = z.url().parse(args.url);
      if (!/^https?:\/\//.test(url)) throw new Error("Link não permitido.");
      return shell.openExternal(url);
    }
    case "update.check":
      return updater.check();
    case "update.apply":
      return updater.apply();
    case "update.cancel":
      return updater.cancel();
    case "settings.updateFolder": {
      const r = await dialog.showOpenDialog(win, {
        properties: ["openDirectory"],
        title: "Pasta com as versões do Codebit",
      });
      if (r.canceled) return updater.state;
      store.saveSettings({ ...store.settings(), updateFolder: r.filePaths[0] });
      return updater.check();
    }
    case "folder.open":
      return shell.openPath(runtime.task(id.parse(args.id)).cwd);
    case "file.open": {
      const path = mentionedImage(
        id.parse(args.id),
        z.string().parse(args.path),
      );
      const error = await shell.openPath(path);
      if (error) throw new Error(error);
      return;
    }
    case "file.reveal":
      return shell.showItemInFolder(
        mentionedImage(id.parse(args.id), z.string().parse(args.path)),
      );
    case "window.minimize":
      win.minimize();
      return;
    case "window.maximize":
      win.isMaximized() ? win.unmaximize() : win.maximize();
      return;
    case "window.close":
      win.close();
      return;
    default:
      throw new Error("Operação desconhecida.");
  }
}
// A build started by the updater waits for the old one to close first, or
// the single-instance lock would send it straight back.
const previous = Number(
  process.argv.find((a) => a.startsWith("--after-update="))?.split("=")[1],
);
void (previous ? waitForExit(previous) : Promise.resolve()).then(() => {
  if (!app.requestSingleInstanceLock()) return app.quit();
  app.on("second-instance", () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  return app.whenReady().then(async () => {
    store = new Store(app.getPath("userData"));
    runtime = new Runtime(store, emit, key);
    bridge = new ImageBridge(
      runtime,
      process.execPath,
      join(__dirname, "image-mcp.cjs"),
    );
    await bridge.start();
    runtime.bridgeConfig = (id, kind) => bridge.config(id, kind);
    runtime.revokeBridge = (id) => bridge.revoke(id);
    runtime.attention = notify;
    updater = new Updater(appVersion, {
      // The portable build knows the folder it was opened from.
      folder: () =>
        store.settings().updateFolder || process.env.PORTABLE_EXECUTABLE_DIR,
      busy: () => runtime.busy(),
      launch: (path, args) =>
        spawn(path, args, { detached: true, stdio: "ignore" }).unref(),
      quit: () => app.quit(),
      changed: () => emit({ type: "refresh" }),
    });
    if (process.platform === "win32") {
      app.setAppUserModelId(appId);
      // Windows drops notifications from apps it does not know; the portable
      // build has no installer, so it registers its own name for the user.
      execFile(
        "reg",
        [
          "add",
          "HKCU\\Software\\Classes\\AppUserModelId\\" + appId,
          "/v",
          "DisplayName",
          "/t",
          "REG_SZ",
          "/d",
          "Codebit",
          "/f",
        ],
        { windowsHide: true },
        () => {},
      );
    }
    protocol.handle("codebit", async (request) => {
      try {
        const url = new URL(request.url);
        if (url.hostname === "file")
          return net.fetch(
            pathToFileURL(
              mentionedImage(
                decodeURIComponent(url.pathname.slice(1)),
                url.searchParams.get("path") ?? "",
              ),
            ).toString(),
          );
        if (url.hostname !== "artifact")
          return new Response("", { status: 404 });
        const artifact = store.get<Artifact>(
          "artifact",
          decodeURIComponent(url.pathname.slice(1)),
        );
        return net.fetch(pathToFileURL(artifact.path).toString());
      } catch {
        return new Response("", { status: 404 });
      }
    });
    win = new BrowserWindow({
      width: 1536,
      height: 1000,
      minWidth: 1000,
      minHeight: 700,
      backgroundColor: "#111518",
      frame: false,
      show: false,
      webPreferences: {
        preload: join(__dirname, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    ipcMain.handle("codebit:call", async (event, method, args) => {
      if (
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame
      )
        throw new Error("Origem não permitida.");
      return handle(z.string().parse(method), args);
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      if (url !== win.webContents.getURL()) event.preventDefault();
    });
    win.once("ready-to-show", () => {
      if (process.env.CODEBIT_TEST_MODE !== "1") win.show();
    });
    // A CLI updated in a terminal, or a new Codebit build, is picked up when
    // the user comes back.
    win.on("focus", () => {
      void runtime.checkVersions().catch(() => {});
      void updater.check();
    });
    if (process.env.CODEBIT_DEV_URL)
      await win.loadURL(process.env.CODEBIT_DEV_URL);
    else await win.loadFile(join(__dirname, "../renderer/index.html"));
    void runtime.detect().catch((e) => {
      console.error("Falha na descoberta:", e.message);
    });
    updater.start();
  });
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  updater?.stop();
  for (const t of terminals.values()) t.kill();
  runtime?.close();
  bridge?.close();
  store?.close();
});
