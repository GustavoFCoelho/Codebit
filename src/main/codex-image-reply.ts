import { readFile } from "node:fs/promises";

// Keep diagnostics small; never persist image bytes, prompts or credentials.
export function imageDiagnosticText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/data:[^\s,]*;base64,[A-Za-z0-9+/=]+/gi, "[imagem omitida]")
    .replace(/\b(?:Bearer\s+|sk-)[^\s"'<>]+/gi, "[segredo omitido]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi,
      "$1[segredo omitido]",
    )
    .replace(/[A-Za-z0-9+/=]{256,}/g, "[dados omitidos]")
    .slice(0, 2000);
}

export class CodexImageReply {
  private closed = false;
  private emptyImage = false;
  private reading = false;
  private text = "";
  private error = "";
  private threadId = "";
  private turnId = "";
  private detailTimer?: NodeJS.Timeout;
  private events: Record<string, unknown>[] = [];
  constructor(
    private options: {
      success: (bytes: Buffer) => void;
      failure: (error: Error) => void;
      progress: (text: string) => void;
      readImage?: (path: string) => Promise<Buffer>;
      detailWaitMs?: number;
    },
  ) {}
  setThread(id: string) {
    this.threadId = imageDiagnosticText(id);
  }
  close() {
    this.closed = true;
    clearTimeout(this.detailTimer);
  }
  diagnostic(error: string) {
    return {
      version: 1,
      provider: "codex",
      threadId: this.threadId,
      turnId: this.turnId,
      emptyImage: this.emptyImage,
      error: imageDiagnosticText(error),
      events: this.events,
    };
  }
  failureMessage(fallback: string) {
    const detail = imageDiagnosticText(this.error || this.text);
    return detail
      ? `${this.emptyImage ? "O Codex não retornou uma imagem. " : ""}${detail}`
      : fallback;
  }
  private record(event: Record<string, unknown>) {
    this.events.push({ at: new Date().toISOString(), ...event });
    if (this.events.length > 80) this.events.shift();
  }
  private fail(message: string) {
    if (this.closed) return;
    this.close();
    this.options.failure(new Error(message));
  }
  receive(msg: any) {
    if (this.closed) return;
    const p = msg.params || {};
    if (p.turnId || p.turn?.id)
      this.turnId = imageDiagnosticText(p.turnId || p.turn.id);
    const item = p.item;
    if (item?.type === "imageGeneration") {
      this.record({
        method: imageDiagnosticText(msg.method),
        itemId: imageDiagnosticText(item.id),
        status: imageDiagnosticText(item.status),
        failureType: imageDiagnosticText(item.failure?.type),
        hasResult: !!item.result,
        hasSavedPath: !!item.savedPath,
      });
      if (msg.method === "item/started") {
        this.options.progress("Codex · gerando imagem…");
      } else if (msg.method === "item/completed") {
        if (item.failure?.type === "usageLimitExceeded") {
          this.fail(
            "Limite de geração de imagens do Codex atingido. Tente novamente mais tarde.",
          );
        } else if (item.result) {
          this.close();
          this.options.success(Buffer.from(item.result, "base64"));
        } else if (item.savedPath) {
          // turn/completed can arrive before the asynchronous file read finishes.
          this.reading = true;
          clearTimeout(this.detailTimer);
          void (this.options.readImage || readFile)(item.savedPath).then(
            (bytes) => {
              if (this.closed) return;
              this.close();
              this.options.success(bytes);
            },
            (error: Error) => this.fail(imageDiagnosticText(error.message)),
          );
        } else {
          this.emptyImage = true;
          this.options.progress("Codex · aguardando detalhes da geração…");
          // Do not close the App Server before its final explanation arrives.
          this.detailTimer ??= setTimeout(
            () =>
              this.fail(
                this.failureMessage(
                  "O Codex não retornou uma imagem nem concluiu o diagnóstico no prazo.",
                ),
              ),
            this.options.detailWaitMs ?? 30000,
          );
        }
      }
    }
    if (this.emptyImage && msg.method === "item/agentMessage/delta")
      this.text = (this.text + (p.delta || "")).slice(0, 16000);
    if (
      this.emptyImage &&
      msg.method === "item/completed" &&
      item?.type === "agentMessage"
    ) {
      this.text = imageDiagnosticText(item.text || this.text);
      this.record({ method: msg.method, type: item.type, text: this.text });
    }
    if (msg.method === "error") {
      this.error = imageDiagnosticText(p.error?.message);
      this.record({
        method: msg.method,
        error: this.error,
        willRetry: !!p.willRetry,
      });
      if (!p.willRetry) this.fail(this.failureMessage("Falha no Codex."));
    }
    if (msg.method === "turn/completed") {
      this.error = imageDiagnosticText(p.turn?.error?.message) || this.error;
      this.record({
        method: msg.method,
        status: imageDiagnosticText(p.turn?.status),
        error: this.error,
      });
      if (!this.reading)
        this.fail(
          this.failureMessage("O Codex encerrou sem gerar uma imagem."),
        );
    }
  }
}
