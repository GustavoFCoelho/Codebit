import { createInterface } from "node:readline";
import { appVersion } from "../shared/types";
const send = (id: any, result: any) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
// The same helper serves the image tools or the subagent tool of a task.
const agents = process.env.CODEBIT_TOOLS === "agents";
const tools = agents
  ? [
      {
        name: "run_subagents",
        description:
          "Executa tarefas em sub-agentes do Codebit, com o CLI, modelo, esforço e limite de execuções simultâneas escolhidos pelo usuário. Os sub-agentes trabalham na mesma pasta e não veem esta conversa: descreva cada tarefa por completo. Retorna a resposta final de cada um.",
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
          "Gera uma imagem usando exatamente o provedor e modelo selecionados pelo usuário nesta tarefa do Codebit. Retorna o ID e o arquivo.",
        inputSchema: {
          type: "object",
          properties: { prompt: { type: "string" } },
          required: ["prompt"],
          additionalProperties: false,
        },
      },
      {
        name: "edit_image",
        description:
          "Edita uma imagem desta tarefa pelo ID retornado por generate_image ou pelo identificador de anexo fornecido pelo usuário.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            inputImage: { type: "string" },
          },
          required: ["prompt", "inputImage"],
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
          name: agents ? "codebit-agents" : "codebit-images",
          version: appVersion,
        },
      });
    else if (msg.method === "ping") send(msg.id, {});
    else if (msg.method === "tools/list") send(msg.id, { tools });
    else if (msg.method === "tools/call") {
      if (!tools.some((t) => t.name === msg.params.name))
        throw new Error("Ferramenta desconhecida.");
      const args = msg.params.arguments;
      if (agents ? !args?.tasks?.length : !args?.prompt)
        throw new Error(
          agents ? "Informe ao menos uma tarefa." : "Informe o prompt.",
        );
      if (msg.params.name === "edit_image" && !args.inputImage)
        throw new Error("Prompt e imagem de edição são obrigatórios.");
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
