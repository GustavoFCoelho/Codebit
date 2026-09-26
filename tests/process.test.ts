import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { capture } from "../src/main/process";

function processFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    // Killing a wrapper does not synchronously stop buffered data from its child.
    kill: vi.fn(() => false),
  });
  mocks.spawn.mockReturnValue(child);
  return child;
}
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("limites de saída dos processos", () => {
  it("descarta dados tardios após exceder o limite, sem estourar o tamanho de string", async () => {
    const child = processFixture();
    const result = capture("fixture", []).catch((e) => e);
    const chunk = "x".repeat(1024 * 1024);
    expect(() => {
      for (let i = 0; i < 600; i++) child.stdout.emit("data", chunk);
    }).not.toThrow();
    expect(await result).toMatchObject({
      message: "Resposta do processo excedeu o limite.",
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });
  it("retorna uma prévia limitada por bytes sem cortar caracteres UTF-8", async () => {
    const child = processFixture();
    const result = capture("fixture", [], undefined, 8000, {
      maxOutputBytes: 3,
      truncate: true,
    });
    child.stdout.emit("data", Buffer.from("a😀z"));
    child.stdout.emit("data", Buffer.from("saída atrasada"));
    child.emit("close", 1);
    expect(await result).toEqual({
      code: -1,
      stdout: "a",
      stderr: "",
      truncated: true,
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
  it("preserva UTF-8 dividido em chunks e o código de saída", async () => {
    const child = processFixture();
    const result = capture("fixture", []);
    for (const byte of Buffer.from("ação 😀"))
      child.stdout.emit("data", Buffer.from([byte]));
    child.stderr.emit("data", Buffer.from("diagnóstico"));
    child.emit("close", 7);
    expect(await result).toEqual({
      code: 7,
      stdout: "ação 😀",
      stderr: "diagnóstico",
      truncated: false,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });
  it("mantém somente o final de stderr mesmo com chunks grandes", async () => {
    const child = processFixture();
    const result = capture("fixture", []);
    child.stderr.emit("data", Buffer.from("x".repeat(100_000)));
    child.stderr.emit("data", Buffer.from("fim"));
    child.emit("close", 1);
    const value = await result;
    expect(value.stderr).toHaveLength(32_000);
    expect(value.stderr.endsWith("fim")).toBe(true);
  });
  it("descarta saída recebida após o timeout", async () => {
    vi.useFakeTimers();
    const child = processFixture();
    const result = capture("fixture", [], undefined, 50).catch((e) => e);
    await vi.advanceTimersByTimeAsync(50);
    const chunk = "x".repeat(1024 * 1024);
    expect(() => {
      for (let i = 0; i < 600; i++) child.stdout.emit("data", chunk);
    }).not.toThrow();
    expect(await result).toMatchObject({
      message: "O processo não respondeu a tempo.",
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
