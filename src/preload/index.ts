import { contextBridge, ipcRenderer } from "electron";
import type { AppEvent } from "../shared/types";
const allowed = new Set([
  "snapshot",
  "detect",
  "auth",
  "agent.quota",
  "project.add",
  "project.trust",
  "task.create",
  "task.update",
  "task.read",
  "task.send",
  "task.interrupt",
  "task.respond",
  "task.commands",
  "task.enqueue",
  "task.board",
  "board.read",
  "board.start",
  "prompt.save",
  "prompt.delete",
  "quick.start",
  "quick.list",
  "quick.respond",
  "quick.stop",
  "quick.dismiss",
  "quick.keep",
  "task.queue",
  "task.sendQueued",
  "task.handoffSummary",
  "task.handoff",
  "attachments.add",
  "attachments.paste",
  "settings.save",
  "settings.cliPath",
  "settings.key",
  "images.models",
  "images.generate",
  "images.cancel",
  "images.export",
  "workflow.import",
  "extensions",
  "workspace.files",
  "workspace.read",
  "workspace.changes",
  "terminal.open",
  "terminal.write",
  "terminal.resize",
  "terminal.close",
  "external.open",
  "folder.open",
  "update.check",
  "update.apply",
  "update.cancel",
  "settings.updateFolder",
  "file.open",
  "file.reveal",
  "window.minimize",
  "window.maximize",
  "window.close",
]);
contextBridge.exposeInMainWorld("codebit", {
  call(method: string, args?: unknown) {
    if (!allowed.has(method))
      return Promise.reject(new Error("Operação não permitida."));
    return ipcRenderer.invoke("codebit:call", method, args);
  },
  onEvent(handler: (event: AppEvent) => void) {
    const listener = (_: unknown, event: AppEvent) => handler(event);
    ipcRenderer.on("codebit:event", listener);
    return () => ipcRenderer.removeListener("codebit:event", listener);
  },
});
