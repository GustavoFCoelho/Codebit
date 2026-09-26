import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { capture } from "./process";
import { agentIds } from "../shared/types";
import type {
  AgentId,
  AgentInfo,
  Installation,
  Settings,
} from "../shared/types";
const agentTitles: Record<AgentId, string> = {
  codex: "Codex CLI",
  claude: "Claude Code",
  devin: "Devin CLI",
};
// Runs `--version`; undefined when the CLI does not answer.
export async function readVersion(spec: { command: string; args: string[] }) {
  const r = await capture(spec.command, [...spec.args, "--version"]);
  if (r.code !== 0) return;
  return r.stdout.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] || "desconhecida";
}
export function executable(path: string): { command: string; args: string[] } {
  if (/\.exe$/i.test(path) || process.platform !== "win32")
    return { command: path, args: [] };
  if (/codex\.(cmd|ps1)$/i.test(path)) {
    const script = join(
      dirname(path),
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (existsSync(script))
      return {
        command: process.env.CODEBIT_NODE_PATH || "node.exe",
        args: [script],
      };
  }
  throw new Error(
    "Selecione o executável nativo .exe. Scripts npm do Codex também são suportados.",
  );
}
function candidates(agent: AgentId, override?: string) {
  const roots = (process.env.PATH || "")
    .split(process.platform === "win32" ? ";" : ":")
    .filter(Boolean);
  roots.push(
    join(homedir(), ".local", "bin"),
    join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "npm"),
    join(homedir(), ".cargo", "bin"),
  );
  if (agent === "codex") {
    const bundled = join(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "OpenAI",
      "Codex",
      "bin",
    );
    try {
      roots.push(...readdirSync(bundled).map((n) => join(bundled, n)));
    } catch {}
  }
  // Devin Desktop bundles the CLI inside its Windsurf extension.
  if (agent === "devin")
    roots.push(
      join(
        process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
        "Programs",
        "Devin",
        "resources",
        "app",
        "extensions",
        "windsurf",
        "devin",
        "bin",
      ),
    );
  const paths = [
    override,
    ...roots.flatMap((r) =>
      (process.platform === "win32" ? [".exe", ".cmd", ".ps1"] : [""]).map(
        (ext) => join(r, agent + ext),
      ),
    ),
  ];
  return [
    ...new Set(
      paths
        .filter((p): p is string => !!p && existsSync(p))
        .map((p) => resolve(p)),
    ),
  ];
}
export async function discover(settings: Settings): Promise<AgentInfo[]> {
  return Promise.all(
    agentIds.map(async (agent) => {
      const seen = new Set<string>();
      const installations: Installation[] = [];
      for (const path of candidates(agent, settings.cliPaths[agent])) {
        try {
          const spec = executable(path),
            key = JSON.stringify(spec).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          const version = await readVersion(spec);
          if (!version) continue;
          installations.push({ agent, path, ...spec, version });
        } catch {}
      }
      return {
        id: agent,
        name: agentTitles[agent],
        installations,
        selected:
          installations.find(
            (i) =>
              i.path.toLowerCase() === settings.cliPaths[agent]?.toLowerCase(),
          ) || installations[0],
        auth: "unknown",
        models: [],
      };
    }),
  );
}
export async function checkAuth(agent: AgentInfo): Promise<AgentInfo> {
  if (!agent.selected)
    return {
      ...agent,
      auth: "missing",
      authMessage:
        "CLI não encontrado. Selecione o executável nas configurações.",
    };
  const i = agent.selected;
  try {
    const r = await capture(
      i.command,
      [
        ...i.args,
        ...{
          codex: ["login", "status"],
          claude: ["auth", "status", "--json"],
          devin: ["auth", "status"],
        }[agent.id],
      ],
      process.cwd(),
      15000,
    );
    if (agent.id === "claude") {
      const data = JSON.parse(r.stdout);
      const ready = data.loggedIn === true;
      return {
        ...agent,
        auth: ready ? "ready" : "missing",
        authMessage: ready
          ? "Acesso configurado no CLI."
          : "Entre com claude auth login no terminal.",
      };
    }
    const output = r.stdout + r.stderr;
    const ready = r.code === 0 && /logged in/i.test(output);
    return {
      ...agent,
      auth: ready ? "ready" : "missing",
      authMessage: ready
        ? "Acesso configurado no CLI."
        : /home directory/i.test(output)
          ? "O CLI não localizou a pasta do usuário. Verifique USERPROFILE e CODEX_HOME."
          : agent.id === "devin"
            ? "Entre com devin auth login no terminal."
            : "Entre com codex login no terminal.",
    };
  } catch (e) {
    return { ...agent, auth: "error", authMessage: (e as Error).message };
  }
}
