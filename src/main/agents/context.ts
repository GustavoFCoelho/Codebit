import { basename } from "node:path";
import type { ContextPart, ContextUsage } from "../../shared/types";
// What Claude Code's context is made of (get_context_usage), in the four
// groups Codebit shows: instructions, tools, skills and conversation.
const groups: Record<string, ContextPart["id"]> = {
  "System prompt": "instructions",
  "Memory files": "instructions",
  "System tools": "tools",
  "MCP tools": "tools",
  "Custom agents": "tools",
  Skills: "skills",
  Messages: "conversation",
  "Autocompact buffer": "reserve",
};
const memoryKinds: Record<string, string> = {
  Project: "projeto",
  User: "usuário",
  Local: "local",
  AutoMem: "memória automática",
  Managed: "gerenciado",
};
type Item = { label: string; tokens: number };
// The heaviest pieces of a part. Claude Code's lists do not always add up to
// the part (some memory files go unlisted), so what is left is "Outros" and
// the pieces always sum to the part.
function pieces(total: number, list: Item[], others: string) {
  const items = list
    .filter((i) => i.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 6);
  let left = total;
  for (const item of items) {
    item.tokens = Math.min(item.tokens, left);
    left -= item.tokens;
  }
  if (left > Math.max(50, total * 0.01))
    items.push({ label: others, tokens: left });
  return items.filter((i) => i.tokens > 0);
}
export function claudeContext(r: any): ContextUsage | undefined {
  if (!r || !Array.isArray(r.categories) || !r.maxTokens) return;
  const parts = new Map<ContextPart["id"], ContextPart>();
  const add = (id: ContextPart["id"], tokens: number) => {
    const part = parts.get(id) ?? { id, tokens: 0, items: [] };
    part.tokens += tokens;
    parts.set(id, part);
    return part;
  };
  let deferred = 0;
  for (const c of r.categories) {
    const tokens = Number(c.tokens) || 0;
    if (c.kind === "deferred" || c.isDeferred) deferred += tokens;
    else if (c.kind === "used" || groups[c.name] === "reserve")
      add(groups[c.name] ?? "instructions", tokens);
  }
  const items = (id: ContextPart["id"], list: Item[], others = "Outros") => {
    const part = parts.get(id);
    if (part) part.items = pieces(part.tokens, list, others);
  };
  const prompt = r.categories.find((c: any) => c.name === "System prompt");
  items("instructions", [
    ...(prompt
      ? [
          {
            label: "Prompt de sistema e instruções do Codebit",
            tokens: prompt.tokens,
          },
        ]
      : []),
    ...(r.memoryFiles ?? []).map((m: any) => ({
      label: `${basename(String(m.path ?? ""))} (${memoryKinds[m.type] ?? m.type ?? "memória"})`,
      tokens: Number(m.tokens) || 0,
    })),
  ]);
  const servers = new Map<string, number>();
  for (const t of r.mcpTools ?? [])
    if (t.isLoaded !== false)
      servers.set(
        t.serverName,
        (servers.get(t.serverName) ?? 0) + (Number(t.tokens) || 0),
      );
  const system = r.categories.find((c: any) => c.name === "System tools");
  const agents = r.categories.find((c: any) => c.name === "Custom agents");
  items("tools", [
    ...(system
      ? [{ label: "Ferramentas do Claude Code", tokens: system.tokens }]
      : []),
    ...[...servers].map(([server, tokens]) => ({
      label: `MCP · ${server}`,
      tokens,
    })),
    ...(agents
      ? [{ label: "Agentes personalizados", tokens: agents.tokens }]
      : []),
  ]);
  items(
    "skills",
    (r.skills?.skillFrontmatter ?? []).map((s: any) => ({
      label: s.name,
      tokens: Number(s.tokens) || 0,
    })),
    "Outras skills",
  );
  const m = r.messageBreakdown ?? {};
  // The prompt snapshot among the attachments is the system prompt again.
  const snapshot =
    (m.attachmentsByType ?? []).find((a: any) => a.name === "prompt_snapshot")
      ?.tokens ?? 0;
  items("conversation", [
    {
      label: "Resultados de ferramentas (arquivos lidos, saídas de comandos)",
      tokens: m.toolResultTokens ?? 0,
    },
    { label: "Chamadas de ferramentas", tokens: m.toolCallTokens ?? 0 },
    { label: "Respostas do agente", tokens: m.assistantMessageTokens ?? 0 },
    { label: "Suas mensagens", tokens: m.userMessageTokens ?? 0 },
    {
      label: "Anexos e avisos do Claude Code",
      tokens: Math.max(0, (m.attachmentTokens ?? 0) - snapshot),
    },
  ]);
  const order: ContextPart["id"][] = [
    "instructions",
    "tools",
    "skills",
    "conversation",
    "reserve",
  ];
  return {
    used: Number(r.totalTokens) || 0,
    size: Number(r.maxTokens),
    parts: order.flatMap((id) => (parts.has(id) ? [parts.get(id)!] : [])),
    ...(deferred ? { deferred } : {}),
  };
}
