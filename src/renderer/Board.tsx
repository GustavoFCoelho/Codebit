import { memo, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUp,
  CircleAlert,
  LayoutGrid,
  ListOrdered,
  MessageSquare,
  Square,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentId, BoardCard, Model, Snapshot } from "../shared/types";
import { agentIds, agentNames } from "../shared/types";
import { api, artifactUrl } from "./api";
import {
  ActivityIcon,
  AgentMark,
  ContextMeter,
  RequestCard,
  statusName,
} from "./parts";
export const taskMime = "application/x-codebit-task";
const busy = ["running", "waiting", "queued"];
// Several tasks side by side; tasks in different folders run in parallel.
export function Board({
  cards,
  snapshot,
  run,
  onOpen,
}: {
  cards: BoardCard[];
  snapshot: Snapshot;
  run: any;
  onOpen: (taskId: string) => void;
}) {
  const [over, setOver] = useState(false);
  const running = cards.filter((c) => busy.includes(c.task.status)).length;
  const available = snapshot.tasks.filter(
    (t) => !t.boardAt && !t.archived && !t.workItemId,
  );
  const add = (id: string) => run(() => api("task.board", { id, on: true }));
  return (
    <div
      className={`board ${over ? "drag-over" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(taskMime)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(taskMime);
        if (id) void add(id);
      }}
    >
      <div className="board-head">
        <div>
          <h2>Modo Multitarefa</h2>
          <p>Seus agentes, trabalhando em paralelo.</p>
        </div>
        <span className={`board-chip ${running ? "active" : ""}`}>
          <span className="status-dot" />
          {running === 1
            ? "1 tarefa em execução"
            : `${running} tarefas em execução`}
        </span>
      </div>
      <div className="board-grid">
        {cards.map((card) => (
          <BoardCardView
            key={card.task.id}
            card={card}
            model={snapshot.agents
              .find((a) => a.id === card.task.agent)
              ?.models.find((m) => m.id === card.task.model)}
            run={run}
            onOpen={onOpen}
          />
        ))}
        <div className="board-drop" aria-label="Soltar tarefa">
          <LayoutGrid size={26} />
          <strong>Solte aqui para iniciar</strong>
          <small>
            Arraste tarefas da barra lateral para executá-las em paralelo.
          </small>
          <select
            aria-label="Adicionar tarefa ao quadro"
            value=""
            disabled={!available.length}
            onChange={(e) => void add(e.target.value)}
          >
            <option value="">
              {available.length
                ? "Ou escolha uma tarefa…"
                : "Todas as tarefas já estão no quadro"}
            </option>
            {available.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </div>
      </div>
      <BoardComposer snapshot={snapshot} run={run} />
    </div>
  );
}
const BoardCardView = memo(
  function BoardCardView({
    card,
    model,
    run,
    onOpen,
  }: {
    card: BoardCard;
    model?: Model;
    run: any;
    onOpen: (taskId: string) => void;
  }) {
    const { task, artifact } = card;
    const [text, setText] = useState("");
    const log = useRef<HTMLDivElement>(null);
    const active = busy.includes(task.status);
    const pending = card.entries.filter((e) => e.kind === "request");
    const recent = card.entries.filter((e) => e.kind !== "request");
    // New activity shows at the bottom of the card.
    useLayoutEffect(() => {
      log.current?.scrollTo({ top: log.current.scrollHeight });
    }, [card]);
    const send = () =>
      run(async () => {
        await api(active ? "task.enqueue" : "task.send", {
          id: task.id,
          text,
          attachments: [],
        });
        setText("");
      });
    return (
      <article
        className={`board-card status-${task.status}`}
        aria-label={task.title}
      >
        <header>
          <strong title={task.title}>{task.title}</strong>
          <span className={`badge agent-badge ${task.agent}`}>
            <AgentMark agent={task.agent} />
            {agentNames[task.agent]}
            {model ? ` · ${model.name}` : ""}
          </span>
          <span className="card-status">
            <span
              className={`status-dot ${task.status === "waiting" ? "amber" : task.status === "failed" ? "red" : busy.includes(task.status) ? "" : "muted-dot"}`}
            />
            {statusName(task)}
          </span>
          <span className="card-actions">
            <button
              className="icon"
              title="Abrir conversa"
              aria-label="Abrir conversa"
              onClick={() => onOpen(task.id)}
            >
              <MessageSquare size={14} />
            </button>
            {active && (
              <button
                className="icon"
                title="Interromper"
                aria-label="Interromper"
                onClick={() =>
                  void run(() => api("task.interrupt", { id: task.id }))
                }
              >
                <Square size={13} />
              </button>
            )}
            <button
              className="icon"
              title="Tirar do quadro"
              aria-label="Tirar do quadro"
              onClick={() =>
                void run(() => api("task.board", { id: task.id, on: false }))
              }
            >
              <X size={14} />
            </button>
          </span>
        </header>
        <div className="board-log" ref={log}>
          {!recent.length && !pending.length && (
            <p className="help">Envie uma mensagem para começar.</p>
          )}
          {recent.map((e) =>
            e.kind === "activity" ? (
              <div className="log-activity" key={e.id}>
                <ActivityIcon text={e.text} ok={e.ok} />
                <span>{e.text}</span>
              </div>
            ) : e.kind === "error" ? (
              <div className="log-error" key={e.id}>
                <CircleAlert size={12} />
                <span>{e.text}</span>
              </div>
            ) : e.kind === "image" ? (
              artifact && e.artifactId === artifact.id ? (
                <img
                  key={e.id}
                  className="log-image"
                  src={artifactUrl(artifact.id)}
                  alt={e.text}
                />
              ) : null
            ) : (
              <div className={`log-message ${e.kind}`} key={e.id}>
                <span className="log-author">
                  {e.kind === "user" ? (
                    "Você"
                  ) : (
                    <>
                      <AgentMark agent={e.agent ?? task.agent} />
                      {agentNames[e.agent ?? task.agent]}
                    </>
                  )}
                </span>
                {e.kind === "assistant" ? (
                  <div className="markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {e.text.slice(-1500) || "…"}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p>{e.text}</p>
                )}
              </div>
            ),
          )}
          {pending.map((e) => (
            <RequestCard key={e.id} entry={e} taskId={task.id} run={run} />
          ))}
        </div>
        <footer>
          <div className="card-meta">
            <ContextMeter task={task} model={model} />
            {!!task.queue?.length && (
              <span className="card-queue">
                <ListOrdered size={12} />
                Fila · {task.queue.length}
              </span>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) void send();
            }}
          >
            <input
              aria-label={`Mensagem para ${task.title}`}
              placeholder={active ? "Adicionar à fila…" : "Responder…"}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button
              className="send"
              type="submit"
              disabled={!text.trim()}
              title={active ? "Adicionar à fila" : "Enviar"}
              aria-label={active ? "Adicionar à fila" : "Enviar"}
            >
              <ArrowUp size={16} />
            </button>
          </form>
        </footer>
      </article>
    );
  },
  // Cards come fresh from each refresh; redraw only when their data changed.
  (a, b) =>
    a.run === b.run &&
    a.onOpen === b.onOpen &&
    a.model?.id === b.model?.id &&
    a.model?.contextWindow === b.model?.contextWindow &&
    JSON.stringify(a.card) === JSON.stringify(b.card),
);
// Starts a new task on the board with its first message.
function BoardComposer({ snapshot, run }: { snapshot: Snapshot; run: any }) {
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState("");
  const [agent, setAgent] = useState<AgentId>("codex");
  const [worktree, setWorktree] = useState(false);
  const [sending, setSending] = useState(false);
  const project = snapshot.projects.find((p) => p.id === projectId);
  const start = () =>
    run(async () => {
      setSending(true);
      try {
        await api("board.start", {
          projectId,
          agent,
          worktree: !!project?.git && worktree,
          text,
        });
        setText("");
      } finally {
        setSending(false);
      }
    });
  return (
    <div className="board-composer">
      <div className="composer">
        <textarea
          aria-label="Nova tarefa do quadro"
          placeholder="Descreva uma nova tarefa…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (text.trim() && !sending) void start();
            }
          }}
        />
        <div className="composer-buttons">
          <select
            aria-label="Projeto da nova tarefa"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">Sem projeto · conversa</option>
            {snapshot.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Agente da nova tarefa"
            value={agent}
            onChange={(e) => setAgent(e.target.value as AgentId)}
          >
            {agentIds.map((id) => (
              <option
                key={id}
                value={id}
                disabled={!snapshot.agents.find((a) => a.id === id)?.selected}
              >
                {agentNames[id]}
              </option>
            ))}
          </select>
          {project?.git && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={worktree}
                onChange={(e) => setWorktree(e.target.checked)}
              />
              Worktree isolada
            </label>
          )}
          <span className="composer-hint">
            {project && !(project.git && worktree)
              ? "Roda em paralelo na pasta do projeto; evite tarefas que editem os mesmos arquivos."
              : "Cada tarefa roda em paralelo."}
          </span>
          <button
            className="send"
            aria-label="Iniciar tarefa"
            title="Iniciar tarefa"
            disabled={!text.trim() || sending}
            onClick={() => void start()}
          >
            <ArrowUp size={21} />
          </button>
        </div>
      </div>
    </div>
  );
}
