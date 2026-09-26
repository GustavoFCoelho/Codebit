import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CircleAlert,
  Folder,
  LoaderCircle,
  MessageSquarePlus,
  Pencil,
  Plus,
  Square,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import type { Project, QuickRun, SavedPrompt, Task } from "../shared/types";
import { agentNames } from "../shared/types";
import { api } from "./api";
import { RequestCard } from "./parts";
// Saved prompts: quick requests in the sidebar, run apart from the chats.
const modeNames: Record<Task["mode"], string> = {
  plan: "Só leitura",
  execute: "Executar",
  bypass: "Bypass",
};
const runStatus: Record<QuickRun["status"], string> = {
  running: "Trabalhando",
  waiting: "Aguardando você",
  done: "Concluído",
  failed: "Falhou",
  interrupted: "Interrompido",
};
// Global prompts and those of the open task's project.
export function PromptList({
  prompts,
  projectId,
  onRun,
  onEdit,
  onNew,
}: {
  prompts: SavedPrompt[];
  projectId: string;
  onRun: (prompt: SavedPrompt) => void;
  onEdit: (prompt: SavedPrompt) => void;
  onNew: () => void;
}) {
  const visible = prompts.filter(
    (p) => !p.projectId || p.projectId === projectId,
  );
  return (
    <>
      <div className="section-label">
        <span>PROMPTS</span>
        <button
          className="icon"
          title="Novo prompt salvo"
          aria-label="Novo prompt salvo"
          onClick={onNew}
        >
          <Plus size={15} />
        </button>
      </div>
      <div className="project prompts">
        {visible.map((p) => (
          <div className="prompt-item" key={p.id}>
            <button
              className="task-item"
              title={p.text}
              aria-label={`Executar ${p.name}`}
              onClick={() => onRun(p)}
            >
              <Zap size={15} />
              <span>{p.name}</span>
              {p.projectId && <Folder size={12} className="prompt-scope" />}
            </button>
            <button
              className="icon on-hover"
              title="Editar prompt"
              aria-label={`Editar ${p.name}`}
              onClick={() => onEdit(p)}
            >
              <Pencil size={13} />
            </button>
          </div>
        ))}
        {!visible.length && (
          <p className="sidebar-hint">
            Salve pedidos rápidos para rodar sem sair da conversa.
          </p>
        )}
      </div>
    </>
  );
}
export function PromptModal({
  prompt,
  projects,
  onClose,
  run,
}: {
  prompt?: SavedPrompt;
  projects: Project[];
  onClose: () => void;
  run: any;
}) {
  const [name, setName] = useState(prompt?.name ?? "");
  const [text, setText] = useState(prompt?.text ?? "");
  const [projectId, setProjectId] = useState(prompt?.projectId ?? "");
  const [mode, setMode] = useState<Task["mode"]>(prompt?.mode ?? "plan");
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="modal wide"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("prompt.save", {
              id: prompt?.id,
              name,
              text,
              projectId,
              mode,
            });
            onClose();
          });
        }}
      >
        <div className="modal-header">
          <h2>{prompt ? "Editar prompt" : "Novo prompt salvo"}</h2>
          <button type="button" className="icon" onClick={onClose}>
            <X size={19} />
          </button>
        </div>
        <label>
          Nome
          <input
            autoFocus
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Revisar alterações"
          />
        </label>
        <label>
          Pedido
          <textarea
            className="prompt-text"
            required
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="O que o agente deve fazer ao rodar este prompt?"
          />
        </label>
        <label>
          Disponível em
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">Todos os projetos e conversas</option>
            {projects.map((p) => (
              <option value={p.id} key={p.id}>
                Só no projeto {p.name}
              </option>
            ))}
          </select>
        </label>
        {/* A label would name the first button after the whole group. */}
        <div className="field" role="group" aria-label="Permissão">
          Permissão
          <div className="mode-toggle prompt-mode">
            {(["plan", "execute", "bypass"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`${m === "bypass" ? "bypass" : ""} ${mode === m ? "selected" : ""}`}
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
              >
                {modeNames[m]}
              </button>
            ))}
          </div>
        </div>
        <p className="help">
          Roda numa sessão à parte, com o agente e o modelo da tarefa aberta,
          sem entrar na conversa nem esperar a fila dela.{" "}
          {mode === "plan"
            ? "Só leitura: o agente analisa e responde, sem alterar arquivos."
            : mode === "execute"
              ? "Executar: pode alterar arquivos, pedindo aprovação."
              : "Bypass: altera arquivos e roda comandos sem pedir permissão."}
        </p>
        <div className="modal-actions">
          {prompt && (
            <button
              type="button"
              className={`quiet ${confirmDelete ? "danger" : ""}`}
              onClick={() =>
                confirmDelete
                  ? void run(async () => {
                      await api("prompt.delete", { id: prompt.id });
                      onClose();
                    })
                  : setConfirmDelete(true)
              }
            >
              <Trash2 size={14} />
              {confirmDelete ? "Confirmar exclusão" : "Excluir"}
            </button>
          )}
          <button type="button" className="quiet" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary" type="submit">
            Salvar
          </button>
        </div>
      </form>
    </div>
  );
}
// Temporary panel with the saved prompts run in this session of Codebit.
export const QuickPanel = memo(function QuickPanel({
  selected,
  onSelect,
  onClose,
  onOpenTask,
  run,
}: {
  selected?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  onOpenTask: (id: string) => void;
  run: any;
}) {
  const [runs, setRuns] = useState<QuickRun[]>([]);
  useEffect(() => {
    void api<QuickRun[]>("quick.list").then(setRuns);
    return window.codebit.onEvent((e) => {
      if (e.type === "quick")
        setRuns((all) =>
          all.some((r) => r.id === e.run.id)
            ? all.map((r) => (r.id === e.run.id ? e.run : r))
            : [e.run, ...all],
        );
      if (e.type === "quick-removed")
        setRuns((all) => all.filter((r) => r.id !== e.id));
    });
  }, []);
  const current = runs.find((r) => r.id === selected) ?? runs[0];
  if (!current) return null;
  const active = current.status === "running" || current.status === "waiting";
  return (
    <aside className="quick-panel" aria-label="Prompt rápido">
      <header>
        <div>
          <strong>{current.name}</strong>
          <span>
            {agentNames[current.agent]}
            {current.model ? ` · ${current.model}` : ""} ·{" "}
            {modeNames[current.mode]} · {runStatus[current.status]}
          </span>
        </div>
        <button
          className="icon"
          title="Fechar painel"
          aria-label="Fechar painel"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      {runs.length > 1 && (
        <div className="quick-runs">
          {runs.map((r) => (
            <button
              key={r.id}
              className={r.id === current.id ? "selected" : ""}
              onClick={() => onSelect(r.id)}
            >
              {(r.status === "running" || r.status === "waiting") && (
                <span
                  className={`status-dot ${r.status === "waiting" ? "amber" : ""}`}
                />
              )}
              {r.name}
            </button>
          ))}
        </div>
      )}
      <div className="quick-body">
        {current.activity.length > 0 && (
          <details className="quick-activity">
            <summary>
              {current.activity.length === 1
                ? "1 ação"
                : `${current.activity.length} ações`}
            </summary>
            {current.activity.map((a, i) => (
              <div key={i}>{a}</div>
            ))}
          </details>
        )}
        {current.reply && (
          <div className="markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => (
                  <a
                    href="#"
                    onClick={(ev) => {
                      ev.preventDefault();
                      if (href)
                        void run(() => api("external.open", { url: href }));
                    }}
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {current.reply}
            </ReactMarkdown>
          </div>
        )}
        {current.status === "running" && (
          <div className="working">
            <LoaderCircle size={15} className="spin" />O agente está
            trabalhando…
          </div>
        )}
        {current.request && (
          <RequestCard
            entry={{
              id: current.id,
              taskId: "",
              kind: "request",
              text: current.request.title,
              createdAt: current.startedAt,
              request: current.request,
            }}
            taskId=""
            run={run}
            onRespond={(value) =>
              api("quick.respond", { id: current.id, value })
            }
          />
        )}
        {current.error && (
          <div className="error-card">
            <CircleAlert size={18} />
            <div>
              <strong>O prompt não terminou</strong>
              <p>{current.error}</p>
            </div>
          </div>
        )}
      </div>
      <footer>
        {active ? (
          <button
            className="quiet"
            onClick={() =>
              void run(() => api("quick.stop", { id: current.id }))
            }
          >
            <Square size={13} />
            Interromper
          </button>
        ) : (
          <>
            <button
              className="quiet"
              title="Cria uma conversa com o pedido e a resposta, que retoma a mesma sessão do agente"
              onClick={() =>
                void run(async () => {
                  const task = await api<Task>("quick.keep", {
                    id: current.id,
                  });
                  onOpenTask(task.id);
                })
              }
            >
              <MessageSquarePlus size={14} />
              Levar para uma conversa
            </button>
            <button
              className="quiet"
              onClick={() =>
                void run(() => api("quick.dismiss", { id: current.id }))
              }
            >
              Descartar
            </button>
          </>
        )}
      </footer>
    </aside>
  );
});
