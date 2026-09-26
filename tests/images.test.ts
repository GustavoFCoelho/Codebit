import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ImageService } from "../src/main/images";
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
    defaultModels: { codex: "", claude: "", devin: "" },
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
    const artifact = await service.generate(
      "t",
      "Deixe azul",
      defaultImages,
      reference,
    );
    expect(await readFile(artifact.path)).toEqual(edited);
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
  it("cancelar encerra a espera pelo Codex", async () => {
    const service = await setup(undefined, codex);
    const promise = service.generate("t", "HOLD", defaultImages);
    await new Promise((r) => setTimeout(r, 300));
    service.cancel("t");
    await expect(promise).rejects.toThrow("cancelada");
  });
});
