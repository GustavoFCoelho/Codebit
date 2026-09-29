import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexImageReply,
  imageDiagnosticText,
} from "../src/main/codex-image-reply";

const empty = {
  method: "item/completed",
  params: {
    item: {
      type: "imageGeneration",
      id: "i",
      status: "failed",
      result: "",
      failure: null,
    },
  },
};
const completed = (message?: string) => ({
  method: "turn/completed",
  params: {
    turn: {
      id: "t",
      status: message ? "failed" : "completed",
      error: message ? { message } : null,
    },
  },
});
const harness = (options = {}) => {
  const success = vi.fn();
  const failure = vi.fn();
  const reply = new CodexImageReply({
    success,
    failure,
    progress: vi.fn(),
    ...options,
  });
  return { reply, success, failure };
};
afterEach(() => vi.useRealTimers());

describe("conclusão da imagem Codex", () => {
  it("preserva o erro do turno posterior à imagem vazia", () => {
    const { reply, failure } = harness();
    reply.receive(empty);
    expect(failure).not.toHaveBeenCalled();
    reply.receive(completed("Falha identificada pelo servidor"));
    expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0][0].message).toContain(
      "Falha identificada pelo servidor",
    );
  });
  it("usa a explicação posterior e filtra segredo dividido entre deltas", () => {
    const { reply, failure } = harness();
    reply.receive(empty);
    for (const delta of ["Falha do serviço. Bearer sk-secret", "-remainder"])
      reply.receive({ method: "item/agentMessage/delta", params: { delta } });
    reply.receive(completed());
    const message = failure.mock.calls[0][0].message;
    expect(message).toContain("Falha do serviço");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("remainder");
  });
  it("limita a espera por detalhes a 30 segundos", () => {
    vi.useFakeTimers();
    const { reply, failure } = harness();
    reply.receive(empty);
    vi.advanceTimersByTime(29999);
    expect(failure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(failure.mock.calls[0][0].message).toContain("no prazo");
    reply.receive(completed("tardio"));
    expect(failure).toHaveBeenCalledOnce();
  });
  it("cancelamento limpa a espera pendente", () => {
    vi.useFakeTimers();
    const { reply, failure } = harness();
    reply.receive(empty);
    reply.close();
    vi.advanceTimersByTime(60000);
    expect(failure).not.toHaveBeenCalled();
  });
  it("aguarda savedPath mesmo quando o turno termina antes da leitura", async () => {
    let finish!: (value: Buffer) => void;
    const pending = new Promise<Buffer>((resolve) => {
      finish = resolve;
    });
    const { reply, success, failure } = harness({ readImage: () => pending });
    reply.receive({
      method: "item/completed",
      params: {
        item: {
          type: "imageGeneration",
          result: "",
          savedPath: "generated.png",
        },
      },
    });
    reply.receive(completed());
    expect(failure).not.toHaveBeenCalled();
    const bytes = Buffer.from("synthetic image");
    finish(bytes);
    await pending;
    expect(success).toHaveBeenCalledWith(bytes);
    expect(failure).not.toHaveBeenCalled();
  });
  it("mantém o erro de leitura do arquivo após a conclusão do turno", async () => {
    const { reply, failure } = harness({
      readImage: async () => {
        throw new Error("Arquivo inacessível");
      },
    });
    reply.receive({
      method: "item/completed",
      params: {
        item: {
          type: "imageGeneration",
          result: "",
          savedPath: "generated.png",
        },
      },
    });
    reply.receive(completed());
    await Promise.resolve();
    expect(failure.mock.calls[0][0].message).toBe("Arquivo inacessível");
  });
  it("imagem posterior à resposta vazia conclui com sucesso", () => {
    const { reply, success, failure } = harness();
    reply.receive(empty);
    reply.receive({
      method: "item/completed",
      params: {
        item: {
          type: "imageGeneration",
          result: Buffer.from("png").toString("base64"),
        },
      },
    });
    reply.receive(completed());
    expect(success).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
  });
  it("limite de uso mantém mensagem específica sem aguardar", () => {
    const { reply, failure } = harness();
    reply.receive({
      method: "item/completed",
      params: {
        item: { ...empty.params.item, failure: { type: "usageLimitExceeded" } },
      },
    });
    expect(failure.mock.calls[0][0].message).toContain("Limite de geração");
  });
  it("omite binários e credenciais dos detalhes persistidos", () => {
    const raw = `api_key=SECRET password='PASSWORD' data:image/png;base64,${"A".repeat(300)} ${"B".repeat(300)}`;
    const safe = imageDiagnosticText(raw);
    expect(safe).not.toContain("SECRET");
    expect(safe).not.toContain("PASSWORD");
    expect(safe).not.toContain("A".repeat(20));
    expect(safe).not.toContain("B".repeat(20));
  });
});
