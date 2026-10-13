import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ContextPart, Model, Task } from "../shared/types";
import { agentNames } from "../shared/types";
import { formatTokens } from "./parts";
// The context of the open task: how full it is, and (Claude Code) what it is
// made of, so a session that started heavy can be told from one that grew.
const partNames: Record<ContextPart["id"], string> = {
  instructions: "Instruções",
  tools: "Ferramentas",
  skills: "Skills",
  conversation: "Conversa",
  reserve: "Reserva de compactação",
};
const partHelp: Record<ContextPart["id"], string> = {
  instructions:
    "Prompt de sistema, diretrizes e instruções do Codebit e arquivos de memória (CLAUDE.md).",
  tools: "Definições das ferramentas que o agente pode chamar, inclusive MCP.",
  skills: "Descrições das skills disponíveis.",
  conversation:
    "Mensagens, respostas e o que as ferramentas devolveram nesta conversa.",
  reserve:
    "Espaço que o Claude Code guarda para resumir a conversa quando ela enche.",
};
// Shares under 10% keep a decimal: "2,7%", "11%".
const percent = (part: number, whole: number) =>
  whole
    ? `${((part / whole) * 100).toLocaleString("pt-BR", {
        maximumFractionDigits: part / whole < 0.1 ? 1 : 0,
      })}%`
    : "";
// The one hint that matters most right now, if any.
function hint(parts: ContextPart[], used: number, size: number) {
  const part = (id: ContextPart["id"]) =>
    parts.find((p) => p.id === id)?.tokens ?? 0;
  const results =
    parts
      .find((p) => p.id === "conversation")
      ?.items?.find((i) => i.label.startsWith("Resultados"))?.tokens ?? 0;
  if (used / size >= 0.7)
    return "Perto do limite: peça um resumo do que importa ou continue em outra conversa (Continuar com outro agente).";
  if (part("tools") / used >= 0.4)
    return "As ferramentas pesam bastante: se esta tarefa não usa alguma integração MCP, desligá-la deixa mais espaço.";
  if (
    part("conversation") / used >= 0.5 &&
    results / part("conversation") >= 0.5
  )
    return "A conversa cresceu com o que as ferramentas devolveram (arquivos lidos, saídas de comandos).";
  return "";
}
export function ContextMeter({
  task,
  model,
  details,
}: {
  task: Task;
  model?: Model;
  // In the status bar, a click opens what the context is made of.
  details?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !root.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const size = task.context?.size ?? model?.contextWindow;
  const used = task.context?.used;
  const share = size ? Math.min(100, ((used ?? 0) / size) * 100) : 0;
  const level = share >= 85 ? "high" : share >= 60 ? "mid" : "";
  const label = !size ? (
    <>Contexto: {used ? `${formatTokens(used)} usados` : "após a resposta"}</>
  ) : (
    <>
      <span className="meter">
        <span style={{ width: `${share}%` }} />
      </span>
      Contexto:{" "}
      {used === undefined
        ? formatTokens(size)
        : `${formatTokens(Math.max(0, size - used))} livres de ${formatTokens(size)}`}
    </>
  );
  const title = !size
    ? "O agente informa o tamanho do contexto na primeira resposta."
    : used === undefined
      ? `Janela de contexto do modelo: ${size.toLocaleString("pt-BR")} tokens.`
      : `${used.toLocaleString("pt-BR")} de ${size.toLocaleString("pt-BR")} tokens usados na última resposta (${share.toFixed(1)}%).`;
  if (!details)
    return (
      <span className={`context-meter ${level}`} title={title}>
        {label}
      </span>
    );
  return (
    <span className="quota" ref={root}>
      <button
        className={`context-meter ${level}`}
        title={`${title} Clique para ver do que ele é feito.`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open && <ContextDetails task={task} size={size} />}
    </span>
  );
}
function ContextDetails({ task, size }: { task: Task; size?: number }) {
  const [hovered, setHovered] = useState<ContextPart["id"]>();
  const context = task.context;
  const parts = context?.parts ?? [];
  const used = context?.used ?? 0;
  // The bar shows what is in use; the reserve and free space are told apart.
  const inUse = parts.filter((p) => p.id !== "reserve" && p.tokens > 0);
  const reserve = parts.find((p) => p.id === "reserve")?.tokens ?? 0;
  const tip = size && inUse.length ? hint(parts, used, size) : "";
  return (
    <div
      className="quota-popover context-popover"
      role="dialog"
      aria-label="Uso de contexto"
    >
      <div className="quota-head">
        <strong>Contexto</strong>
        {size && context && (
          <span className="context-total">
            {formatTokens(used)} de {formatTokens(size)} · {percent(used, size)}
          </span>
        )}
      </div>
      {!inUse.length ? (
        <p className="help">
          {task.agent === "claude"
            ? "O detalhamento aparece ao fim da próxima resposta do Claude Code."
            : `O ${agentNames[task.agent]} informa só o total usado; o detalhamento por categoria vem do Claude Code.`}
        </p>
      ) : (
        <>
          <div
            className="context-stack"
            role="img"
            aria-label="Composição do contexto em uso"
          >
            {inUse.map((p) => (
              <span
                key={p.id}
                className={`context-segment part-${p.id} ${hovered && hovered !== p.id ? "dim" : ""}`}
                style={{ flexGrow: p.tokens }}
                title={`${partNames[p.id]} · ${p.tokens.toLocaleString("pt-BR")} tokens (${percent(p.tokens, used)})`}
                onMouseEnter={() => setHovered(p.id)}
                onMouseLeave={() => setHovered(undefined)}
              />
            ))}
          </div>
          <div className="context-parts">
            {inUse.map((p) => (
              <details
                key={p.id}
                className={hovered === p.id ? "hovered" : ""}
                onMouseEnter={() => setHovered(p.id)}
                onMouseLeave={() => setHovered(undefined)}
              >
                <summary title={partHelp[p.id]}>
                  <ChevronRight size={12} className="chevron" />
                  <span className={`context-swatch part-${p.id}`} />
                  <span className="context-name">{partNames[p.id]}</span>
                  <span className="context-tokens">
                    {formatTokens(p.tokens)}
                  </span>
                  <span className="context-share">
                    {percent(p.tokens, used)}
                  </span>
                </summary>
                {p.items?.map((i) => (
                  <div className="context-item" key={i.label}>
                    <span>{i.label}</span>
                    <span className="context-tokens">
                      {formatTokens(i.tokens)}
                    </span>
                  </div>
                ))}
                {!p.items?.length && <p className="help">{partHelp[p.id]}</p>}
              </details>
            ))}
          </div>
          <p className="help">
            {reserve > 0 &&
              `Reserva de compactação: ${formatTokens(reserve)}. `}
            {size &&
              `Livre: ${formatTokens(Math.max(0, size - used - reserve))}. `}
            {!!context?.deferred &&
              `Ferramentas adiadas: ${formatTokens(context.deferred)}, fora do contexto até o agente buscá-las.`}
          </p>
          {tip && (
            <p className="context-tip" role="note">
              {tip}
            </p>
          )}
          <small>
            Lido do Claude Code ao fim da última resposta. A porcentagem de cada
            parte é sobre o que está em uso.
          </small>
        </>
      )}
    </div>
  );
}
