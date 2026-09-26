import { useState } from "react";
import { Terminal as TerminalIcon } from "lucide-react";
import type { Entry, Model, Task } from "../shared/types";
import { api } from "./api";
// Pieces shared by the chat and the multitask board.
export const statusNames: Record<string, string> = {
  idle: "Pronto",
  queued: "Na fila",
  running: "Trabalhando",
  waiting: "Aguardando você",
  interrupted: "Interrompido",
  failed: "Falha na execução",
};
export const statusName = (t: Task) =>
  t.status === "idle" && t.background
    ? "Em segundo plano"
    : statusNames[t.status];
export const formatTokens = (n: number) =>
  n >= 1_000_000
    ? `${+(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${+(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
      : String(n);
// Context the model still has available, from the latest turn's usage.
export function ContextMeter({ task, model }: { task: Task; model?: Model }) {
  const size = task.context?.size ?? model?.contextWindow;
  const used = task.context?.used;
  if (!size)
    return (
      <span
        className="context-meter"
        title="O agente informa o tamanho do contexto na primeira resposta."
      >
        Contexto: {used ? `${formatTokens(used)} usados` : "após a resposta"}
      </span>
    );
  const percent = Math.min(100, ((used ?? 0) / size) * 100);
  return (
    <span
      className={`context-meter ${percent >= 85 ? "high" : percent >= 60 ? "mid" : ""}`}
      title={
        used === undefined
          ? `Janela de contexto do modelo: ${size.toLocaleString("pt-BR")} tokens.`
          : `${used.toLocaleString("pt-BR")} de ${size.toLocaleString("pt-BR")} tokens usados na última resposta (${percent.toFixed(1)}%).`
      }
    >
      <span className="meter">
        <span style={{ width: `${percent}%` }} />
      </span>
      Contexto:{" "}
      {used === undefined
        ? formatTokens(size)
        : `${formatTokens(Math.max(0, size - used))} livres de ${formatTokens(size)}`}
    </span>
  );
}
export function RequestCard({
  entry,
  taskId,
  run,
  onRespond,
}: {
  entry: Entry;
  taskId: string;
  run: any;
  // Answers somewhere else than the task chat (a saved prompt's run).
  onRespond?: (value: any) => Promise<unknown>;
}) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [sending, setSending] = useState(false);
  const r = entry.request!;
  async function respond(value: any) {
    setSending(true);
    try {
      await (onRespond
        ? onRespond(value)
        : api("task.respond", { id: taskId, entryId: entry.id, value }));
    } finally {
      setSending(false);
    }
  }
  return (
    <div className={`request-card ${entry.resolved ? "resolved" : ""}`}>
      <div className="request-heading">
        <TerminalIcon size={19} />
        <strong>{r.title}</strong>
        {entry.resolved && <span className="badge">Resolvida</span>}
      </div>
      {r.detail && <pre>{r.detail}</pre>}
      {r.kind === "question" &&
        r.questions?.map((q) => (
          <label key={q.id}>
            {q.question}
            {q.options && (
              <div className="question-options">
                {q.options.map((o) => (
                  <button
                    key={o}
                    className={`quiet ${answers[q.id] === o || (Array.isArray(answers[q.id]) && answers[q.id].includes(o)) ? "chosen" : ""}`}
                    disabled={entry.resolved}
                    onClick={() => {
                      const prior = answers[q.id];
                      const selected = Array.isArray(prior) ? prior : [];
                      setAnswers({
                        ...answers,
                        [q.id]: q.multiSelect
                          ? selected.includes(o)
                            ? selected.filter((v) => v !== o)
                            : [...selected, o]
                          : o,
                      });
                    }}
                  >
                    {o}
                  </button>
                ))}
              </div>
            )}
            <input
              disabled={entry.resolved}
              value={
                Array.isArray(answers[q.id])
                  ? (answers[q.id] as string[]).join(", ")
                  : answers[q.id] || ""
              }
              onChange={(e) =>
                setAnswers({ ...answers, [q.id]: e.target.value })
              }
              placeholder="Sua resposta"
            />
          </label>
        ))}
      {!entry.resolved && (
        <div className="request-actions">
          {r.kind === "approval" ? (
            <>
              <button
                className="quiet"
                disabled={sending}
                onClick={() => void run(() => respond({ decision: "decline" }))}
              >
                Recusar
              </button>
              <button
                className="primary"
                disabled={sending}
                onClick={() => void run(() => respond({ decision: "accept" }))}
              >
                Permitir
              </button>
            </>
          ) : (
            <button
              className="primary"
              disabled={
                sending ||
                r.questions?.some((q) => {
                  const value = answers[q.id];
                  return Array.isArray(value) ? !value.length : !value?.trim();
                })
              }
              onClick={() => void run(() => respond({ answers }))}
            >
              Enviar resposta
            </button>
          )}
        </div>
      )}
    </div>
  );
}
