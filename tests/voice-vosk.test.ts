import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  speech: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ existsSync: () => true }));
vi.mock("../src/main/voice-windows", () => ({
  WindowsVoiceEngine: class {
    start = mocks.start;
    stop = mocks.stop;
    command = mocks.speech;
    probe = async () => ({ recognizers: [], voices: [] });
  },
}));
import { VoskVoiceEngine } from "../src/main/voice-vosk";
let child: any;
let engine: VoskVoiceEngine;
let requests: any[];
const received: any[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  requests = [];
  received.length = 0;
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
  });
  child.stdin.on("data", (data: Buffer) =>
    requests.push(JSON.parse(data.toString())),
  );
  mocks.spawn.mockReturnValue(child);
  engine = new VoskVoiceEngine("D:/test/.voice", "D:/test/voice-vosk.py");
  engine.start((e) => received.push(e));
});
afterEach(() => {
  engine.stop();
  child.stdout.destroy();
  child.stderr.destroy();
  child.stdin.destroy();
});
const event = (e: any) => child.stdout.write(JSON.stringify(e) + "\n");
it("espera liberação da entrada antes de falar; escuta seguinte encerra saída", () => {
  engine.command({ command: "speak", requestId: "2", text: "Terminou" });
  expect(requests.at(-1)).toEqual({ command: "pause", requestId: "2" });
  expect(mocks.speech).not.toHaveBeenCalled();
  event({ type: "paused", requestId: "old" });
  expect(mocks.speech).not.toHaveBeenCalled();
  event({ type: "paused", requestId: "2" });
  expect(mocks.speech).toHaveBeenCalledExactlyOnceWith({
    command: "speak",
    requestId: "2",
    text: "Terminou",
  });
  engine.command({ command: "listen", mode: "wake", requestId: "3" });
  expect(mocks.stop).toHaveBeenCalled();
  expect(requests.at(-1).command).toBe("listen");
});
it("desligar cancela fala pendente e ignora confirmação atrasada", () => {
  engine.command({ command: "speak", requestId: "1", text: "Terminou" });
  engine.stop();
  event({ type: "paused", requestId: "1" });
  expect(mocks.speech).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalled();
  expect(mocks.stop).toHaveBeenCalled();
});
it("erro no worker é visível, não libera fala pendente", () => {
  engine.command({ command: "speak", requestId: "1", text: "Terminou" });
  event({ type: "error", message: "Microfone não liberado" });
  expect(received.at(-1)).toMatchObject({
    type: "error",
    message: "Microfone não liberado",
  });
  expect(mocks.speech).not.toHaveBeenCalled();
});
