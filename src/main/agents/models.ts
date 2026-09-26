import type { AgentId, Model } from "../../shared/types";

// Capabilities come from the selected CLI and account, never a static model list.
export function nativeModels(agent: AgentId, rows: any[]): Model[] {
  return rows.flatMap((m) => {
    const id = agent === "codex" ? m.model : m.value || m.id;
    if (typeof id !== "string" || !id) return [];
    const efforts =
      agent === "codex"
        ? m.supportedReasoningEfforts?.map((e: any) => e.reasoningEffort)
        : m.supportsEffort === false
          ? []
          : m.supportedEffortLevels;
    return [
      {
        id,
        name: m.displayName || m.display_name || m.name || id,
        verified: true,
        efforts: [
          ...new Set<string>(
            (efforts || []).filter(
              (e: unknown) => typeof e === "string" && e.length > 0,
            ),
          ),
        ],
        defaultEffort: agent === "codex" ? m.defaultReasoningEffort : undefined,
        description: m.description,
        resolvedModel: m.resolvedModel,
        contextWindow:
          typeof m.contextWindow === "number" ? m.contextWindow : undefined,
      },
    ];
  });
}
