import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Channel } from "./agents/protocol";
import { CodexImageReply, imageDiagnosticText } from "./codex-image-reply";
import type {
  Artifact,
  ImageModel,
  ImageOptions,
  ImageProviderId,
  Installation,
  Settings,
  Workflow,
} from "../shared/types";
import { appVersion } from "../shared/types";
// The Codex App Server picks the image model; clients cannot select it.
export const codexImageModel = "gpt-image";
const codexImageInstructions =
  "Você é o gerador de imagens do Codebit. Use a ferramenta nativa de geração de imagens exatamente uma vez para atender ao pedido do usuário. Se houver uma imagem anexada, edite essa imagem. Não execute comandos, não leia arquivos e não faça perguntas.";
async function initCodex(channel: Channel) {
  await channel.request("initialize", {
    clientInfo: { name: "codebit", title: "Codebit", version: appVersion },
    capabilities: { experimentalApi: true },
  });
  channel.send({ method: "initialized" });
}
export const imageCatalog = [
  ["gpt-image-2.5-flare", "GPT Image 2.5 · Flare"],
  ["gpt-image-2.5-sunburst", "GPT Image 2.5 · Sunburst"],
  ["gpt-image-2", "GPT Image 2"],
  ["gpt-image-1.5", "GPT Image 1.5"],
  ["gpt-image-1", "GPT Image 1"],
  ["gpt-image-1-mini", "GPT Image 1 Mini"],
];
export function sdxlPreset(edit = false): Workflow {
  return {
    id: edit ? "sdxl-edit" : "sdxl-text",
    name: edit ? "SDXL · Imagem para imagem" : "SDXL · Texto para imagem",
    kind: edit ? "edit" : "generate",
    builtin: true,
    bindings: {
      prompt: "6.inputs.text",
      model: "4.inputs.ckpt_name",
      seed: "3.inputs.seed",
      width: edit ? "12.inputs.width" : "5.inputs.width",
      height: edit ? "12.inputs.height" : "5.inputs.height",
      ...(edit ? { image: "10.inputs.image" } : {}),
    },
    graph: {
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "" } },
      "5": {
        class_type: "EmptyLatentImage",
        inputs: { width: 1024, height: 1024, batch_size: 1 },
      },
      "6": {
        class_type: "CLIPTextEncode",
        inputs: { text: "", clip: ["4", 1] },
      },
      "7": {
        class_type: "CLIPTextEncode",
        inputs: { text: "", clip: ["4", 1] },
      },
      "3": {
        class_type: "KSampler",
        inputs: {
          seed: 0,
          steps: 25,
          cfg: 7,
          sampler_name: "euler",
          scheduler: "normal",
          denoise: edit ? 0.65 : 1,
          model: ["4", 0],
          positive: ["6", 0],
          negative: ["7", 0],
          latent_image: edit ? ["11", 0] : ["5", 0],
        },
      },
      "8": {
        class_type: "VAEDecode",
        inputs: { samples: ["3", 0], vae: ["4", 2] },
      },
      "9": {
        class_type: "SaveImage",
        inputs: { filename_prefix: "Codebit", images: ["8", 0] },
      },
      ...(edit
        ? {
            "10": { class_type: "LoadImage", inputs: { image: "" } },
            "11": {
              class_type: "VAEEncode",
              inputs: { pixels: ["12", 0], vae: ["4", 2] },
            },
            "12": {
              class_type: "ImageScale",
              inputs: {
                image: ["10", 0],
                upscale_method: "lanczos",
                width: 1024,
                height: 1024,
                crop: "center",
              },
            },
          }
        : {}),
    },
  };
}
export function bindWorkflow(
  workflow: Workflow,
  values: Record<string, unknown>,
): Record<string, any> {
  const graph = structuredClone(workflow.graph);
  for (const [name, path] of Object.entries(workflow.bindings)) {
    if (!(name in values)) continue;
    const parts = path.split(".");
    if (
      parts.length !== 3 ||
      parts[1] !== "inputs" ||
      parts.some((p) =>
        ["__proto__", "constructor", "prototype"].includes(p),
      ) ||
      !graph[parts[0]]?.inputs ||
      !(parts[2] in graph[parts[0]].inputs)
    )
      throw new Error(
        `Mapeamento inválido: ${name}. Use nó.inputs.campo existente.`,
      );
    graph[parts[0]].inputs[parts[2]] = values[name];
  }
  return graph;
}
export function validateWorkflow(w: Workflow) {
  if (
    typeof w.id !== "string" ||
    !w.id ||
    !["generate", "edit"].includes(w.kind) ||
    !w.name ||
    !w.graph ||
    !Object.keys(w.graph).length ||
    !w.bindings?.prompt
  )
    throw new Error("Informe nome, grafo API e mapeamento do prompt.");
  if (w.kind === "edit" && !w.bindings.image)
    throw new Error("Mapeie a imagem de entrada no workflow de edição.");
  for (const node of Object.values(w.graph))
    if (!node.class_type || !node.inputs)
      throw new Error(
        "Importe o workflow no formato API (nós com class_type e inputs).",
      );
  bindWorkflow(
    w,
    Object.fromEntries(Object.keys(w.bindings).map((k) => [k, "test"])),
  );
}
export async function jsonRequest(
  url: string,
  init: RequestInit = {},
): Promise<any> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal || AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      data.error?.message ||
        data.error ||
        `O serviço respondeu HTTP ${response.status}.`,
    );
  return data;
}
export class ImageService {
  private jobs = new Map<string, AbortController>();
  constructor(
    private root: string,
    private settings: () => Settings,
    private key: () => string | undefined,
    private progress: (taskId: string, message: string) => void,
    private codexInstallation: () => Installation | undefined = () => undefined,
  ) {}
  workflows() {
    return [sdxlPreset(), sdxlPreset(true), ...this.settings().workflows];
  }
  async models(provider: ImageProviderId): Promise<ImageModel[]> {
    if (provider === "codex") {
      const model = {
        id: codexImageModel,
        name: "GPT Image · via Codex",
        provider,
      };
      const installation = this.codexInstallation();
      if (!installation)
        return [
          {
            ...model,
            available: false,
            reason:
              "Codex CLI não encontrado. Selecione o executável em Configurações → Agentes.",
          },
        ];
      const channel = new Channel(
        installation,
        ["app-server", "--listen", "stdio://"],
        this.root,
        "codex",
        () => {},
        () => {},
      );
      try {
        await initCodex(channel);
        const caps = await channel.request(
          "modelProvider/capabilities/read",
          {},
        );
        return [
          {
            ...model,
            available: !!caps.imageGeneration,
            verified: !!caps.imageGeneration,
            reason: caps.imageGeneration
              ? "Usa o login do Codex CLI. O modelo de imagem é definido pelo Codex."
              : "O provedor configurado no Codex não oferece geração de imagens.",
          },
        ];
      } catch (e) {
        return [
          {
            ...model,
            available: false,
            reason: `Não foi possível consultar o Codex: ${(e as Error).message}`,
          },
        ];
      } finally {
        channel.close();
      }
    }
    if (provider === "openai") {
      const key = this.key();
      if (!key)
        return imageCatalog.map(([id, name]) => ({
          id,
          name,
          provider,
          available: false,
          reason: "Configure sua chave da API OpenAI.",
        }));
      const data = await jsonRequest("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
      });
      const ids = new Set(data.data.map((m: any) => m.id));
      return imageCatalog.map(([id, name]) => ({
        id,
        name,
        provider,
        available: ids.has(id),
        verified: ids.has(id),
        reason: ids.has(id) ? undefined : "Modelo não listado para esta conta.",
      }));
    }
    const info = await jsonRequest(
      this.settings().comfyUrl.replace(/\/$/, "") + "/object_info",
    );
    const result: ImageModel[] = [];
    for (const w of this.workflows()) {
      const missing = [
        ...new Set(Object.values(w.graph).map((n) => n.class_type)),
      ].filter((n) => !info[n]);
      const modelBinding = w.bindings.model?.split(".");
      const choices = modelBinding
        ? info[w.graph[modelBinding[0]]?.class_type]?.input?.required?.[
            modelBinding[2]
          ]?.[0]
        : undefined;
      // SDXL presets are advertised only for explicitly named SDXL checkpoints.
      const models: string[] = Array.isArray(choices)
        ? choices.filter(
            (m: any) =>
              typeof m === "string" &&
              (!w.builtin ||
                /sdxl|xl[_\-. ]|[_\-. ]xl|juggernautxl|realvisxl/i.test(m)),
          )
        : ["workflow"];
      if (!models.length || missing.length)
        result.push({
          id: w.id,
          name: w.name,
          provider,
          available: false,
          workflow: w.id,
          kind: w.kind,
          reason: missing.length
            ? `Nós ausentes: ${missing.join(", ")}`
            : "Nenhum checkpoint SDXL identificado. Importe um workflow com seu modelo.",
        });
      else
        for (const model of models)
          result.push({
            id: model,
            name: `${w.name} · ${model === "workflow" ? "modelo do workflow" : model}`,
            provider,
            available: true,
            verified: true,
            workflow: w.id,
            kind: w.kind,
          });
    }
    return result;
  }
  async generate(
    taskId: string,
    prompt: string,
    options: ImageOptions,
    inputPath?: string,
  ): Promise<Artifact> {
    if (this.jobs.has(taskId))
      throw new Error("A tarefa já tem uma geração em andamento.");
    if (!prompt.trim()) throw new Error("Descreva a imagem que deseja criar.");
    const abort = new AbortController();
    this.jobs.set(taskId, abort);
    const id = randomUUID();
    this.progress(taskId, "Preparando geração…");
    try {
      const bytes =
        options.provider === "codex"
          ? await this.codex(taskId, prompt, options, inputPath, abort.signal)
          : options.provider === "openai"
            ? await this.openai(prompt, options, inputPath, abort.signal)
            : await this.comfy(
                taskId,
                prompt,
                options,
                inputPath,
                abort.signal,
              );
      if (abort.signal.aborted)
        throw new Error(
          "Geração cancelada localmente. O provedor pode concluir a solicitação já enviada.",
        );
      if (
        !bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new Error(
          "O provedor retornou um formato incompatível. Configure uma saída PNG no workflow.",
        );
      return await this.save(taskId, prompt, options, bytes, id);
    } finally {
      this.jobs.delete(taskId);
      this.progress(taskId, "");
    }
  }
  // Also used for images an agent generates with its own tools.
  async save(
    taskId: string,
    prompt: string,
    options: ImageOptions,
    bytes: Buffer,
    id: string = randomUUID(),
  ): Promise<Artifact> {
    const folder = join(this.root, "artifacts", taskId);
    await mkdir(folder, { recursive: true });
    const path = join(folder, id + ".png");
    await writeFile(path, bytes);
    return {
      id,
      taskId,
      path,
      prompt,
      provider: options.provider,
      model: options.model,
      options,
      createdAt: new Date().toISOString(),
    };
  }
  cancel(taskId: string) {
    this.jobs.get(taskId)?.abort();
  }
  busy() {
    return this.jobs.size > 0;
  }
  close() {
    for (const job of this.jobs.values()) job.abort();
  }
  private codex(
    taskId: string,
    prompt: string,
    options: ImageOptions,
    inputPath: string | undefined,
    signal: AbortSignal,
  ) {
    const installation = this.codexInstallation();
    if (!installation)
      throw new Error(
        "Codex CLI não encontrado. Selecione o executável em Configurações → Agentes.",
      );
    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const done = (error?: Error, bytes?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reply.close();
        signal.removeEventListener("abort", cancel);
        channel.close();
        if (!error) return resolve(bytes!);
        const detail = imageDiagnosticText(error.message);
        const folder = join(this.root, "logs", "image-generations");
        const path = join(folder, randomUUID() + ".json");
        void mkdir(folder, { recursive: true })
          .then(() =>
            writeFile(path, JSON.stringify(reply.diagnostic(detail), null, 2)),
          )
          .then(
            () => reject(new Error(`${detail}\nDiagnóstico: ${path}`)),
            () =>
              reject(
                new Error(
                  `${detail}\nNão foi possível salvar o diagnóstico local.`,
                ),
              ),
          );
      };
      const cancel = () =>
        done(
          new Error(
            "Geração cancelada localmente. O Codex pode concluir a solicitação já enviada.",
          ),
        );
      const timer = setTimeout(
        () =>
          done(
            new Error(
              reply.failureMessage(
                "Tempo esgotado aguardando a imagem do Codex.",
              ),
            ),
          ),
        600000,
      );
      const reply = new CodexImageReply({
        success: (bytes) => done(undefined, bytes),
        failure: (error) => done(error),
        progress: (text) => this.progress(taskId, text),
      });
      const channel = new Channel(
        installation,
        ["app-server", "--listen", "stdio://"],
        this.root,
        "codex",
        (msg) => {
          const p = msg.params || {};
          if (msg.id != null && msg.method) {
            channel.send({
              id: msg.id,
              error: {
                code: -32601,
                message: "Solicitação não suportada na geração de imagens.",
              },
            });
            return;
          }
          reply.receive(msg);
        },
        (e) => done(new Error(reply.failureMessage(e.message))),
      );
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) return cancel();
      void (async () => {
        await initCodex(channel);
        const { thread } = await channel.request("thread/start", {
          cwd: this.root,
          ephemeral: true,
          approvalPolicy: "never",
          sandbox: "read-only",
          developerInstructions: codexImageInstructions,
        });
        reply.setThread(thread.id);
        const [width, height] = options.size.split("x").map(Number);
        const shape =
          width === height
            ? "quadrado"
            : width > height
              ? "paisagem"
              : "retrato";
        const input: any[] = [
          {
            type: "text",
            text:
              (inputPath ? "Edite a imagem anexada: " : "") +
              prompt +
              (options.size === "auto"
                ? ""
                : `\n\nFormato desejado: ${shape}, ${options.size} px.`),
            text_elements: [],
          },
        ];
        if (inputPath) input.push({ type: "localImage", path: inputPath });
        // The turn only calls the image tool: low effort spends less of the
        // plan than the default from config.toml (often xhigh).
        await channel.request("turn/start", {
          threadId: thread.id,
          input,
          effort: "low",
        });
      })().catch((e) => done(e));
    });
  }
  private async openai(
    prompt: string,
    options: ImageOptions,
    inputPath: string | undefined,
    signal: AbortSignal,
  ) {
    const key = this.key();
    if (!key)
      throw new Error(
        "Configure sua chave da API OpenAI em Configurações → Imagens ou selecione o provedor Codex.",
      );
    if (!imageCatalog.some(([id]) => id === options.model))
      throw new Error("Modelo de imagem não suportado.");
    const endpoint =
      "https://api.openai.com/v1/images/" +
      (inputPath ? "edits" : "generations");
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    let body: any;
    if (inputPath) {
      const form = new FormData();
      for (const [k, v] of Object.entries({
        model: options.model,
        prompt,
        size: options.size,
        quality: options.quality,
        output_format: "png",
      }))
        form.append(k, v);
      const bytes = await readFile(inputPath);
      form.append(
        "image[]",
        new Blob([bytes], {
          type:
            extname(inputPath).toLowerCase() === ".png"
              ? "image/png"
              : extname(inputPath).toLowerCase() === ".webp"
                ? "image/webp"
                : "image/jpeg",
        }),
        basename(inputPath),
      );
      body = form;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({
        model: options.model,
        prompt,
        size: options.size,
        quality: options.quality,
        output_format: "png",
        n: 1,
      });
    }
    const data = await jsonRequest(endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(600000)]),
    });
    if (!data.data?.[0]?.b64_json)
      throw new Error("O provedor não retornou uma imagem.");
    return Buffer.from(data.data[0].b64_json, "base64");
  }
  private async comfy(
    taskId: string,
    prompt: string,
    options: ImageOptions,
    inputPath: string | undefined,
    signal: AbortSignal,
  ) {
    const base = this.settings().comfyUrl.replace(/\/$/, "");
    const workflow = this.workflows().find((w) => w.id === options.workflow);
    if (!workflow) throw new Error("Selecione um workflow.");
    if (workflow.kind === "edit" && !inputPath)
      throw new Error("Este workflow precisa de uma imagem de entrada.");
    if (inputPath && workflow.kind !== "edit")
      throw new Error(
        "Selecione um workflow de edição para usar uma imagem de entrada.",
      );
    const [width, height] =
      options.size === "auto"
        ? [1024, 1024]
        : options.size.split("x").map(Number);
    const values: Record<string, unknown> = {
      prompt,
      model: options.model,
      seed: options.seed || Math.floor(Math.random() * 2 ** 32),
      width,
      height,
    };
    if (inputPath) {
      const form = new FormData();
      form.append(
        "image",
        new Blob([await readFile(inputPath)]),
        randomUUID() + extname(inputPath),
      );
      const uploaded = await jsonRequest(base + "/upload/image", {
        method: "POST",
        body: form,
        signal,
      });
      values.image = uploaded.subfolder
        ? uploaded.subfolder + "/" + uploaded.name
        : uploaded.name;
    }
    const graph = bindWorkflow(workflow, values);
    const submitted = await jsonRequest(base + "/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: randomUUID() }),
      signal,
    });
    if (!submitted.prompt_id || submitted.error)
      throw new Error(
        "Workflow recusado: " +
          JSON.stringify(submitted.error || submitted.node_errors),
      );
    const promptId = submitted.prompt_id;
    const deadline = Date.now() + 15 * 60_000;
    const cancelQueued = () => {
      void fetch(base + "/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: [promptId] }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    };
    signal.addEventListener("abort", cancelQueued, { once: true });
    try {
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        const history = await jsonRequest(
          base + "/history/" + encodeURIComponent(promptId),
          { signal },
        );
        const item = history[promptId];
        if (item?.status?.status_str === "error")
          throw new Error(
            "ComfyUI falhou: " +
              JSON.stringify(item.status.messages).slice(0, 1200),
          );
        const images = Object.values(item?.outputs || {}).flatMap(
          (v: any) => v.images || [],
        );
        if (images.length) {
          const image: any = images[0];
          const query = new URLSearchParams({
            filename: image.filename,
            subfolder: image.subfolder || "",
            type: image.type || "output",
          });
          const response = await fetch(base + "/view?" + query, { signal });
          if (!response.ok)
            throw new Error("Não foi possível obter o resultado do ComfyUI.");
          return Buffer.from(await response.arrayBuffer());
        }
        this.progress(taskId, "ComfyUI · aguardando resultado na fila local…");
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            resolve();
          };
          const cancel = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            reject(new Error("Geração cancelada localmente."));
          };
          const timer = setTimeout(done, 1000);
          signal.addEventListener("abort", cancel, { once: true });
        });
      }
      throw new Error(
        "Tempo de espera excedido. Consulte a fila do ComfyUI antes de tentar novamente.",
      );
    } finally {
      signal.removeEventListener("abort", cancelQueued);
    }
  }
}
