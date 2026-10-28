import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  FilePen,
  FileText,
  Globe,
  ListChecks,
  Plug,
  Search,
  Share2,
  Terminal as TerminalIcon,
  Users,
  Wrench,
  X,
  TriangleAlert,
  Folder,
  File,
} from "lucide-react";
import type {
  AgentId,
  AgentInfo,
  BlastPreview,
  Entry,
  Model,
  SubagentOptions,
  Task,
} from "../shared/types";
import {
  agentIds,
  agentNames,
  formatBytes,
  socialNetworkNames,
} from "../shared/types";
import { effortLabel } from "../shared/models";
import { api, fileUrl } from "./api";
// Pieces shared by the chat, the multitask board and the settings.
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
// A sidebar section heading that collapses its list.
export function SectionLabel({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="section-label">
      <button
        className="section-toggle"
        aria-expanded={open}
        title={open ? "Recolher" : "Expandir"}
        onClick={onToggle}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label}
      </button>
      {children}
    </div>
  );
}
// On/off setting: a checkbox drawn as a switch.
export function Switch({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}
// Each agent keeps the colors and mark of its card in the settings.
export function AgentMark({
  agent,
  size = "sm",
}: {
  agent: AgentId;
  size?: "sm" | "md";
}) {
  return (
    <span className={`agent-mark ${agent} ${size}`} aria-hidden>
      {agent === "codex" ? (
        <Code2 size={size === "sm" ? 11 : 17} />
      ) : (
        agentNames[agent][0]
      )}
    </span>
  );
}
// The kind of tool behind an activity row, read from the text agents write.
const activityKinds: [RegExp, typeof Wrench, string][] = [
  [/^(Sub-agente|Task|Agent)(?= |$)/, Users, "Sub-agente"],
  [
    /^(Terminal|Bash|BashOutput|KillShell|PowerShell|Comando)(?= |$)/,
    TerminalIcon,
    "Comando",
  ],
  [
    /^(Edit|MultiEdit|Write|NotebookEdit|Alterar arquivos)(?= |$)/,
    FilePen,
    "Edição",
  ],
  [/^(Read|LS|NotebookRead)(?= |$)/, FileText, "Leitura"],
  [/^(Grep|Glob|WebSearch|ToolSearch)(?= |$)/, Search, "Busca"],
  [/^WebFetch(?= |$)/, Globe, "Web"],
  [/^(MCP|mcp__)/, Plug, "MCP"],
];
// A failed call shows an X; a confirmed one, its kind in green.
export function ActivityIcon({ text, ok }: { text: string; ok?: boolean }) {
  const [, Icon, kind] = activityKinds.find(([re]) => re.test(text)) ?? [
    null,
    Wrench,
    "Ferramenta",
  ];
  return (
    <span
      className={`activity-icon ${ok === false ? "failed" : ok ? "ok" : ""}`}
      title={
        ok === false ? `${kind} · falhou` : ok ? `${kind} · concluído` : kind
      }
    >
      {ok === false ? <X size={11} /> : <Icon size={11} />}
    </span>
  );
}
// Sub-agent options: per chat, or the default in the settings.
export function SubagentOptionsForm({
  value,
  onChange,
  agents,
  defaultModels,
  disabled,
}: {
  value: SubagentOptions;
  onChange: (patch: Partial<SubagentOptions>) => void;
  agents: AgentInfo[];
  defaultModels?: Record<AgentId, string>;
  disabled?: boolean;
}) {
  const models = agents.find((a) => a.id === value.agent)?.models ?? [];
  const model = models.find((m) => m.id === value.model);
  return (
    <>
      <Switch
        checked={value.enabled}
        disabled={disabled}
        onChange={(enabled) => onChange({ enabled })}
      >
        Permitir que o agente delegue a sub-agentes
      </Switch>
      <div className="subagent-fields">
        <label>
          CLI
          <select
            aria-label="CLI dos sub-agentes"
            value={value.agent}
            disabled={disabled}
            onChange={(e) => {
              const agent = e.target.value as AgentId;
              onChange({
                agent,
                model: defaultModels?.[agent] ?? "",
                effort: "",
              });
            }}
          >
            {agentIds.map((id) => (
              <option
                key={id}
                value={id}
                disabled={!agents.find((a) => a.id === id)?.selected}
              >
                {agentNames[id]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Modelo
          <select
            aria-label="Modelo dos sub-agentes"
            value={value.model}
            disabled={disabled}
            onChange={(e) => onChange({ model: e.target.value, effort: "" })}
          >
            <option value="">Padrão do CLI</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            {value.model && !model && (
              <option value={value.model}>{value.model} · manual</option>
            )}
          </select>
        </label>
        {!!model?.efforts?.length && (
          <label>
            Esforço
            <select
              aria-label="Esforço dos sub-agentes"
              value={value.effort}
              disabled={disabled}
              onChange={(e) => onChange({ effort: e.target.value })}
            >
              <option value="">Padrão do modelo</option>
              {model.efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effortLabel(effort)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Simultâneos
          <input
            aria-label="Quantidade de sub-agentes"
            type="number"
            min={1}
            max={8}
            value={value.max}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                max: Math.min(8, Math.max(1, Math.round(+e.target.value || 1))),
              })
            }
          />
        </label>
      </div>
    </>
  );
}
// What a destructive command reaches, shown before it runs.
function BlastView({ blast }: { blast: BlastPreview }) {
  return (
    <div className="blast" role="group" aria-label="Alcance do comando">
      <div className="blast-summary">
        <TriangleAlert size={15} aria-hidden />
        <strong>{blast.summary}</strong>
      </div>
      {!!blast.existing?.files && (
        <p className="blast-warning">
          {blast.existing.files === 1
            ? "1 arquivo já existia"
            : `${blast.existing.files.toLocaleString("pt-BR")} arquivos já existiam`}{" "}
          antes desta conversa ({formatBytes(blast.existing.bytes)}).
        </p>
      )}
      {blast.reachesExisting && (
        <p className="blast-warning">
          O que só se sabe na hora pode alcançar arquivos que já existiam antes
          desta conversa.
        </p>
      )}
      {blast.files > (blast.temporary?.files ?? 0) &&
        !blast.existing?.files &&
        !blast.reachesExisting && (
          <p className="help">
            {blast.temporary?.files ? "Fora temporários e caches, tudo" : "Tudo"}{" "}
            o que ele apaga foi criado durante esta conversa.
          </p>
        )}
      {blast.outside && (
        <p className="blast-warning">Inclui itens fora da pasta da tarefa.</p>
      )}
      {blast.unknown && (
        <p className="blast-warning">
          Não dá para medir tudo: {blast.unknown}.
        </p>
      )}
      {!!blast.temporary?.files && (
        <p className="help">
          Inclui {blast.temporary.files.toLocaleString("pt-BR")} arquivos
          temporários ou de cache ({formatBytes(blast.temporary.bytes)}), que
          saem sem confirmação.
        </p>
      )}
      {blast.filtered && (
        <p className="help">
          Os filtros do comando decidem o que sai; os números são o máximo.
        </p>
      )}
      {blast.partial && (
        <p className="help">
          A contagem parou antes do fim, porque a pasta é muito grande.
        </p>
      )}
      {blast.entries.length > 0 && (
        <ul className="blast-entries">
          {blast.entries.map((e) => (
            <li key={e.path}>
              {e.dir ? (
                <Folder size={13} aria-label="Pasta" />
              ) : (
                <File size={13} aria-label="Arquivo" />
              )}
              <span className="blast-path">{e.path}</span>
              <span className="blast-size">{formatBytes(e.bytes)}</span>
            </li>
          ))}
          {blast.more > 0 && (
            <li className="blast-more">e mais {blast.more}</li>
          )}
        </ul>
      )}
      {!!blast.git?.length && (
        <>
          <p className="help">Alterações não salvas que se perdem:</p>
          <ul className="blast-entries">
            {blast.git.map((path) => (
              <li key={path}>
                <File size={13} aria-hidden />
                <span className="blast-path">{path}</span>
              </li>
            ))}
            {!!blast.gitMore && (
              <li className="blast-more">e mais {blast.gitMore}</li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}
export function RequestCard({
  entry,
  taskId,
  run,
  onRespond,
  onShowPlan,
}: {
  entry: Entry;
  taskId: string;
  run: any;
  // Answers somewhere else than the task chat (a saved prompt's run).
  onRespond?: (value: any) => Promise<unknown>;
  // Opens the plan in the side panel, for plan approvals.
  onShowPlan?: () => void;
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
    <div className={`request-card ${entry.resolved ? "resolved" : "pending"}`}>
      <div className="request-heading">
        {r.plan ? (
          <ListChecks size={19} />
        ) : r.social ? (
          <Share2 size={18} />
        ) : (
          <TerminalIcon size={19} />
        )}
        <strong>{r.title}</strong>
        {entry.resolved && <span className="badge">Resolvida</span>}
      </div>
      {r.blast && <BlastView blast={r.blast} />}
      {r.detail && <pre>{r.detail}</pre>}
      {r.social && (
        <div className="social-preview">
          <div className="social-meta">
            <strong>{socialNetworkNames[r.social.network]}</strong>
            <span>{r.social.account}</span>
            {r.social.kind && <span className="badge">{r.social.kind}</span>}
            {r.social.audience && (
              <span className="badge">Quem vê: {r.social.audience}</span>
            )}
          </div>
          {r.social.images.length > 0 && (
            <div className="social-images">
              {r.social.images.map((path) => (
                <img key={path} src={fileUrl(taskId, path)} alt="" />
              ))}
            </div>
          )}
          {r.social.title && (
            <strong className="social-title">{r.social.title}</strong>
          )}
          {r.social.text && <p className="social-text">{r.social.text}</p>}
          {!entry.resolved && (
            <p className="help">
              É exatamente isto que vai ser publicado. Publicar é público e pode
              não ter volta.
            </p>
          )}
        </div>
      )}
      {r.plan && (
        <p className="request-plan">
          O plano completo está na aba <strong>Plano</strong> do painel lateral,
          formatado.
          {onShowPlan && (
            <button className="text-button" onClick={onShowPlan}>
              Ver plano
            </button>
          )}
        </p>
      )}
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
                {r.plan
                  ? "Continuar planejando"
                  : r.social
                    ? "Não publicar"
                    : r.blast
                      ? "Cancelar"
                      : "Recusar"}
              </button>
              <button
                className="primary"
                disabled={sending}
                onClick={() => void run(() => respond({ decision: "accept" }))}
              >
                {r.plan
                  ? "Aprovar e executar"
                  : r.social
                    ? "Publicar"
                    : "Permitir"}
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
