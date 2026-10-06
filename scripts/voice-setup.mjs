import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Este instalador suporta Windows x64.");
const home = resolve(".voice");
const python = join(home, "venv", "Scripts", "python.exe");
const run = (command, args) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw result.error || new Error(`Falha: ${command} (${result.status})`);
};
await mkdir(home, { recursive: true });
if (!existsSync(python)) run("python", ["-m", "venv", join(home, "venv")]);
run(python, [
  "-m",
  "pip",
  "install",
  "--index-url",
  "https://pypi.org/simple",
  "--disable-pip-version-check",
  "-r",
  "scripts/voice-requirements.txt",
]);
const url = "https://alphacephei.com/vosk/models/vosk-model-small-pt-0.3.zip";
const archive = join(home, "vosk-model-small-pt-0.3.zip");
// Digest of the official archive fetched during validation; pins repeat installs.
const expected =
  "6e1ce909032e1afa7a88e68a3d628ecafff302bdf195befab308826c395e93b7";
if (!existsSync(archive)) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok)
    throw new Error(`Download do modelo: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error(
      "Hash do modelo diferente do validado. Nenhum arquivo foi extraído.",
    );
  await writeFile(archive, bytes);
}
if (
  createHash("sha256")
    .update(await readFile(archive))
    .digest("hex") !== expected
)
  throw new Error("Arquivo local do modelo com hash inválido.");
run(python, [
  "-c",
  `import pathlib,zipfile
root=pathlib.Path(${JSON.stringify(join(home, "models"))}).resolve()
root.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(${JSON.stringify(archive)}) as z:
 for entry in z.infolist():
  if not (root / entry.filename).resolve().is_relative_to(root): raise RuntimeError('Caminho inválido no ZIP')
 z.extractall(root)
`,
]);
run(python, [
  "-c",
  `from vosk import Model,SetLogLevel; import sounddevice; SetLogLevel(-1); Model(${JSON.stringify(join(home, "models", "vosk-model-small-pt-0.3"))}); print('Vosk e PortAudio verificados. Nenhum microfone foi aberto.')`,
]);
await writeFile(
  join(home, "installation.json"),
  JSON.stringify(
    {
      model: "vosk-model-small-pt-0.3",
      source: url,
      sha256: expected,
      license: "Apache-2.0",
      installedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log(
  "Voz instalada em " +
    home +
    ". Abra Voz no Codebit e verifique o motor. A captura continua desligada.",
);
