import { createInterface } from "node:readline";
import { appVersion } from "../shared/types";
import { answerHook } from "./agy-hook";
import { postBridge } from "./bridge-client";
const send = (id: any, result: any) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
// The same helper serves the image, subagent or social tools of a task.
const agents = process.env.CODEBIT_TOOLS === "agents";
const social = process.env.CODEBIT_TOOLS === "social";
const imageList = {
  type: "array",
  maxItems: 10,
  items: { type: "string" },
  description:
    "Caminhos dos arquivos (absolutos ou relativos à pasta da tarefa) ou IDs de imagens geradas pelo Codebit.",
};
// What a call may choose; the provider and model stay the user's choice.
const imageOptions = {
  aspect: {
    type: "string",
    enum: ["square", "landscape", "portrait"],
    description:
      "Formato: square (1024×1024), landscape (1536×1024) ou portrait (1024×1536). Sem ele, vale o formato escolhido na tarefa.",
  },
  background: {
    type: "string",
    enum: ["auto", "transparent", "opaque"],
    description:
      "transparent para recortes com canal alfa: ícones, sprites, objetos isolados.",
  },
  saveAs: {
    type: "string",
    description:
      "Caminho .png na pasta da tarefa onde salvar uma cópia (ex.: concepts/armadura.png). Pastas são criadas e um arquivo existente é substituído.",
  },
};
const socialTools = [
  {
    name: "social_accounts",
    description:
      "Lista as redes sociais conectadas a este projeto no Codebit (Instagram, Patreon e LinkedIn), com a conta e a validade do acesso.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "instagram_publish",
    description:
      "Publica no Instagram conectado a este projeto: uma imagem, um carrossel (até 10) ou um story. As imagens viram JPEG; no feed, a proporção é recortada ao centro para caber entre 4:5 e 1,91:1. O usuário vê a prévia exata e aprova antes; se recusar, pergunte o que ajustar. Retorna o link do post.",
    inputSchema: {
      type: "object",
      properties: {
        images: { ...imageList, minItems: 1 },
        caption: {
          type: "string",
          description: "Legenda, até 2.200 caracteres e 30 hashtags.",
        },
        kind: { type: "string", enum: ["feed", "story"] },
        alt_text: {
          type: "string",
          description: "Texto alternativo das imagens, para acessibilidade.",
        },
        ai_generated: {
          type: "boolean",
          description: "Marque quando as imagens foram geradas por IA.",
        },
      },
      required: ["images"],
      additionalProperties: false,
    },
  },
  {
    name: "linkedin_publish",
    description:
      "Publica uma atualização pública no perfil pessoal do LinkedIn conectado a este projeto. Aceita texto e opcionalmente uma imagem PNG/JPEG. O usuário vê a prévia exata e aprova antes da publicação. Não publica em páginas de empresas.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Texto público da publicação, até 3.000 caracteres. Pode incluir links como texto." },
        images: { ...imageList, maxItems: 1 },
        alt_text: { type: "string", description: "Descrição acessível da imagem, até 1.000 caracteres." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "patreon_publish",
    description:
      "Publica um post no Patreon conectado a este projeto, preenchendo o editor do site numa janela do Codebit. O usuário vê a prévia e aprova antes. Se um passo falhar, o rascunho fica aberto para o usuário publicar: não tente de novo por conta própria.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        text: {
          type: "string",
          description:
            "Texto do post; separe parágrafos com uma linha em branco.",
        },
        images: imageList,
        audience: {
          type: "string",
          description:
            'Quem pode ver: "public", "members" (todos os membros), "paid" (só pagantes) ou o nome exato de um nível.',
        },
      },
      required: ["title", "text", "audience"],
      additionalProperties: false,
    },
  },
];
const tools = social
  ? socialTools
  : agents
    ? [
        {
          name: "run_subagents",
          description:
            "Delega tarefas a sub-agentes do Codebit em paralelo usando a configuração da tarefa. O Codebit verifica a permissão efetiva a cada chamada e rejeita quando a delegação está bloqueada. Use apenas para partes independentes. Os sub-agentes trabalham na mesma pasta e não veem esta conversa: descreva cada tarefa por completo, com contexto, arquivos e o que entregar, e não deixe dois editarem o mesmo arquivo. Retorna a resposta final de cada um.",
          inputSchema: {
            type: "object",
            properties: {
              tasks: {
                type: "array",
                minItems: 1,
                maxItems: 20,
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    prompt: { type: "string" },
                  },
                  required: ["prompt"],
                  additionalProperties: false,
                },
              },
            },
            required: ["tasks"],
            additionalProperties: false,
          },
        },
      ]
    : [
        {
          name: "generate_image",
          description:
            "Gera uma imagem com o provedor e o modelo que o usuário escolheu nesta tarefa do Codebit (normalmente GPT Image). O prompt chega ao gerador como você o escreveu: descreva assunto, estilo, composição, enquadramento, iluminação, cores e o que não deve aparecer; textos que devem aparecer na imagem vão entre aspas. Retorna o ID, o arquivo, as dimensões, uma prévia reduzida e promptKept; se o gerador tiver alterado o prompt, revisedPrompt mostra o que ele usou: compare e ajuste.",
          inputSchema: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description: "Descrição completa da imagem.",
              },
              ...imageOptions,
            },
            required: ["prompt"],
            additionalProperties: false,
          },
        },
        {
          name: "edit_image",
          description:
            "Edita uma imagem ou cria uma nova a partir de referências. Com uma imagem, descreva a mudança e diga o que deve ficar igual (rosto, pose, cores, enquadramento). Com várias, diga no prompt o papel de cada uma pela ordem (ex.: a primeira é o personagem; a segunda, a armadura a vestir nele). Retorna o mesmo que generate_image.",
          inputSchema: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description:
                  "A mudança, ou a imagem a criar a partir das referências.",
              },
              images: {
                type: "array",
                items: { type: "string" },
                minItems: 1,
                maxItems: 10,
                description:
                  "Imagens, em ordem: IDs retornados por generate_image ou edit_image, identificadores de anexos do usuário ou caminhos de arquivos PNG, JPEG ou WebP (relativos à pasta da tarefa ou absolutos).",
              },
              inputImage: {
                type: "string",
                description: "Uma imagem só; o mesmo que images com um item.",
              },
              ...imageOptions,
            },
            required: ["prompt"],
            additionalProperties: false,
          },
        },
      ];
