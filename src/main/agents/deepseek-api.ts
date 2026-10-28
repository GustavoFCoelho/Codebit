import type { Model } from "../../shared/types";

// Only the official origin receives this credential. Never echo an API error
// body: a proxy or provider may include request headers in its diagnostics.
export async function deepseekModels(
  key: string | undefined,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<Model[]> {
  if (!key?.trim())
    throw new Error("Cadastre DEEPSEEK_API_KEY em Configurações → Secrets.");
  const response = await request("https://api.deepseek.com/models", {
    headers: { Authorization: `Bearer ${key.trim()}` },
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  }).catch((error) => {
    if (signal?.aborted) throw error;
    throw new Error(
      "Não foi possível consultar os modelos do DeepSeek. Verifique a conexão.",
    );
  });
  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? "Chave DeepSeek inválida ou sem acesso."
        : response.status === 429
          ? "Limite de consultas do DeepSeek atingido. Tente novamente mais tarde."
          : "O catálogo do DeepSeek está indisponível.";
    throw new Error(`${hint} HTTP ${response.status}.`);
  }
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw new Error("O DeepSeek retornou um catálogo inválido.");
  }
  return parseDeepseekModels(body);
}

export function parseDeepseekModels(body: any): Model[] {
  if (!Array.isArray(body?.data))
    throw new Error("O DeepSeek retornou um catálogo inválido.");
  const models = new Map<string, Model>();
  for (const row of body.data) {
    if (typeof row?.id !== "string" || !row.id.trim()) continue;
    const efforts = [
      ...new Set<string>(
        (Array.isArray(row.effort?.supported_levels)
          ? row.effort.supported_levels
          : []
        ).filter((v: unknown) => typeof v === "string" && v.length > 0),
      ),
    ];
    models.set(row.id, {
      id: row.id,
      name: typeof row.name === "string" && row.name ? row.name : row.id,
      verified: true,
      efforts,
      defaultEffort: efforts.includes(row.effort?.default_level)
        ? row.effort.default_level
        : undefined,
      contextWindow:
        Number.isFinite(row.context_window) && row.context_window > 0
          ? row.context_window
          : undefined,
    });
  }
  if (!models.size)
    throw new Error(
      "O DeepSeek não retornou modelos disponíveis para esta chave.",
    );
  return [...models.values()];
}
