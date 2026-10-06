// End-to-end local speech check. Creates synthetic WAV files; NEVER opens a mic.
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const root = resolve(".codebit-test/voice-smoke");
await mkdir(root, { recursive: true });
await build({
  entryPoints: [
    "src/main/voice-vosk.ts",
    "src/main/voice-windows.ts",
    "src/main/voice.ts",
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir: root,
  outExtension: { ".js": ".cjs" },
});
const { WindowsVoiceEngine } = await import(
  pathToFileURL(join(root, "voice-windows.cjs"))
);
const { VoskVoiceEngine } = await import(
  pathToFileURL(join(root, "voice-vosk.cjs"))
);
const { VoiceController } = await import(
  pathToFileURL(join(root, "voice.cjs"))
);
process.env.CODEBIT_VOICE_TEST_OUTPUT_DIR = root;
const helper = resolve("src/main/voice-vosk.py");
const home = resolve(".voice");
const pending = new Set();
const wait = async (check, label, ms = 20000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timeout: " + label);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const phrases = [
  "Ei, Codebit",
  "Olá computador",
  "Crie uma nova tarefa",
  "Revise os arquivos do projeto",
  "O agente terminou. Confira o resultado.",
  "A execução falhou. Confira a conversa.",
  "A tarefa precisa da sua atenção.",
];
const observations = [];
let speaker;
let child;
let voice;
try {
  speaker = new WindowsVoiceEngine();
  let events = [];
  speaker.start((e) => events.push(e));
  for (let i = 0; i < phrases.length; i++) {
    speaker.command({
      command: "speak",
      text: phrases[i],
      voice: "Microsoft Maria Desktop",
      requestId: String(i),
      outputFile: join(root, `sample-${i}.wav`),
    });
    await wait(
      () =>
        events.some((e) => e.type === "spoken" && e.requestId === String(i)) ||
        events.some((e) => e.type === "error"),
      "synth " + i,
    );
    assert(!events.some((e) => e.type === "error"), JSON.stringify(events));
    assert((await readFile(join(root, `sample-${i}.wav`))).length > 1000);
  }
  speaker.stop();
  const engine = new VoskVoiceEngine(home, helper, root);
  const capabilities = await engine.probe();
  assert(
    capabilities.recognizers.some((r) => r.id === "vosk-pt"),
    JSON.stringify(capabilities),
  );
  assert(capabilities.voices.some((v) => v.culture === "pt-BR"));
  child = spawn(
    join(home, "venv/Scripts/python.exe"),
    [
      "-I",
      "-u",
      helper,
      "--model",
      join(home, "models/vosk-model-small-pt-0.3"),
      "--test-audio-directory",
      root,
    ],
    { stdio: "pipe", windowsHide: true },
  );
  let received = [];
  createInterface({ input: child.stdout }).on("line", (line) =>
    received.push(JSON.parse(line)),
  );
  child.stderr.on("data", () => {});
  for (let i = 0; i < phrases.length; i++) {
    for (const mode of ["wake", "dictation"]) {
      const id = `${i}-${mode}`;
      child.stdin.write(
        JSON.stringify({
          command: "listen",
          mode,
          wakePhrase: "Ei, Codebit",
          requestId: id,
          audioFile: join(root, `sample-${i}.wav`),
        }) + "\n",
      );
      await wait(
        () =>
          received.some(
            (e) =>
              (e.type === "recognized" && e.requestId === id) ||
              e.type === "error",
          ),
        id,
      );
      const result = received.find(
        (e) => e.type === "recognized" && e.requestId === id,
      );
      assert(result, JSON.stringify(received));
      observations.push({
        input: phrases[i],
        mode,
        text: result.text,
        confidence: result.confidence,
      });
      if (mode === "wake")
        assert.equal(!!result.text, i === 0, JSON.stringify(result));
      if (mode === "dictation" && i === 2)
        assert.equal(result.text, "crie uma nova tarefa");
    }
  }
  // Configurable Portuguese wake phrase also recognized through the same path.
  child.stdin.write(
    JSON.stringify({
      command: "listen",
      mode: "wake",
      wakePhrase: "Olá computador",
      requestId: "custom",
      audioFile: join(root, "sample-1.wav"),
    }) + "\n",
  );
  await wait(
    () =>
      received.some((e) => e.requestId === "custom" && e.type === "recognized"),
    "custom wake",
  );
  assert.equal(
    received.find((e) => e.requestId === "custom" && e.type === "recognized")
      .text,
    "Olá computador",
  );
  child.kill();
  child = undefined;
  let sent = [];
  const changes = [];
  // The production controller and adapter run against WAV replay; task delivery
  // is a test double, so no model CLI or project flow is executed.
  const wrapped = {
    probe: () => engine.probe(),
    start: (fn) => engine.start(fn),
    stop: () => engine.stop(),
    command: (c) =>
      engine.command(
        c.command === "listen"
          ? {
              ...c,
              audioFile: join(
                root,
                c.mode === "wake" ? "sample-0.wav" : "sample-2.wav",
              ),
            }
          : { ...c, outputFile: join(root, "announcement.wav") },
      ),
  };
  voice = new VoiceController(
    wrapped,
    {
      task: () => ({
        id: "test",
        title: "Teste local",
        archived: false,
        status: "idle",
      }),
      send: async (...args) => {
        sent.push(args);
      },
      enqueue: () => {
        throw new Error("unexpected queue");
      },
    },
    (s) => changes.push(s.phase),
  );
  voice.configure("test", {
    wakePhrase: "Ei, Codebit",
    recognizerId: "vosk-pt",
    announcements: true,
  });
  await voice.probe();
  await voice.enable();
  await wait(
    () => voice.state.phase === "review" || voice.state.phase === "error",
    "full transcript",
  );
  assert.equal(voice.state.phase, "review", JSON.stringify(voice.state));
  assert.equal(voice.state.draft.text, "crie uma nova tarefa");
  assert.equal(sent.length, 0);
  // The real speech output waits for Python's input-release acknowledgment.
  voice.signal({
    id: "done",
    taskId: "test",
    title: "Teste local",
    kind: "completed",
  });
  await voice.confirm(voice.state.draft.id, voice.state.draft.text);
  assert.equal(sent.length, 1);
  await wait(
    () => changes.includes("speaking") && changes.at(-1) === "review",
    "announcement and resume",
  );
  assert((await readFile(join(root, "announcement.wav"))).length > 1000);
  voice.pause();
  assert.equal(voice.state.phase, "paused");
  voice.stop();
  assert.equal(voice.state.enabled, false);
  const report = {
    synthetic: true,
    microphoneOpened: false,
    capabilities,
    observations,
    phases: changes,
    deliveryCallsToTestDouble: sent.length,
  };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  child?.kill();
  voice?.stop();
  speaker?.stop();
}