// Antigravity's tool hook runs this script too, once per gated tool call.
const input =
  process.argv[2] === "hook"
    ? undefined
    : createInterface({ input: process.stdin });
if (!input) void answerHook();
input?.on("line", async (line) => {
  let msg: any;
  try {
    msg = JSON.parse(line);
    if (msg.id === undefined) return;
    if (msg.method === "initialize")
      send(msg.id, {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: social
            ? "codebit-social"
            : agents
              ? "codebit-agents"
              : "codebit-images",
          version: appVersion,
        },
      });
    else if (msg.method === "ping") send(msg.id, {});
    else if (msg.method === "tools/list") send(msg.id, { tools });
    else if (msg.method === "tools/call") {
      if (!tools.some((t) => t.name === msg.params.name))
        throw new Error("Ferramenta desconhecida.");
      const args = msg.params.arguments;
      if (social) {
        const { ok, data } = await postBridge(
          process.env.CODEBIT_TOOL_URL!,
          process.env.CODEBIT_TOOL_TOKEN,
          JSON.stringify({ tool: msg.params.name, args: args ?? {} }),
          // The user approves each post, which can take a while.
          3_600_000,
        );
        if (!ok) throw new Error(data.error || "O Codebit recusou o pedido.");
        send(msg.id, data);
        return;
      }
      if (agents ? !args?.tasks?.length : !args?.prompt)
        throw new Error(
          agents ? "Informe ao menos uma tarefa." : "Informe o prompt.",
        );
      if (
        msg.params.name === "edit_image" &&
        !args.inputImage &&
        !args.images?.length
      )
        throw new Error("Informe a imagem a editar em images.");
      const { ok, data } = await postBridge(
        process.env.CODEBIT_TOOL_URL!,
        process.env.CODEBIT_TOOL_TOKEN,
        JSON.stringify(args),
        // Subagents can run for a long time; image jobs stop after 16 min.
        agents ? 3_600_000 : 960000,
      );
      if (!ok) throw new Error(data.error || "O Codebit recusou o pedido.");
      send(msg.id, data);
    } else
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "Método não suportado." },
        }) + "\n",
      );
  } catch (e) {
    if (msg?.id !== undefined)
      send(msg.id, {
        isError: true,
        content: [{ type: "text", text: (e as Error).message }],
      });
  }
});
