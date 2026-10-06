import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { WindowsVoiceEngine, type VoiceEngine } from "./voice-windows";
import type { VoiceCapabilities } from "../shared/voice";

// Independent Python environment avoids native Node/Electron ABI mismatches.
export class VoskVoiceEngine implements VoiceEngine {
  private child?: ChildProcessWithoutNullStreams;
  private receive: (event: any) => void = () => {};
  private speaker = new WindowsVoiceEngine();
  private pendingSpeech?: Record<string, unknown>;
  private generation = 0;
  constructor(
    private home: string,
    private script: string,
    private testAudioDirectory?: string,
  ) {}
  private launch(receive: (event: any) => void) {
    const python = join(this.home, "venv", "Scripts", "python.exe");
    const model = join(this.home, "models", "vosk-model-small-pt-0.3");
    if (!existsSync(python) || !existsSync(join(model, "final.mdl")))
      throw new Error(
        "Vosk português não instalado neste diretório. Execute npm run voice:setup na pasta do Codebit. O aplicativo não baixa componentes automaticamente.",
      );
    const child = spawn(
      python,
      [
        "-I",
        "-u",
        this.script,
        "--model",
        model,
        ...(this.testAudioDirectory
          ? ["--test-audio-directory", this.testAudioDirectory]
          : []),
      ],
      { windowsHide: true, stdio: "pipe" },
    );
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        receive(JSON.parse(line));
      } catch {
        receive({ type: "error", message: "Resposta inválida do Vosk local." });
      }
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (part) => {
      stderr = (stderr + part).slice(-1500);
    });
    child.stdin.on("error", () => {});
    child.on("error", (e) => receive({ type: "error", message: e.message }));
    child.on("close", () => {
      lines.close();
      receive({ type: "error", message: stderr || "Vosk encerrado." });
    });
    return child;
  }
  async probe(): Promise<VoiceCapabilities> {
    const [input, output] = await Promise.all([
      new Promise<VoiceCapabilities>((resolve) => {
        let settled = false;
        let child: ChildProcessWithoutNullStreams | undefined;
        let timer: NodeJS.Timeout | undefined;
        const finish = (value: VoiceCapabilities) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child?.kill();
          resolve(value);
        };
        try {
          child = this.launch((e) => {
            if (e.type === "capabilities") finish(e);
            if (e.type === "error")
              finish({ recognizers: [], voices: [], reason: e.message });
          });
          child.stdin.write(JSON.stringify({ command: "probe" }) + "\n");
          timer = setTimeout(
            () =>
              finish({
                recognizers: [],
                voices: [],
                reason: "A verificação do Vosk excedeu 20 segundos.",
              }),
            20000,
          );
        } catch (e) {
          finish({ recognizers: [], voices: [], reason: (e as Error).message });
        }
      }),
      this.speaker.probe(),
    ]);
    return {
      recognizers: input.recognizers,
      voices: output.voices,
      reason:
        input.reason ||
        (!output.voices.some((v) => v.culture === "pt-BR")
          ? "Vosk pronto. Voz de saída em português indisponível; os avisos serão escritos."
          : undefined),
    };
  }
  start(receive: (event: any) => void) {
    this.stop();
    this.receive = receive;
    const generation = this.generation;
    const child = this.launch((event) => {
      if (this.child !== child || generation !== this.generation) return;
      if (
        event.type === "paused" &&
        this.pendingSpeech &&
        this.pendingSpeech.requestId === event.requestId
      ) {
        const command = this.pendingSpeech;
        this.pendingSpeech = undefined;
        // Start speech ONLY after the input process confirms stream.close().
        try {
          this.speaker.start((e) => {
            if (generation === this.generation) this.receive(e);
          });
          this.speaker.command(command);
        } catch (e) {
          this.receive({ type: "error", message: (e as Error).message });
        }
      } else this.receive(event);
    });
    this.child = child;
  }
  command(value: Record<string, unknown>) {
    if (!this.child || this.child.stdin.destroyed)
      throw new Error("Vosk desligado.");
    if (value.command === "speak") {
      this.pendingSpeech = value;
      this.child.stdin.write(
        JSON.stringify({ command: "pause", requestId: value.requestId }) + "\n",
      );
    } else {
      this.pendingSpeech = undefined;
      this.speaker.stop();
      this.child.stdin.write(JSON.stringify(value) + "\n");
    }
  }
  stop() {
    this.generation++;
    this.pendingSpeech = undefined;
    this.speaker.stop();
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }
}
