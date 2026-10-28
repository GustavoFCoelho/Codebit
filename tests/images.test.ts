import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codexImageText, ImageService, pngInfo } from "../src/main/images";
import {
  defaultImages,
  type ImageOptions,
  type Installation,
  type Settings,
} from "../src/shared/types";
const roots: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8uoAAAAASUVORK5CYII=",
  "base64",
);
const openaiImages: ImageOptions = {
  ...defaultImages,
  provider: "openai",
  model: "gpt-image-2.5-flare",
};
const codex: Installation = {
  agent: "codex",
  command: process.execPath,
  path: process.execPath,
  args: [resolve("tests/fixtures/agent.mjs"), "codex"],
  version: "test",
};
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    if (
      !resolve(root).startsWith(join(resolve(tmpdir()), "codebit-image-test-"))
    )
      throw new Error("Diretório inválido");
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
async function setup(key?: string, installation?: Installation) {
  const root = await mkdtemp(join(tmpdir(), "codebit-image-test-"));
  roots.push(root);
  const settings: Settings = {
    cliPaths: {},
    comfyUrl: "http://127.0.0.1:8188",
    defaultModels: {
      codex: "",
      claude: "",
      devin: "",
      antigravity: "",
      deepseek: "",
    },
    mcp: [],
    workflows: [],
  };
  return new ImageService(
    root,
    () => settings,
    () => key,
    () => {},
    () => installation,
  );
}
describe("provedores de imagem", () => {
  it("não anuncia modelos como disponíveis sem credencial", async () => {
    const service = await setup();
    expect((await service.models("openai")).every((m) => !m.available)).toBe(
      true,
    );
    await expect(service.generate("t", "Teste", openaiImages)).rejects.toThrow(
      "Configure",
    );
  });
  it("intersecta catálogo com a conta e mantém o modelo solicitado na geração", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", async (url: any, init: any) => {
      calls.push({ url, ...init });
      return new Response(
        JSON.stringify(
          String(url).endsWith("/models")
            ? {
                data: [
                  { id: "gpt-image-2.5-flare" },
                  { id: "text-only-model" },
                ],
              }
            : { data: [{ b64_json: png.toString("base64") }] },
        ),
        { status: 200 },
      );
    });
    const service = await setup("test-key");
    const models = await service.models("openai");
    expect(models.filter((m) => m.available).map((m) => m.id)).toEqual([
      "gpt-image-2.5-flare",
    ]);
    const artifact = await service.generate(
      "task",
      "Uma luminária",
      openaiImages,
    );
    expect(JSON.parse(calls[1].body).model).toBe("gpt-image-2.5-flare");
    expect(await readFile(artifact.path)).toEqual(png);
    // Background goes as a parameter; several references, as image[].
    await service.generate("task", "Um ícone", {
      ...openaiImages,
      background: "transparent",
    });
    expect(JSON.parse(calls[2].body).background).toBe("transparent");
    const a = join(roots[0], "a.png");
    const b = join(roots[0], "b.webp");
    await writeFile(a, png);
    await writeFile(b, png);
    await service.generate("task", "Combine", openaiImages, [a, b]);
    const form = calls[3].body as FormData;
    expect(String(calls[3].url)).toMatch(/edits$/);
    expect(form.getAll("image[]").map((f: any) => f.type)).toEqual([
      "image/png",
      "image/webp",
    ]);
    expect(form.get("background")).toBeNull();
  });
  it("não repete geração após falha de cota", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "Quota excedida" } }), {
          status: 429,
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const service = await setup("test-key");
    await expect(
      service.generate("task", "Teste", openaiImages),
    ).rejects.toThrow("Quota");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("identifica dependências ausentes no ComfyUI", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({})));
    const service = await setup();
    const models = await service.models("comfyui");
    expect(models).toHaveLength(2);
    expect(
      models.every((m) => !m.available && m.reason?.includes("Nós ausentes")),
    ).toBe(true);
  });
  it("submete um workflow ComfyUI e recupera apenas seu resultado", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: any, init: any) => {
      urls.push(String(url));
      if (String(url).endsWith("/prompt"))
        return new Response(JSON.stringify({ prompt_id: "my-job" }));
      if (String(url).includes("/history/"))
        return new Response(
          JSON.stringify({
            "my-job": {
              outputs: {
                "9": {
                  images: [
                    { filename: "result.png", subfolder: "", type: "output" },
                  ],
                },
              },
            },
          }),
        );
      if (String(url).includes("/view?")) return new Response(png);
      throw new Error("Requisição inesperada");
    });
    const service = await setup();
    const a = await service.generate("t", "Teste", {
      ...defaultImages,
      provider: "comfyui",
      model: "sdxl.safetensors",
    });
    expect(a.provider).toBe("comfyui");
    expect(urls).toContain("http://127.0.0.1:8188/history/my-job");
    expect(await readFile(a.path)).toEqual(png);
  });
  it("cancelar interrompe o cliente sem repetir a solicitação OpenAI", async () => {
    const fetch = vi.fn(
      (url: any, init: any) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(new Error("Cancelado")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const service = await setup("test-key");
    const promise = service.generate("t", "Teste", openaiImages);
    service.cancel("t");
    await expect(promise).rejects.toThrow("Cancelado");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
describe("imagens pelo Codex CLI", () => {
  it("usa o provedor Codex por padrão, sem chave da API", async () => {
    expect(defaultImages.provider).toBe("codex");
    const service = await setup(undefined, codex);
    const [model] = await service.models("codex");
    expect(model).toMatchObject({ id: "gpt-image", available: true });
    const artifact = await service.generate("t", "Um farol", defaultImages);
    expect(artifact.provider).toBe("codex");
    expect(await readFile(artifact.path)).toEqual(png);
  });
  it("envia a imagem de referência ao editar", async () => {
    const service = await setup(undefined, codex);
    const reference = join(roots[0], "reference.png");
    const edited = Buffer.concat([png, Buffer.from("referencia")]);
    await writeFile(reference, edited);
    const artifact = await service.generate("t", "Deixe azul", defaultImages, [
      reference,
    ]);
    expect(await readFile(artifact.path)).toEqual(edited);
    expect(artifact.references).toEqual([reference]);
  });
  it("pede o prompt literal e devolve o que o gerador usou", async () => {
    const service = await setup(undefined, codex);
    const text = codexImageText(
      'Um elmo com "CODEBIT" gravado',
      { size: "1536x1024", background: "transparent" },
      2,
    );
    expect(text).toBe(
      [
        "<<<PROMPT",
        'Um elmo com "CODEBIT" gravado',
        "PROMPT>>>",
        "",
        "Formato: paisagem, 1536x1024 px.",
        "Fundo: transparente (PNG com canal alfa).",
        "2 imagens anexadas.",
      ].join("\n"),
    );
    // A model that follows the instructions keeps the prompt.
    const kept = await service.generate("t", "Um farol azul", {
      ...defaultImages,
      size: "1024x1536",
    });
    expect(kept.revisedPrompt).toBe(
      "Um farol azul\nFormato: retrato, 1024x1536 px.",
    );
    // One that rewrites it is reported as it is.
    const rewritten = await service.generate("t", "REWRITE", defaultImages);
    expect(rewritten.revisedPrompt).toBe("versão reescrita pelo modelo");
  });
  it("envia várias referências em ordem", async () => {
    const service = await setup(undefined, codex);
    const a = join(roots[0], "personagem.png");
    const b = join(roots[0], "armadura.png");
    await writeFile(a, Buffer.concat([png, Buffer.from("A")]));
    await writeFile(b, Buffer.from("B"));
    const artifact = await service.generate(
      "t",
      "Vista a armadura no personagem",
      defaultImages,
      [a, b],
    );
    expect(await readFile(artifact.path)).toEqual(
      Buffer.concat([png, Buffer.from("A"), Buffer.from("B")]),
    );
    expect(artifact.revisedPrompt).toContain("2 imagens anexadas.");
  });
  it("lê dimensões e transparência do PNG", () => {
    // The test image is grayscale with alpha (color type 4).
    expect(pngInfo(png)).toEqual({ width: 1, height: 1, alpha: true });
    const gray = Buffer.from(png);
    gray[25] = 0;
    expect(pngInfo(gray).alpha).toBe(false);
  });
  it("informa quando o CLI não está instalado", async () => {
    const service = await setup();
    const [model] = await service.models("codex");
    expect(model.available).toBe(false);
    await expect(service.generate("t", "Teste", defaultImages)).rejects.toThrow(
      "Codex CLI não encontrado",
    );
  });
  it("relata limite de uso e turnos sem imagem", async () => {
    const service = await setup(undefined, codex);
    await expect(service.generate("t", "LIMIT", defaultImages)).rejects.toThrow(
      "Limite de geração de imagens do Codex",
    );
    await expect(
      service.generate("t", "NOIMAGE", defaultImages),
    ).rejects.toThrow("sem gerar uma imagem");
  });
  it("gera com esforço baixo, sem herdar o padrão do config.toml", async () => {
    const service = await setup(undefined, codex);
    const artifact = await service.generate("t", "EFFORT", defaultImages);
    expect(artifact.provider).toBe("codex");
  });
  it("aguarda o motivo após imagem vazia e salva diagnóstico filtrado", async () => {
    const service = await setup(undefined, codex);
    const error = await service
      .generate("t", "EMPTY_DETAIL", defaultImages)
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Serviço temporariamente indisponível",
    );
    expect((error as Error).message).toContain("Diagnóstico:");
    expect((error as Error).message).not.toContain("sk-test-private-token");
    const folder = join(roots[0], "logs", "image-generations");
    const files = await readdir(folder);
    expect(files).toHaveLength(1);
    const raw = await readFile(join(folder, files[0]), "utf8");
    const diagnostic = JSON.parse(raw);
    expect(diagnostic.emptyImage).toBe(true);
    expect(
      diagnostic.events.some((e: any) => e.method === "turn/completed"),
    ).toBe(true);
    expect(raw).not.toContain("PRIVATE_PROMPT_NOT_FOR_LOGS");
    expect(raw).not.toContain("sk-test-private-token");
    expect(raw).not.toContain(png.toString("base64"));
    // The completed failure must release the per-task generation lock.
    expect(
      (await service.generate("t", "Um farol", defaultImages)).provider,
    ).toBe("codex");
  });
  it("cancelar encerra a espera pelo Codex", async () => {
    const service = await setup(undefined, codex);
    const promise = service.generate("t", "HOLD", defaultImages);
    await new Promise((r) => setTimeout(r, 300));
    service.cancel("t");
    await expect(promise).rejects.toThrow("cancelada");
  });
});
