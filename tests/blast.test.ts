import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { blastRadius, commands, risky } from "../src/main/blast";
import { capture } from "../src/main/process";
const roots: string[] = [];
const pause = () => new Promise((r) => setTimeout(r, 30));
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
});
// A task folder with a "work" folder of 25 files (1 KB each, one of 50 KB).
async function folder() {
  const root = await mkdtemp(join(tmpdir(), "codebit-blast-"));
  roots.push(root);
  const cwd = join(root, "tarefa");
  await mkdir(join(cwd, "work", "v001"), { recursive: true });
  for (let i = 0; i < 24; i++)
    await writeFile(join(cwd, "work", `parte_${i}.txt`), "x".repeat(1024));
  await writeFile(join(cwd, "work", "v001", "cena.blend"), "x".repeat(51200));
  await writeFile(join(cwd, "manter.txt"), "fica");
  await writeFile(join(root, "vizinho.txt"), "de fora");
  return { root, cwd };
}
describe("alcance de comandos que apagam", () => {
  it("separa comandos e mantém caminhos entre aspas", () => {
    expect(
      commands('cd "C:\\Meus Projetos" && rm -rf "pasta velha"; echo ok'),
    ).toEqual([
      ["cd", "C:\\Meus Projetos"],
      ["rm", "-rf", "pasta velha"],
      ["echo", "ok"],
    ]);
  });
  it("mede o que rm, Remove-Item e rd apagam, inclusive dentro de pwsh e cmd", async () => {
    const { cwd } = await folder();
    for (const command of [
      "rm -rf work",
      "Remove-Item -Recurse -Force -Path work",
      "pwsh.exe -NoProfile -Command 'Remove-Item work -Recurse -Force'",
      'cmd.exe /d /c "rd /s /q work"',
      "bash -lc 'cd . && rm -r ./work'",
    ]) {
      const blast = (await blastRadius(command, cwd))!;
      expect(blast, command).toMatchObject({
        files: 25,
        dirs: 2,
        bytes: 24 * 1024 + 51200,
        outside: false,
      });
      expect(blast.summary).toBe("Apaga 25 arquivos e 2 pastas · 74 KB");
      // One folder: its heaviest contents, heaviest first.
      expect(blast.entries[0]).toEqual({
        path: join("work", "v001"),
        bytes: 51200,
        dir: true,
      });
    }
  });
  it("comandos que não apagam não têm alcance", async () => {
    const { cwd } = await folder();
    for (const command of [
      "echo rm -rf work",
      "ls work",
      "git status",
      "npm test",
    ])
      expect(await blastRadius(command, cwd), command).toBeUndefined();
  });
  it("curingas, filtros, fora da pasta e caminhos calculados na hora", async () => {
    const { cwd } = await folder();
    const glob = (await blastRadius("del /q work\\parte_1*.txt", cwd))!;
    expect(glob.files).toBe(11);
    // find counts only what its -name picks; a folder it picks goes whole.
    const find = (await blastRadius(
      "find work -name 'parte_1*' -delete",
      cwd,
    ))!;
    expect(find).toMatchObject({ filtered: true, files: 11 });
    expect(find.summary).toMatch(/^Pode apagar até 11 arquivos/);
    const exec = (await blastRadius(
      "find . -type d -name v001 -exec rm -rf {} +",
      cwd,
    ))!;
    expect(exec).toMatchObject({ files: 1, dirs: 1, bytes: 51200 });
    const outside = (await blastRadius("rm ../vizinho.txt", cwd))!;
    expect(outside.outside).toBe(true);
    const unknown = (await blastRadius("rm -rf $CODEBIT_SEM_VALOR/x", cwd))!;
    expect(unknown.unknown).toContain("$CODEBIT_SEM_VALOR");
    // rd and rmdir without /s or -r only remove empty folders.
    for (const command of ["rmdir work", "rd work", "rmdir -p work/v001"])
      expect(await blastRadius(command, cwd), command).toBeUndefined();
    expect((await blastRadius("rmdir /s /q work", cwd))!.files).toBe(25);
  });
  it("só pergunta pelo que já existia antes da conversa", async () => {
    const { cwd } = await folder();
    await pause();
    const since = Date.now();
    await pause();
    // What the agent made during the conversation, however big.
    await mkdir(join(cwd, "renders"));
    for (let i = 0; i < 60; i++)
      await writeFile(join(cwd, "renders", `${i}.png`), "x".repeat(1024));
    const fresh = (await blastRadius("rm -rf renders", cwd, since))!;
    expect(fresh).toMatchObject({ files: 60, outside: false });
    expect(fresh.existing).toBeUndefined();
    expect(risky(fresh)).toBe(false);
    // One old file among them is enough.
    const mixed = (await blastRadius("rm -rf renders manter.txt", cwd, since))!;
    expect(mixed.existing).toEqual({ files: 1, bytes: 4 });
    expect(risky(mixed)).toBe(true);
    const old = (await blastRadius("rm -rf work", cwd, since))!;
    expect(old.existing).toEqual({ files: 25, bytes: 24 * 1024 + 51200 });
    // Outside the folder the rule is the same.
    const outside = (await blastRadius("rm ../vizinho.txt", cwd, since))!;
    expect(outside).toMatchObject({ outside: true, existing: { files: 1 } });
    await writeFile(join(cwd, "..", "rascunho.txt"), "novo");
    const made = (await blastRadius("rm ../rascunho.txt", cwd, since))!;
    expect(made.outside).toBe(true);
    expect(risky(made)).toBe(false);
  });
  it("Git: o que clean removeria e as alterações que reset descarta", async () => {
    const { cwd } = await folder();
    const git = (...args: string[]) => capture("git", args, cwd);
    await git("init", "-q");
    await git("add", "manter.txt");
    await git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "x",
    );
    await writeFile(join(cwd, "manter.txt"), "mudou");
    const reset = (await blastRadius("git reset --hard", cwd))!;
    expect(reset.git).toEqual(["manter.txt"]);
    expect(reset.summary).toBe(
      "Descarta alterações não salvas no Git em 1 arquivo",
    );
    // Uncommitted changes always ask, whoever made them.
    expect(risky(reset)).toBe(true);
    // A dry run tells what clean -fd would remove: the untracked work folder.
    const clean = (await blastRadius("git clean -fd", cwd))!;
    expect(clean.files).toBe(25);
    // The untracked folder is the target; its heaviest contents are listed.
    expect(clean.entries[0].path).toBe(join("work", "v001"));
  });
  // Patterns from real sessions that asked for no reason.
  describe("sem alarmes falsos", () => {
    // A task folder outside the system temp folder, as real projects are.
    async function project() {
      const root = resolve(".codebit-test", "blast-" + randomUUID());
      roots.push(root);
      const cwd = join(root, "projeto");
      await mkdir(join(cwd, "vendor", "BodySlide", "ShapeData", "Peca"), {
        recursive: true,
      });
      await writeFile(join(cwd, "vendor", "BodySlide", "Log_OS.txt"), "log");
      await writeFile(
        join(cwd, "vendor", "BodySlide", "ShapeData", "Peca", "a.nif"),
        "x",
      );
      await mkdir(join(cwd, "tmp", "tasks", "velha"), { recursive: true });
      for (let i = 0; i < 80; i++)
        await writeFile(join(cwd, "tmp", "tasks", "velha", `${i}.json`), "{}");
      await mkdir(join(cwd, "build"), { recursive: true });
      await writeFile(join(cwd, "build", "saida.txt"), "x");
      return cwd;
    }
    it("variáveis e cd do próprio comando, e o corpo de um heredoc", async () => {
      const since = Date.now();
      await pause();
      const cwd = await project();
      const command = [
        `cd "${cwd}" && python - <<'PYEOF'`,
        "from pathlib import Path",
        'data = {"x": 1}',
        'del data["x"]',
        "PYEOF",
        'BS=vendor/BodySlide && rm -rf "$BS/ShapeData/Peca" "$BS/Log_OS.txt" && (cd "$BS" && ls) && rm -rf build',
      ].join("\n");
      const blast = (await blastRadius(command, cwd, since))!;
      expect(blast.unknown).toBeUndefined();
      // Peca (folder + file), the log and build (folder + file).
      expect(blast).toMatchObject({ files: 3, dirs: 2, outside: false });
      expect(risky(blast)).toBe(false);
      // $(pwd) is the folder the command is in at that point.
      const pwd = (await blastRadius(
        'cd vendor && OUT="$(pwd -W)/BodySlide"; rm -rf "$OUT"',
        cwd,
        since,
      ))!;
      expect(pwd.unknown).toBeUndefined();
      expect(pwd).toMatchObject({ files: 2, dirs: 3 });
      // Only the heredoc deletes nothing.
      expect(
        await blastRadius("python - <<'EOF'\ndel data['x']\nEOF", cwd),
      ).toBeUndefined();
    });
    it("um cd dentro de ( … ) não muda a pasta do resto", async () => {
      const cwd = await project();
      const blast = (await blastRadius(
        "(cd vendor/BodySlide && rm -rf ShapeData) && rm -rf build",
        cwd,
      ))!;
      expect(blast.entries.map((e) => e.path).sort()).toEqual([
        "build",
        join("vendor", "BodySlide", "ShapeData"),
      ]);
    });
    it("temporários e caches não contam", async () => {
      const cwd = await project();
      const scratch = (await blastRadius("rm -rf tmp/tasks/velha", cwd))!;
      expect(scratch).toMatchObject({ files: 80, outside: false });
      expect(scratch.temporary?.files).toBe(80);
      // Even from before the conversation.
      expect(risky(scratch)).toBe(false);
      const probe = join(tmpdir(), "codebit-sonda-" + randomUUID());
      await mkdir(probe);
      roots.push(probe);
      const temp = (await blastRadius(`rm -rf "${probe}"`, cwd))!;
      expect(temp.outside).toBe(false);
      expect(risky(temp)).toBe(false);
      // Git Bash: $(cygpath -u "…") is the path inside.
      const converted = (await blastRadius(
        `rm -rf "$(cygpath -u "${tmpdir()}")"/codebit-sonda-*`,
        cwd,
      ))!;
      expect(converted.unknown).toBeUndefined();
      expect(risky(converted)).toBe(false);
    });
    it("o que só se sabe na hora pergunta se pode alcançar arquivos antigos", async () => {
      const cwd = await project();
      await pause();
      const since = Date.now();
      await pause();
      await mkdir(join(cwd, "source", "v012", "build_teste"), {
        recursive: true,
      });
      await writeFile(join(cwd, "source", "v012", "build_teste", "a.nif"), "x");
      // The unknown part stays inside a folder made during the conversation.
      const loop = (folder: string) =>
        `B=${folder}; for p in a:1 b:2; do IFS=: read dir n <<< "$p"; rm -rf $B/$dir; done`;
      const inside = (await blastRadius(loop("source/v012"), cwd, since))!;
      expect(inside.unknown).toContain("$dir");
      expect(inside.reachesExisting).toBeUndefined();
      expect(risky(inside)).toBe(false);
      const older = (await blastRadius(loop("vendor"), cwd, since))!;
      expect(older.reachesExisting).toBe(true);
      expect(risky(older)).toBe(true);
      // Before a pipe, find bounds what xargs deletes, with its -name.
      const pipe = "find . -name '*.bak' | xargs rm -f";
      expect(risky((await blastRadius(pipe, cwd, since))!)).toBe(false);
      await writeFile(join(cwd, "vendor", "antigo.bak"), "x");
      expect(risky((await blastRadius(pipe, cwd, Date.now() + 1))!)).toBe(
        true,
      );
      // With no bound, or a bound full of old files, it asks.
      for (const command of [
        'for x in build/*; do rm -rf "$x"; done',
        'OUT="$(cat alvo.txt)"; rm -rf "$OUT"',
        "cat lista.txt | xargs rm -f",
        "Get-ChildItem vendor -Recurse | Remove-Item -Force",
      ]) {
        const blast = (await blastRadius(command, cwd, since))!;
        expect(blast.unknown, command).toBeTruthy();
        expect(risky(blast), command).toBe(true);
      }
      // Shell keywords in front do not hide a command.
      const guarded = (await blastRadius(
        "if [ -d build ]; then rm -rf build; fi",
        cwd,
      ))!;
      expect(guarded.files).toBe(1);
    });
    it.runIf(process.platform === "win32")(
      "caminhos do Git Bash viram caminhos do Windows",
      async () => {
        const cwd = await project();
        const posix = cwd
          .replace(/\\/g, "/")
          .replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
        const blast = (await blastRadius(`rm -rf ${posix}/build`, cwd))!;
        expect(blast).toMatchObject({ files: 1, outside: false });
      },
    );
  });
});
