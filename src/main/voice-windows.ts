import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { windowsVoiceSource } from "./voice-windows-source";
import type { VoiceCapabilities } from "../shared/voice";

export interface VoiceEngine {
  probe(): Promise<VoiceCapabilities>;
  start(receive: (event: any) => void): void;
  command(value: Record<string, unknown>): void;
  stop(): void;
}
// A separate hidden Windows PowerShell process supplies the desktop .NET engine
// for speech output; Electron's Node runtime cannot load System.Speech itself.
export class WindowsVoiceEngine implements VoiceEngine {
  private child?: ChildProcessWithoutNullStreams;
  private launch(receive: (event: any) => void) {
    if (process.platform !== "win32")
      throw new Error("Voz local disponível apenas no Windows.");
    const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${windowsVoiceSource}\n'@ -ReferencedAssemblies System.Speech,System.Web.Extensions,System.Core\n[CodebitVoice]::Run()`;
    const child = spawn(
      join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: "pipe" },
    );
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        receive(JSON.parse(line));
      } catch {
        receive({
          type: "error",
          message: "Resposta inválida do motor local de voz.",
        });
      }
    });
    let error = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (part) => {
      error = (error + part).slice(-1500);
    });
    child.stdin.on("error", () => {});
    child.on("error", (e) => receive({ type: "error", message: e.message }));
    child.on("close", () => {
      lines.close();
      receive({
        type: "error",
        message: error || "O motor de voz foi encerrado.",
      });
    });
    return child;
  }
  async probe(): Promise<VoiceCapabilities> {
    return new Promise((resolve) => {
      let settled = false;
      let child: ChildProcessWithoutNullStreams | undefined;
      let timer: NodeJS.Timeout | undefined;
      const finish = (capabilities: VoiceCapabilities) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child?.kill();
        resolve(capabilities);
      };
      try {
        child = this.launch((event) => {
          if (event.type === "capabilities") finish(event);
          if (event.type === "error")
            finish({ recognizers: [], voices: [], reason: event.message });
        });
        child.stdin.write(JSON.stringify({ command: "probe" }) + "\n");
        timer = setTimeout(
          () =>
            finish({
              recognizers: [],
              voices: [],
              reason: "A consulta ao motor de voz excedeu 15 segundos.",
            }),
          15000,
        );
      } catch (e) {
        finish({ recognizers: [], voices: [], reason: (e as Error).message });
      }
    });
  }
  start(receive: (event: any) => void) {
    this.stop();
    const child = this.launch((event) => {
      if (this.child === child) receive(event);
    });
    this.child = child;
  }
  command(value: Record<string, unknown>) {
    if (!this.child || this.child.stdin.destroyed)
      throw new Error("Motor de voz desligado.");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  stop() {
    const child = this.child;
    this.child = undefined;
    // Termination releases the native input immediately, even during speech.
    child?.kill();
  }
}
