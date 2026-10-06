import { randomUUID } from "node:crypto";
import {
  defaultVoice,
  type TaskSignal,
  type VoiceOptions,
  type VoiceState,
} from "../shared/voice";
import type { VoiceEngine } from "./voice-windows";
export interface VoiceTask {
  id: string;
  title: string;
  archived: boolean;
  status: string;
  background?: number;
}
export interface VoiceTasks {
  task(id: string): VoiceTask;
  send(id: string, text: string, attachments: string[]): Promise<unknown>;
  enqueue(id: string, text: string): unknown;
}
export class VoiceController {
  state: VoiceState;
  private epoch = 0;
  private request = 0;
  private timer?: NodeJS.Timeout;
  private cooldown?: NodeJS.Timeout;
  private seen = new Set<string>();
  private notices: TaskSignal[] = [];
  constructor(
    private engine: VoiceEngine,
    private tasks: VoiceTasks,
    private changed: (state: VoiceState) => void,
    options?: VoiceOptions,
  ) {
    this.state = {
      phase: "off",
      enabled: false,
      options: { ...defaultVoice, ...options },
    };
  }
  private publish(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    this.changed(structuredClone(this.state));
  }
  private halt() {
    this.epoch++;
    clearTimeout(this.timer);
    clearTimeout(this.cooldown);
    this.engine.stop();
  }
  stop() {
    this.halt();
    this.notices = [];
    this.publish({
      phase: "off",
      enabled: false,
      draft: undefined,
      message: undefined,
    });
  }
  pause() {
    this.halt();
    this.notices = [];
    this.publish({
      phase: "paused",
      draft: undefined,
      message: "Microfone pausado. Retome quando quiser.",
    });
  }
  configure(taskId: string, options: VoiceOptions) {
    if (this.state.enabled && this.state.phase !== "paused")
      throw new Error("Pause a voz antes de trocar a tarefa ou a frase.");
    if (taskId && this.tasks.task(taskId).archived)
      throw new Error("Escolha uma tarefa não arquivada.");
    this.halt();
    this.publish({
      phase: this.state.enabled ? "paused" : "off",
      taskId: taskId || undefined,
      options,
      draft: undefined,
      notice: undefined,
    });
  }
  async probe() {
    if (this.state.enabled)
      throw new Error("Desligue a voz antes de verificar o motor.");
    const epoch = ++this.epoch;
    this.publish({ phase: "checking", message: undefined });
    const capabilities = await this.engine.probe();
    if (epoch !== this.epoch) return this.state;
    const hasPortuguese = capabilities.recognizers.find(
      (r) => r.culture === "pt-BR",
    );
    const options = { ...this.state.options };
    if (!options.recognizerId && hasPortuguese)
      options.recognizerId = hasPortuguese.id;
    this.publish({
      capabilities,
      options,
      phase: capabilities.recognizers.length ? "off" : "unavailable",
      message: capabilities.reason || undefined,
    });
    return this.state;
  }
  async enable() {
    if (this.state.enabled && this.state.phase !== "paused") return;
    if (!this.state.taskId)
      throw new Error("Selecione a tarefa que receberá suas instruções.");
    if (this.tasks.task(this.state.taskId).archived)
      throw new Error("A tarefa está arquivada.");
    if (!this.state.capabilities) {
      const expected = this.epoch + 1;
      await this.probe();
      if (expected !== this.epoch) return;
    }
    // A stop during the asynchronous probe must not turn the microphone on.
    if (this.state.phase !== "off" && this.state.phase !== "paused") return;
    if (
      !this.state.capabilities?.recognizers.some(
        (r) => r.id === this.state.options.recognizerId,
      )
    )
      throw new Error(
        "Selecione um reconhecedor local disponível. Nenhum será instalado automaticamente.",
      );
    this.publish({ enabled: true, message: undefined });
    this.open();
  }
  private open() {
    this.halt();
    const epoch = this.epoch;
    try {
      this.engine.start((event) => {
        if (epoch === this.epoch) this.receive(event);
      });
      this.listen("wake");
    } catch (e) {
      this.fail((e as Error).message);
    }
  }
  private fail(message: string) {
    this.halt();
    this.notices = [];
    this.publish({ phase: "error", enabled: false, message, draft: undefined });
  }
  private command(value: Record<string, unknown>, timeout = 25000) {
    clearTimeout(this.timer);
    this.request++;
    try {
      this.engine.command({ ...value, requestId: String(this.request) });
      this.timer = setTimeout(
        () =>
          this.fail("O motor de voz não respondeu. O microfone foi desligado."),
        timeout,
      );
    } catch (e) {
      this.fail((e as Error).message);
    }
  }
  private listen(mode: "wake" | "dictation") {
    if (!this.state.enabled) return;
    try {
      if (!this.state.taskId || this.tasks.task(this.state.taskId).archived)
        throw new Error("A tarefa de voz não está mais disponível.");
    } catch (e) {
      this.fail((e as Error).message);
      return;
    }
    this.publish({
      phase: "starting",
      message:
        mode === "wake"
          ? "Preparando a frase de ativação…"
          : "Preparando a instrução…",
    });
    this.command({ command: "listen", mode, ...this.state.options });
  }
  private receive(event: any) {
    if (!this.state.enabled) return;
    if (event.type === "error") {
      this.fail(String(event.message));
      return;
    }
    if (event.requestId !== String(this.request)) return;
    if (event.type === "listening" && this.state.phase === "starting") {
      this.publish({
        phase: event.mode === "wake" ? "wake" : "listening",
        message: undefined,
      });
    } else if (
      event.type === "recognized" &&
      ["wake", "listening"].includes(this.state.phase)
    ) {
      clearTimeout(this.timer);
      if (event.mode === "wake" && this.state.phase === "wake") {
        if (event.text && event.confidence >= 0.65) this.listen("dictation");
        else this.continue();
      } else if (
        event.mode === "dictation" &&
        this.state.phase === "listening"
      ) {
        const text = String(event.text || "").trim();
        if (!text || event.confidence < 0.35) {
          this.pause();
          this.publish({
            message: "Não entendi a instrução. Retome e tente novamente.",
          });
        } else {
          this.publish({
            phase: "review",
            draft: {
              id: randomUUID(),
              taskId: this.state.taskId!,
              text: text.slice(0, 8000),
            },
            message: "Microfone fechado. Revise o texto e confirme o envio.",
          });
        }
      }
    } else if (event.type === "spoken" && this.state.phase === "speaking") {
      clearTimeout(this.timer);
      // Keep input closed while output/device buffers drain. Never recognize
      // the app's own speech, and never resume after a user pause/stop.
      const epoch = this.epoch;
      this.cooldown = setTimeout(() => {
        if (epoch === this.epoch && this.state.enabled) this.continue();
      }, 1200);
    }
  }
  async confirm(draftId: string, text: string) {
    const draft = this.state.draft;
    if (this.state.phase !== "review" || !draft || draft.id !== draftId)
      throw new Error("Esta instrução já foi enviada ou descartada.");
    if (!text.trim()) throw new Error("A instrução está vazia.");
    const task = this.tasks.task(draft.taskId);
    if (task.archived)
      throw new Error("A tarefa foi arquivada. Descarte esta instrução.");
    const epoch = this.epoch;
    this.publish({ phase: "sending", draft: undefined, message: undefined });
    try {
      const queued =
        ["running", "waiting", "queued"].includes(task.status) ||
        !!task.background;
      if (queued) this.tasks.enqueue(task.id, text.trim());
      else await this.tasks.send(task.id, text.trim(), []);
      if (epoch !== this.epoch) return;
      this.publish({
        message: queued
          ? "Instrução adicionada à fila. Aprovações continuam na conversa."
          : "Instrução enviada.",
      });
      this.continue();
    } catch (e) {
      if (epoch === this.epoch)
        this.fail(
          `Falha no envio: ${(e as Error).message} Confira a conversa antes de tentar novamente.`,
        );
      throw e;
    }
  }
  discard() {
    if (this.state.phase !== "review") return;
    this.publish({ draft: undefined, message: undefined });
    this.continue();
  }
  signal(signal: TaskSignal) {
    if (
      !this.state.enabled ||
      this.state.phase === "paused" ||
      signal.taskId !== this.state.taskId ||
      this.seen.has(signal.id)
    )
      return;
    this.seen.add(signal.id);
    if (this.seen.size > 500)
      this.seen.delete(this.seen.values().next().value!);
    const text =
      signal.kind === "completed"
        ? `O agente terminou em ${signal.title}. Confira o resultado.`
        : signal.kind === "failed"
          ? `A execução falhou em ${signal.title}. Confira a conversa.`
          : `A tarefa ${signal.title} precisa da sua atenção. Confira a conversa.`;
    this.publish({ notice: { taskId: signal.taskId, text } });
    if (!this.state.options.announcements) return;
    this.notices.push(signal);
    this.notices = this.notices.slice(-10);
    if (this.state.phase === "wake") this.continue();
  }
  private continue() {
    if (!this.state.enabled) return;
    const signal = this.notices.shift();
    const voice = this.state.capabilities?.voices.find(
      (v) => v.culture === "pt-BR",
    );
    if (signal && voice) {
      const text =
        signal.kind === "completed"
          ? `O agente terminou em ${signal.title}. Confira o resultado.`
          : signal.kind === "failed"
            ? `A execução falhou em ${signal.title}. Confira a conversa.`
            : `A tarefa ${signal.title} precisa da sua atenção. Confira a conversa.`;
      this.publish({
        phase: "speaking",
        message: "Microfone fechado durante o aviso.",
      });
      this.command({ command: "speak", text, voice: voice.name }, 60000);
    } else {
      if (!voice) this.notices = [];
      this.listen("wake");
    }
  }
}
