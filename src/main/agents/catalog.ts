import type { AgentCommand, Installation, Model } from "../../shared/types";
import { Channel } from "./protocol";
import { nativeModels } from "./models";
import { capture } from "../process";
import { appVersion } from "../../shared/types";
// Short-lived CLI process used only to query catalogs, without a conversation.
async function probe<T>(
  installation: Installation,
  cwd: string,
  signal: AbortSignal | undefined,
  use: (channel: Channel, init: any) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const isCodex = installation.agent === "codex";
  const channel = new Channel(
    installation,
    isCodex
      ? ["app-server", "--listen", "stdio://"]
      : [
          "--print",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "--setting-sources",
          "user,project,local",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--strict-mcp-config",
        ],
    cwd,
    installation.agent === "codex" ? "codex" : "claude",
    () => {},
    () => {},
  );
  const cancel = () => channel.close();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const init = await channel.request(
      "initialize",
      isCodex
        ? {
            clientInfo: {
              name: "codebit",
              title: "Codebit",
              version: appVersion,
            },
            capabilities: { experimentalApi: true },
          }
        : { hooks: {} },
    );
    if (isCodex) channel.send({ method: "initialized" });
    return await use(channel, init);
  } finally {
    signal?.removeEventListener("abort", cancel);
    channel.close();
  }
}
async function devin(installation: Installation, cwd: string, args: string[]) {
  const r = await capture(
    installation.command,
    [...installation.args, ...args],
    cwd,
    30000,
  );
  if (r.code !== 0)
    throw new Error(r.stderr.trim() || "O Devin CLI não respondeu.");
  return r.stdout;
}
export async function probeModels(
  installation: Installation,
  cwd: string,
  signal?: AbortSignal,
): Promise<Model[]> {
  signal?.throwIfAborted();
  // Opening an ACP session would start MCP servers; the CLI lists models directly.
  if (installation.agent === "devin")
    return nativeModels(
      "devin",
      (
        JSON.parse(
          await devin(installation, cwd, [
            "models",
            "list",
            "--format",
            "json",
          ]),
        ).families || []
      ).flatMap((f: any) =>
        (f.variants || []).map((v: any) => ({
          value: v.model_uid,
          name: v.label,
          contextWindow: v.max_context_tokens,
          description: [v.description, v.cost_summary || v.cost_tier]
            .filter(Boolean)
            .join(" · "),
        })),
      ),
    );
  return probe(installation, cwd, signal, async (channel, init) => {
    if (installation.agent === "claude")
      return nativeModels("claude", init.models || []);
    let cursor: string | null = null;
    const all: Model[] = [];
    do {
      const r: any = await channel.request("model/list", {
        limit: 100,
        cursor,
        includeHidden: false,
      });
      all.push(...nativeModels("codex", r.data || []));
      cursor = r.nextCursor;
    } while (cursor);
    return all;
  });
}
export async function codexSkills(
  channel: Channel,
  cwd: string,
): Promise<AgentCommand[]> {
  const r = await channel.request("skills/list", { cwds: [cwd] });
  return (r.data || [])
    .flatMap((entry: any) => entry.skills || [])
    .filter((s: any) => s.enabled !== false)
    .map((s: any) => ({
      name: s.name,
      description:
        s.interface?.shortDescription || s.shortDescription || s.description,
      kind: "skill",
      path: s.path,
    }));
}
// Commands and skills the CLI accepts for a folder, including project ones.
export async function probeCommands(
  installation: Installation,
  cwd: string,
): Promise<AgentCommand[]> {
  if (installation.agent === "devin") {
    // Lines look like "  /name [user] (path) - description"; skills without
    // the slash can only be triggered by the model.
    const text = await devin(installation, cwd, ["skills", "list"]);
    return [...text.matchAll(/^\s+\/(\S+) \[[^\]]*\] \([^)]*\) - (.*)$/gm)].map(
      ([, name, description]) => ({
        name,
        description: description.trim(),
        kind: "skill" as const,
      }),
    );
  }
  return probe(installation, cwd, undefined, (channel, init) =>
    installation.agent === "codex"
      ? codexSkills(channel, cwd)
      : Promise.resolve(claudeCommands(init.commands)),
  );
}
export function claudeCommands(rows: any[] = []): AgentCommand[] {
  return rows
    .filter((c) => typeof c?.name === "string")
    .map((c) => ({
      name: c.name,
      description: c.description || "",
      kind: "command" as const,
      hint: c.argumentHint || undefined,
    }));
}
