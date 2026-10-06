import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceController, type VoiceTask } from "../src/main/voice";
import type { VoiceEngine } from "../src/main/voice-windows";
import { defaultVoice, type VoiceCapabilities } from "../src/shared/voice";
const capabilities: VoiceCapabilities = {
  recognizers: [{ id: "pt", name: "Português", culture: "pt-BR" }],
  voices: [{ name: "Local", culture: "pt-BR" }],
};
class Engine implements VoiceEngine {
  receive: (e: any) => void = () => {};
  commands: Record<string, any>[] = [];
  probe = vi.fn(async () => capabilities);
  start = vi.fn((receive: (e: any) => void) => {
    this.receive = receive;
  });
  stop = vi.fn();
  command(c: Record<string, unknown>) {
    this.commands.push(c);
  }
  event(e: Record<string, unknown>) {
    this.receive({ requestId: this.commands.at(-1)?.requestId, ...e });
  }
  ready() {
    this.event({ type: "listening", mode: this.commands.at(-1)?.mode });
  }
}
const controllers: VoiceController[] = [];
afterEach(() => {
  controllers.splice(0).forEach((v) => v.stop());
  vi.useRealTimers();
});
async function setup(enable = true) {
  const engine = new Engine();
  const task: VoiceTask = {
    id: "one",
    title: "Projeto",
    archived: false,
    status: "idle",
  };
  const tasks = {
    task: vi.fn((id: string) => {
      if (id !== task.id) throw new Error("Tarefa ausente");
      return task;
    }),
    send: vi.fn(async () => {}),
    enqueue: vi.fn(),
  };
  const voice = new VoiceController(engine, tasks, () => {});
  controllers.push(voice);
  if (enable) {
    voice.configure(task.id, defaultVoice);
    await voice.probe();
    await voice.enable();
    engine.ready();
  }
  const dictate = () => {
    engine.event({
      type: "recognized",
      mode: "wake",
      text: "Ei, Codebit",
      confidence: 0.9,
    });
    engine.ready();
    engine.event({
      type: "recognized",
      mode: "dictation",
      text: "Revise o projeto",
      confidence: 0.9,
    });
  };
  return { engine, voice, tasks, task, dictate };
}
describe("voz local sem áudio real", () => {
  it("inicia desligada, verificar não abre áudio e não instala motor", async () => {
    const { voice, engine } = await setup(false);
    expect(voice.state.phase).toBe("off");
    expect(engine.start).not.toHaveBeenCalled();
    await voice.probe();
    expect(engine.start).not.toHaveBeenCalled();
    expect(engine.commands).toEqual([]);
    await expect(voice.enable()).rejects.toThrow("Selecione a tarefa");
  });
  it("motor ausente bloqueia captura", async () => {
    const { voice, engine } = await setup(false);
    engine.probe.mockResolvedValue({
      recognizers: [],
      voices: [],
      reason: "Motor ausente",
    });
    voice.configure("one", defaultVoice);
    await voice.enable();
    expect(voice.state.phase).toBe("unavailable");
    expect(engine.start).not.toHaveBeenCalled();
  });
  it("desligar durante consulta não permite ativação tardia", async () => {
    const { voice, engine } = await setup(false);
    let resolve!: (v: VoiceCapabilities) => void;
    engine.probe.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    voice.configure("one", defaultVoice);
    const enabling = voice.enable();
    voice.stop();
    resolve(capabilities);
    await enabling;
    expect(engine.start).not.toHaveBeenCalled();
    expect(voice.state.enabled).toBe(false);
  });
  it("exige revisão, fixa tarefa e impede envio duplicado", async () => {
    const { voice, engine, tasks, dictate } = await setup();
    dictate();
    expect(voice.state.phase).toBe("review");
    expect(tasks.send).not.toHaveBeenCalled();
    expect(() => voice.configure("other", defaultVoice)).toThrow("Pause");
    const draft = voice.state.draft!;
    engine.event({
      type: "recognized",
      mode: "dictation",
      text: "duplicada",
      confidence: 1,
    });
    expect(voice.state.draft!.id).toBe(draft.id);
    await voice.confirm(draft.id, "Texto revisado");
    expect(tasks.send).toHaveBeenCalledExactlyOnceWith(
      "one",
      "Texto revisado",
      [],
    );
    await expect(voice.confirm(draft.id, "Outra vez")).rejects.toThrow(
      "já foi enviada",
    );
  });
  it.each(["running", "waiting", "queued", "background"])(
    "direcionamento em %s entra na fila",
    async (status) => {
      const { voice, tasks, task, dictate } = await setup();
      if (status === "background") task.background = 1;
      else task.status = status;
      dictate();
      await voice.confirm(voice.state.draft!.id, "Próximo passo");
      expect(tasks.enqueue).toHaveBeenCalledExactlyOnceWith(
        "one",
        "Próximo passo",
      );
      expect(tasks.send).not.toHaveBeenCalled();
    },
  );
  it("descartar não envia; pausar/desligar invalida retornos antigos", async () => {
    const { voice, engine, tasks, dictate } = await setup();
    dictate();
    voice.discard();
    expect(tasks.send).not.toHaveBeenCalled();
    const old = engine.receive;
    voice.pause();
    old({
      type: "recognized",
      mode: "wake",
      text: "Ei, Codebit",
      confidence: 1,
    });
    expect(voice.state.phase).toBe("paused");
    await voice.enable();
    engine.ready();
    voice.stop();
    engine.event({
      type: "recognized",
      mode: "wake",
      text: "Ei, Codebit",
      confidence: 1,
    });
    expect(voice.state.phase).toBe("off");
    expect(engine.stop).toHaveBeenCalled();
  });
  it("aviso fecha entrada, ignora feedback e não retoma após pausa", async () => {
    vi.useFakeTimers();
    const { voice, engine } = await setup();
    const signal = {
      id: "end",
      taskId: "one",
      title: "Ei, Codebit",
      kind: "completed" as const,
    };
    voice.signal(signal);
    expect(engine.commands.at(-1)?.command).toBe("speak");
    const count = engine.commands.length;
    voice.signal(signal);
    engine.event({
      type: "recognized",
      mode: "wake",
      text: "Ei, Codebit",
      confidence: 1,
    });
    expect(engine.commands).toHaveLength(count);
    engine.event({ type: "spoken" });
    await vi.advanceTimersByTimeAsync(1100);
    expect(engine.commands).toHaveLength(count);
    voice.pause();
    await vi.advanceTimersByTimeAsync(2000);
    expect(voice.state.phase).toBe("paused");
    expect(engine.commands).toHaveLength(count);
  });
  it("retoma após drenagem de áudio; ignora eventos de outras tarefas", async () => {
    vi.useFakeTimers();
    const { voice, engine } = await setup();
    voice.signal({
      id: "other",
      taskId: "two",
      title: "Outra",
      kind: "completed",
    });
    expect(voice.state.phase).toBe("wake");
    voice.signal({
      id: "done",
      taskId: "one",
      title: "Projeto",
      kind: "completed",
    });
    engine.event({ type: "spoken" });
    await vi.advanceTimersByTimeAsync(1200);
    expect(engine.commands.at(-1)?.mode).toBe("wake");
  });
  it("aviso de falha ou intervenção aguarda revisão sem perder texto", async () => {
    const { voice, engine, dictate } = await setup();
    dictate();
    const draft = voice.state.draft!;
    voice.signal({
      id: "wait",
      taskId: "one",
      title: "Projeto",
      kind: "waiting",
    });
    expect(voice.state.draft).toEqual(draft);
    expect(voice.state.notice?.text).toContain("atenção");
    voice.discard();
    expect(engine.commands.at(-1)?.command).toBe("speak");
    voice.signal({
      id: "fail",
      taskId: "one",
      title: "Projeto",
      kind: "failed",
    });
    expect(voice.state.notice?.text).toContain("falhou");
  });
  it("erros e timeout desligam captura, não repetem envio", async () => {
    vi.useFakeTimers();
    const { voice, engine } = await setup();
    await vi.advanceTimersByTimeAsync(25000);
    expect(voice.state.phase).toBe("error");
    expect(voice.state.enabled).toBe(false);
    expect(engine.stop).toHaveBeenCalled();
    voice.stop();
    await voice.enable();
    engine.ready();
    engine.event({ type: "error", message: "Microfone negado" });
    expect(voice.state.message).toBe("Microfone negado");
    expect(voice.state.enabled).toBe(false);
  });
  it("falha de envio não reenvia nem deixa confirmação reaproveitável", async () => {
    const { voice, tasks, dictate } = await setup();
    tasks.send.mockRejectedValue(new Error("Sem acesso"));
    dictate();
    const id = voice.state.draft!.id;
    await expect(voice.confirm(id, "Revisar")).rejects.toThrow("Sem acesso");
    expect(voice.state.phase).toBe("error");
    await expect(voice.confirm(id, "Revisar")).rejects.toThrow(
      "já foi enviada",
    );
    expect(tasks.send).toHaveBeenCalledTimes(1);
  });
});
