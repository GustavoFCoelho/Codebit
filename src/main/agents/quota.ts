import type { AgentQuota, Installation, QuotaWindow } from "../../shared/types";
import { Channel } from "./protocol";
import { capture } from "../process";
import { appVersion } from "../../shared/types";
const windowLabel = (mins?: number | null) =>
  mins === 300
    ? "Sessão (5 horas)"
    : mins === 10080
      ? "Semana"
      : mins === 1440
        ? "Dia"
        : mins
          ? `${Math.round(mins / 60)} horas`
          : "Limite";
// Codex App Server rate limit snapshot (primary and secondary windows).
export function codexWindows(snapshot: any): QuotaWindow[] {
  return [snapshot?.primary, snapshot?.secondary]
    .filter((w) => typeof w?.usedPercent === "number")
    .map((w) => ({
      label: windowLabel(w.windowDurationMins),
      usedPercent: w.usedPercent,
      resetsAt: w.resetsAt ?? undefined,
    }));
}
const claudeLabels: Record<string, string> = {
  five_hour: "Sessão (5 horas)",
  seven_day: "Semana · todos os modelos",
};
// rate_limit_info from Claude Code's rate_limit_event during a response.
export function claudeWindows(info: any): QuotaWindow[] {
  return Object.entries<any>(info?.unifiedWindows ?? {})
    .filter(
      ([key, w]) => claudeLabels[key] && typeof w?.utilization === "number",
    )
    .map(([key, w]) => ({
      label: claudeLabels[key],
      usedPercent: Math.round(w.utilization * 100),
      resetsAt: w.resetsAt ?? undefined,
    }));
}
const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
// "Sep 26, 10:59pm (America/Sao_Paulo)", in the machine's time zone.
function resetTime(text: string, now: Date) {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{1,2})(?::(\d{2}))?(am|pm)/.exec(
    text,
  );
  if (!m || !months.includes(m[1])) return undefined;
  const hour = (+m[3] % 12) + (m[5] === "pm" ? 12 : 0);
  const date = new Date(
    now.getFullYear(),
    months.indexOf(m[1]),
    +m[2],
    hour,
    +(m[4] || 0),
  );
  // A reset in early January seen in late December belongs to next year.
  if (date.getTime() < now.getTime() - 86_400_000)
    date.setFullYear(date.getFullYear() + 1);
  return Math.round(date.getTime() / 1000);
}
// Text of Claude Code's local /usage command, which does not call the model.
export function parseClaudeUsage(text: string, now = new Date()) {
  return [
    ...text.matchAll(
      /^Current (session|week)(?: \(([^)]+)\))?: (\d+(?:\.\d+)?)% used(?: · resets (.+))?$/gm,
    ),
  ].map(([, span, scope, used, resets]): QuotaWindow => ({
    label:
      span === "session"
        ? "Sessão (5 horas)"
        : `Semana · ${scope === "all models" || !scope ? "todos os modelos" : scope}`,
    usedPercent: +used,
    resetsAt: resets ? resetTime(resets, now) : undefined,
  }));
}
async function codexQuota(installation: Installation, cwd: string) {
  const channel = new Channel(
    installation,
    ["app-server", "--listen", "stdio://"],
    cwd,
    "codex",
    () => {},
    () => {},
  );
  try {
    await channel.request("initialize", {
      clientInfo: { name: "codebit", title: "Codebit", version: appVersion },
      capabilities: { experimentalApi: true },
    });
    channel.send({ method: "initialized" });
    const r = await channel.request("account/rateLimits/read", {});
    const limits = r.rateLimits || {};
    const credits = limits.credits;
    return {
      plan: limits.planType
        ? limits.planType[0].toUpperCase() + limits.planType.slice(1)
        : undefined,
      windows: codexWindows(limits),
      note: credits?.unlimited
        ? "Créditos ilimitados."
        : credits?.hasCredits
          ? `Créditos disponíveis: ${credits.balance}.`
          : undefined,
    };
  } finally {
    channel.close();
  }
}
async function claudeQuota(installation: Installation, cwd: string) {
  let resolve!: (text: string) => void;
  const result = new Promise<string>((r) => (resolve = r));
  const channel = new Channel(
    installation,
    [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--strict-mcp-config",
    ],
    cwd,
    "claude",
    (msg) => msg.type === "result" && resolve(String(msg.result ?? "")),
    () => resolve(""),
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    const init = await channel.request("initialize", { hooks: {} });
    channel.send({
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: "/usage" }] },
    });
    const text = await Promise.race([
      result,
      new Promise<string>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("O Claude Code não informou o uso.")),
          30000,
        );
      }),
    ]);
    const windows = parseClaudeUsage(text);
    return {
      plan: init.account?.subscriptionType,
      windows,
      note: windows.length
        ? undefined
        : "O Claude Code não informou limites para esta conta.",
    };
  } finally {
    clearTimeout(timer);
    channel.close();
  }
}
async function devinQuota(installation: Installation, cwd: string) {
  const r = await capture(
    installation.command,
    [...installation.args, "auth", "status"],
    cwd,
    30000,
  );
  const field = (name: string) =>
    new RegExp(`^\\s*${name}:\\s*(.+)$`, "m").exec(r.stdout)?.[1].trim();
  return {
    plan: field("Tier") || field("Plan"),
    windows: [],
    note: "O Devin CLI não informa o saldo da conta. Use /usage no chat para ver o consumo da sessão.",
  };
}
export async function probeQuota(
  installation: Installation,
  cwd: string,
): Promise<AgentQuota> {
  const quota = await {
    codex: codexQuota,
    claude: claudeQuota,
    devin: devinQuota,
  }[installation.agent](installation, cwd);
  return { ...quota, checkedAt: new Date().toISOString() };
}
