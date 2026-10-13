import { createInterface } from "node:readline";
import { appVersion, subagentLabel } from "../shared/types";
const send = (id: any, result: any) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
// The same helper serves the image, subagent or social tools of a task.
const agents = process.env.CODEBIT_TOOLS === "agents";
const social = process.env.CODEBIT_TOOLS === "social";
const board = process.env.CODEBIT_TOOLS === "tasks";
// Board sessions suggest follow-ups; other project sessions also add
// what the user asks for.
const boardSession = process.env.CODEBIT_TASK_ROLE === "board";
// The sub-agents' CLI, model and limit, to tell the agent what it delegates to.
const subagents = (() => {
  try {
    return JSON.parse(process.env.CODEBIT_SUBAGENTS ?? "");
  } catch {
    return undefined;
  }
})();
const boardTools = [
  {
    name: "list_tasks",
    description:
      "Lista as tarefas do quadro deste projeto no Codebit, com o status de cada uma (pending: esperando aprovação; todo: na fila; running, waiting, done, failed, interrupted). Consulte antes de adicionar, para não duplicar.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "add_tasks",
    description: boardSession
      ? "Adiciona tarefas ao quadro deste projeto no Codebit. Use ao terminar, para recomendar continuações (um bug encontrado, uma melhoria, uma pendência): elas ficam pendentes da aprovação do usuário. Escreva cada descrição completa, porque outra sessão fará o trabalho sem ver esta conversa. Não trabalhe nelas agora."
      : "Adiciona tarefas ao quadro deste projeto no Codebit, para outra sessão fazer depois. Com requested_by_user: true, quando o usuário pediu nesta conversa para criar estas tarefas, elas vão para a fila (A fazer); sugestões suas vão sem esse campo e ficam pendentes da aprovação do usuário. Escreva cada descrição completa, porque quem fizer não vai ver esta conversa. Não trabalhe nelas nesta conversa.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
        requested_by_user: {
          type: "boolean",
          description:
            "true só quando o usuário pediu explicitamente nesta conversa para criar estas tarefas.",
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },
];
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
      "Lista as redes sociais conectadas a este projeto no Codebit (Instagram, Patreon), com a conta e a validade do acesso.",
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
const tools = board
  ? boardTools
  : social
    ? socialTools
    : agents
      ? [
          {
            name: "run_subagents",
            description:
              "Delega tarefas a sub-agentes do Codebit, que rodam em paralelo" +
              (subagents ? ` com ${subagentLabel(subagents)}` : "") +
              ", o CLI e o modelo que o usuário escolheu para isso. Use quando o pedido tiver partes independentes: pesquisas, revisões, análises, mudanças em arquivos ou módulos diferentes, testes. Os sub-agentes trabalham na mesma pasta e não veem esta conversa: descreva cada tarefa por completo, com contexto, arquivos e o que entregar, e não deixe dois editarem o mesmo arquivo. Retorna a resposta final de cada um.",
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
const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  let msg: any;
  try {
    msg = JSON.parse(line);
    if (msg.id === undefined) return;
    if (msg.method === "initialize")
      send(msg.id, {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: board
            ? "codebit-tasks"
            : social
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
      if (board) {
        if (msg.params.name === "add_tasks" && !args?.tasks?.length)
          throw new Error("Informe ao menos uma tarefa.");
        const response = await fetch(process.env.CODEBIT_TOOL_URL!, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.CODEBIT_TOOL_TOKEN}`,
          },
          body: JSON.stringify({ tool: msg.params.name, args: args ?? {} }),
          signal: AbortSignal.timeout(60_000),
        });
        const data: any = await response.json();
        if (!response.ok) throw new Error(data.error);
        send(msg.id, data);
        return;
      }
      if (social) {
        const response = await fetch(process.env.CODEBIT_TOOL_URL!, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.CODEBIT_TOOL_TOKEN}`,
          },
          body: JSON.stringify({ tool: msg.params.name, args: args ?? {} }),
          // The user approves each post, which can take a while.
          signal: AbortSignal.timeout(3_600_000),
        });
        const data: any = await response.json();
        if (!response.ok) throw new Error(data.error);
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
      const response = await fetch(process.env.CODEBIT_TOOL_URL!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.CODEBIT_TOOL_TOKEN}`,
        },
        body: JSON.stringify(args),
        // Subagents can run for a long time; image jobs stop after 16 min.
        signal: AbortSignal.timeout(agents ? 3_600_000 : 960000),
      });
      const data: any = await response.json();
      if (!response.ok) throw new Error(data.error);
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
