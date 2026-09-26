import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse } from "smol-toml";
import type { AgentId, McpConfig, SkillInfo } from "../shared/types";
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
export function codebitInstructions(mcp: Record<string, any>, guidelines = "") {
  return (
    "Você está no Codebit. Responda em português do Brasil. Use o MCP codebit_images para gerar ou editar imagens; ele utiliza o provedor e modelo escolhidos na tarefa." +
    (mcp.codebit_agents
      ? " Para dividir trabalho, use run_subagents do MCP codebit_agents: cada item roda em um sub-agente separado, na mesma pasta. Dê a cada um uma parte independente e evite que editem os mesmos arquivos."
      : "") +
    guidelinesText(guidelines)
  );
}
// User guidelines from Settings, sent to every agent.
export function guidelinesText(guidelines = "") {
  return guidelines.trim()
    ? `\n\nDiretrizes do usuário para este workspace:\n${guidelines.trim()}`
    : "";
}
// Internal servers (codebit_images, codebit_agents) come from the task bridge.
export function mcpFor(
  agent: AgentId,
  configs: McpConfig[],
  internal: Record<string, any>,
) {
  const servers: Record<string, any> = {};
  for (const [name, server] of Object.entries(internal))
    // Codex stops MCP calls after 60 s by default; subagents take longer.
    servers[name] =
      agent === "codex" ? { ...server, tool_timeout_sec: 3600 } : server;
  for (const c of configs.filter(
    (c) => c.enabled && (c.agent === agent || c.agent === "both"),
  )) {
    const name = "codebit_" + c.name.replace(/[^\w-]/g, "_");
    if (["codebit_images", "codebit_agents"].includes(name))
      throw new Error("Os nomes images e agents são reservados.");
    if (c.transport === "stdio")
      servers[name] = {
        command: c.command,
        args: c.args || [],
        env: Object.fromEntries(
          Object.entries(c.env || {}).map(([key, value]) => {
            const ref = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
            if (ref) {
              if (!process.env[ref[1]])
                throw new Error(
                  `Variável de ambiente ausente para MCP ${c.name}: ${ref[1]}`,
                );
              return [key, process.env[ref[1]]];
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
