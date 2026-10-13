import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse } from "smol-toml";
import type { AgentId, McpConfig, SkillInfo } from "../shared/types";
import { subagentLabel } from "../shared/types";
export async function skills(cwd?: string): Promise<SkillInfo[]> {
  const result: SkillInfo[] = [];
  for (const agent of ["codex", "claude"] as AgentId[]) {
    const roots = [
      join(homedir(), `.${agent}`, "skills"),
      ...(cwd
        ? [
            join(cwd, `.${agent}`, "skills"),
            ...(agent === "codex" ? [join(cwd, ".agents", "skills")] : []),
          ]
        : []),
    ];
    async function walk(root: string, depth = 0) {
      if (depth > 2) return;
      try {
        for (const entry of await readdir(root, { withFileTypes: true }))
          if (entry.isDirectory()) {
            const folder = join(root, entry.name),
              path = join(folder, "SKILL.md");
            try {
              const text = await readFile(path, "utf8");
              const desc =
                /^description:\s*["']?(.*)$/m
                  .exec(text)?.[1]
                  ?.replace(/["']$/, "") || "";
              result.push({
                name:
                  /^name:\s*["']?([^\r\n"']+)/m.exec(text)?.[1] || entry.name,
                description: desc,
                path,
                agent,
                source: root.startsWith(homedir()) ? "Usuário" : "Projeto",
              });
            } catch {
              if (entry.name.startsWith(".")) await walk(folder, depth + 1);
            }
          }
      } catch {}
    }
    for (const root of roots) await walk(root);
  }
  return result;
}
export async function nativeMcp(cwd?: string) {
  const rows: { name: string; agent: string; source: string }[] = [];
  for (const [path, agent, toml] of [
    [
      join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"),
      "codex",
      true,
    ],
    [join(homedir(), ".claude.json"), "claude", false],
    ...(cwd ? [[join(cwd, ".mcp.json"), "claude", false]] : []),
  ] as [string, string, boolean][]) {
    try {
      const raw = await readFile(path, "utf8");
      const config: any = toml ? parse(raw) : JSON.parse(raw);
      for (const name of Object.keys(
        config.mcp_servers || config.mcpServers || {},
      ))
        rows.push({ name, agent, source: path });
    } catch {}
  }
  return rows;
}
// Agents that insist on something that does not work waste the plan and can
// loop forever; Codebit also stops them (see guard.ts).
export const stopWhenStuck =
  " Se uma ação não der o resultado esperado depois de duas tentativas (por exemplo, um download que não chega ou um comando que falha do mesmo jeito), não insista nem repita: pare e explique o problema ao usuário para decidirem juntos.";
export function codebitInstructions(mcp: Record<string, any>, guidelines = "") {
  return (
    "Você está no Codebit. Responda em português do Brasil." +
    stopWhenStuck +
    " Use o MCP codebit_images para gerar ou editar imagens; ele utiliza o provedor e modelo escolhidos na tarefa. Ele aceita formato, fundo transparente, várias imagens de referência (inclusive arquivos da pasta) e saveAs para salvar no projeto." +
    (mcp.codebit_agents ? subagentInstructions(mcp.codebit_agents.env) : "") +
    (mcp.codebit_tasks?.env?.CODEBIT_TASK_ROLE === "board"
      ? " Esta conversa trabalha numa tarefa do quadro do projeto. Ao terminar, se perceber trabalho de continuação que mereça outra tarefa (um bug encontrado, uma melhoria, uma pendência), use add_tasks do MCP codebit_tasks, com título e descrição completa de cada uma. Elas ficam pendentes da aprovação do usuário: não trabalhe nelas agora."
      : mcp.codebit_tasks
        ? " Este projeto tem um quadro de tarefas no Codebit, que o MCP codebit_tasks alcança. Quando o usuário pedir para criar tarefas, registrar pendências ou deixar trabalho para depois no quadro, use add_tasks com requested_by_user: true; elas vão para a fila. Ideias suas vão sem esse campo e ficam pendentes da aprovação dele. Use list_tasks para ver o quadro e não duplicar. Não execute nesta conversa o que foi para o quadro."
        : "") +
    (mcp.codebit_social
      ? " Para publicar nas redes sociais deste projeto, use o MCP codebit_social (social_accounts, instagram_publish, patreon_publish). Cada publicação mostra a prévia exata e espera a aprovação do usuário; nunca publique por outro meio, como scripts, navegador ou APIs chamadas por você."
      : "") +
    guidelinesText(guidelines)
  );
}
// The user turned sub-agents on to have work delegated, to the CLI and model
// they chose; without saying when, agents keep doing everything themselves or
// use their own native sub-agents.
function subagentInstructions(env: Record<string, string> = {}) {
  let label = "";
  try {
    label = subagentLabel(JSON.parse(env.CODEBIT_SUBAGENTS));
  } catch {}
  return (
    " Os sub-agentes do Codebit estão ligados nesta conversa: run_subagents, do MCP codebit_agents, executa tarefas em paralelo" +
    (label ? ` com ${label},` : "") +
    " na mesma pasta. O usuário os ligou para você delegar: quando o pedido tiver partes que andam sozinhas (pesquisar, revisar, analisar ou alterar arquivos e módulos diferentes, escrever testes, comparar alternativas), divida e delegue essas partes com run_subagents, em vez de fazer tudo em sequência. Para delegar, prefira run_subagents aos seus sub-agentes nativos. Os sub-agentes não veem esta conversa: descreva cada tarefa por completo, com contexto, arquivos e o que entregar, e não deixe dois editarem o mesmo arquivo. Trabalho curto, ou em que cada passo depende do anterior, faça você mesmo. Se as instruções do projeto (AGENTS.md, CLAUDE.md ou semelhantes) proibirem sub-agentes ou delegação, elas valem: não use run_subagents sem um pedido explícito do usuário."
  );
}
// User guidelines from Settings, sent to every agent.
export function guidelinesText(guidelines = "") {
  return guidelines.trim()
    ? `\n\nDiretrizes do usuário para este workspace:\n${guidelines.trim()}`
    : "";
}
// Internal servers (codebit_images, codebit_agents) come from the task bridge.
// vars: the user's secrets, which ${NAME} in a server's env can refer to.
export function mcpFor(
  agent: AgentId,
  configs: McpConfig[],
  internal: Record<string, any>,
  vars: Record<string, string> = {},
) {
  const servers: Record<string, any> = {};
  for (const [name, server] of Object.entries(internal))
    servers[name] =
      // Codex stops MCP calls after 60 s by default; subagents take longer.
      agent === "codex"
        ? { ...server, tool_timeout_sec: 3600 }
        : // Claude Code defers MCP tools behind its tool search, showing the
          // model only their names; Codebit's own tools stay loaded.
          agent === "claude"
          ? { ...server, alwaysLoad: true }
          : server;
  for (const c of configs.filter(
    (c) => c.enabled && (c.agent === agent || c.agent === "both"),
  )) {
    const name = "codebit_" + c.name.replace(/[^\w-]/g, "_");
    if (
      [
        "codebit_images",
        "codebit_agents",
        "codebit_social",
        "codebit_tasks",
      ].includes(name)
    )
      throw new Error(
        "Os nomes images, agents, social e tasks são reservados.",
      );
    if (c.transport === "stdio")
      servers[name] = {
        command: c.command,
        args: c.args || [],
        env: Object.fromEntries(
          Object.entries(c.env || {}).map(([key, value]) => {
            const ref = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
            if (ref) {
              const found = vars[ref[1]] ?? process.env[ref[1]];
              if (!found)
                throw new Error(
                  `Variável de ambiente ausente para MCP ${c.name}: ${ref[1]}`,
                );
              return [key, found];
            }
            return [key, value];
          }),
        ),
      };
    // Devin CLI does not accept HTTP MCP servers over ACP.
    else if (agent !== "devin")
      servers[name] =
        agent === "codex" ? { url: c.url } : { type: "http", url: c.url };
  }
  return servers;
}
