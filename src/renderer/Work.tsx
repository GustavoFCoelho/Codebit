import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import type {
  Project,
  Snapshot,
  Task,
  WorkItem,
  WorkSettings,
  WorkStatus,
} from "../shared/types";
import { agentIds, agentNames, defaultWork, workStatus } from "../shared/types";
import { effortLabel } from "../shared/models";
import { api } from "./api";
import { AgentMark, Switch } from "./parts";
type Run = <T>(work: () => Promise<T>) => Promise<T | undefined>;
const ago = (iso: string) => {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `há ${hours} h` : `há ${Math.floor(hours / 24)} d`;
};
// A project's task board: the user's tasks and the approved recommendations
// on the board, the AI's recommendations apart until approved.
export function WorkBoard({
  project,
  snapshot,
  run,
  onOpen,
}: {
  project: Project;
  snapshot: Snapshot;
  run: Run;
  onOpen: (taskId: string) => void;
}) {
  const [tab, setTab] = useState<"board" | "pending">("board");
  const tasks = useMemo(
    () => new Map(snapshot.tasks.map((t) => [t.id, t])),
    [snapshot.tasks],
  );
  const items = snapshot.work.filter((i) => i.projectId === project.id);
  const statusOf = (i: WorkItem) =>
    workStatus(i, i.taskId ? tasks.get(i.taskId) : undefined);
  const columns: Record<"todo" | "running" | "done" | "problem", WorkItem[]> = {
    todo: [],
    running: [],
    done: [],
    problem: [],
  };
  const pending: WorkItem[] = [];
  for (const item of items) {
    const status = statusOf(item);
    if (status === "pending") pending.push(item);
    else if (status === "todo") columns.todo.push(item);
    else if (status === "running" || status === "waiting")
      columns.running.push(item);
    else if (status === "done") columns.done.push(item);
    else columns.problem.push(item);
  }
  columns.done.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const work = project.work ?? defaultWork;
  const save = (patch: Partial<WorkSettings>) =>
    run(() => api("work.settings", { projectId: project.id, settings: patch }));
  const agent = snapshot.agents.find((a) => a.id === work.agent);
  const model = agent?.models.find((m) => m.id === work.model);
  const card = (item: WorkItem) => (
    <WorkCard
      key={item.id}
      item={item}
      status={statusOf(item)}
      task={item.taskId ? tasks.get(item.taskId) : undefined}
      source={items.find((i) => i.id === item.sourceId)}
      chat={item.chatId ? tasks.get(item.chatId) : undefined}
      run={run}
      onOpen={onOpen}
    />
  );
  return (
    <div className="work">
      <div className="work-head">
        <div>
          <h2>Tarefas · {project.name}</h2>
          <p>
            {work.enabled
              ? `Ligado: agentes começam as tarefas de "A fazer", ${work.max === 1 ? "uma por vez" : `até ${work.max} ao mesmo tempo`}.`
              : "Desligado: nenhuma tarefa começa sozinha. As que estão em andamento terminam normalmente."}
          </p>
        </div>
        <div className={`work-switch ${work.enabled ? "on" : ""}`}>
          <Switch
            checked={work.enabled}
            disabled={!project.trusted}
            onChange={(enabled) => void save({ enabled })}
          >
            Modo tarefas
          </Switch>
        </div>
      </div>
      {!project.trusted && (
        <p className="help amber-text">
          Confie no projeto (abra uma conversa dele e confirme) para executar
          tarefas nele.
        </p>
      )}
      <div className="work-config">
        <label>
          Agente
          <select
            aria-label="Agente das tarefas"
            value={work.agent}
            onChange={(e) =>
              void save({
                agent: e.target.value as WorkSettings["agent"],
                model: "",
                effort: "",
              })
            }
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
        </label>
        <label>
          Modelo
          <select
            aria-label="Modelo das tarefas"
            value={work.model}
            onChange={(e) => void save({ model: e.target.value, effort: "" })}
          >
            <option value="">Padrão das configurações</option>
            {agent?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            {work.model && !model && (
              <option value={work.model}>{work.model}</option>
            )}
          </select>
        </label>
        <label>
          Esforço
          <select
            aria-label="Esforço das tarefas"
            value={work.effort}
            disabled={!model?.efforts?.length}
            onChange={(e) => void save({ effort: e.target.value })}
          >
            <option value="">Padrão do modelo</option>
            {model?.efforts?.map((effort) => (
              <option key={effort} value={effort}>
                {effortLabel(effort)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Simultâneas
          <input
            type="number"
            className="narrow"
            aria-label="Tarefas simultâneas"
            min={1}
            max={4}
            value={work.max}
            onChange={(e) =>
              void save({
                max: Math.min(4, Math.max(1, Math.round(+e.target.value || 1))),
              })
            }
          />
        </label>
        <div className="field">
          Permissões
          <div
            className="mode-toggle"
            role="group"
            aria-label="Permissões das tarefas"
          >
            {(
              [
                ["execute", "Executar"],
                ["bypass", "Bypass"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                className={`${mode === "bypass" ? "bypass" : ""} ${work.mode === mode ? "selected" : ""}`}
                aria-pressed={work.mode === mode}
                onClick={() => void save({ mode })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="help work-note">
        Vale para as próximas tarefas que começarem. Cada tarefa roda numa
        sessão interna, fora das conversas do projeto; clique em Acompanhar para
        ver e conversar. Com mais de uma ao mesmo tempo, elas dividem a pasta do
        projeto.
        {work.agent === "devin" &&
          " O Devin ainda não usa ferramentas do Codebit como agente principal, então não recomenda tarefas."}
      </p>
      <div className="work-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "board"}
          className={tab === "board" ? "selected" : ""}
          onClick={() => setTab("board")}
        >
          Quadro
          <span className="badge">{items.length - pending.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === "pending"}
          className={tab === "pending" ? "selected" : ""}
          onClick={() => setTab("pending")}
        >
          <Sparkles size={14} />
          Pendentes de aprovação
          <span className={`badge ${pending.length ? "attention" : ""}`}>
            {pending.length}
          </span>
        </button>
      </div>
      {tab === "board" ? (
        <div className="work-columns">
          <section className="work-column" aria-label="A fazer">
            <h3>
              A fazer <span>{columns.todo.length}</span>
            </h3>
            <NewWork projectId={project.id} run={run} />
            {columns.todo.map(card)}
          </section>
          <section className="work-column" aria-label="Em andamento">
            <h3>
              Em andamento <span>{columns.running.length}</span>
            </h3>
            {columns.running.map(card)}
            {!columns.running.length && (
              <p className="help">
                {work.enabled
                  ? "Nenhuma tarefa agora."
                  : "Ligue o modo tarefas ou use Executar agora."}
              </p>
            )}
          </section>
          <section className="work-column" aria-label="Concluídas">
            <h3>
              Concluídas <span>{columns.done.length}</span>
            </h3>
            {columns.done.map(card)}
          </section>
          <section className="work-column" aria-label="Com problema">
            <h3>
              Com problema <span>{columns.problem.length}</span>
            </h3>
            {columns.problem.map(card)}
          </section>
        </div>
      ) : (
        <div className="work-pending">
          <div className="work-pending-head">
            <p className="help">
              As tarefas que os agentes recomendam ao terminar ficam aqui. Elas
              não começam até você aprovar; aprovadas, vão para o fim de "A
              fazer".
            </p>
            {pending.length > 1 && (
              <button
                className="quiet"
                onClick={() =>
                  void run(() =>
                    api("work.approveAll", { projectId: project.id }),
                  )
                }
              >
                <Check size={14} />
                Aprovar todas
              </button>
            )}
          </div>
          {pending.map(card)}
          {!pending.length && (
            <div className="empty-card">
              Nenhuma recomendação esperando. Os agentes recomendam tarefas de
              continuação ao terminar uma tarefa do quadro.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
function NewWork({ projectId, run }: { projectId: string; run: Run }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [open, setOpen] = useState(false);
  const add = () =>
    void run(async () => {
      if (!title.trim()) return;
      await api("work.add", { projectId, title, description });
      setTitle("");
      setDescription("");
      setOpen(false);
    });
  return (
    <form
      className="work-new"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <input
        aria-label="Título da nova tarefa"
        placeholder="Nova tarefa…"
        value={title}
        onFocus={() => setOpen(true)}
        onChange={(e) => setTitle(e.target.value)}
      />
      {open && (
        <>
          <textarea
            aria-label="Descrição da nova tarefa"
            placeholder="O que o agente precisa saber (opcional)"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.ctrlKey) {
                e.preventDefault();
                add();
              }
            }}
          />
          <div className="row-actions">
            <button className="primary compact" disabled={!title.trim()}>
              <Plus size={14} />
              Adicionar
            </button>
            <button
              type="button"
              className="quiet compact"
              onClick={() => {
                setOpen(false);
                setTitle("");
                setDescription("");
              }}
            >
              Cancelar
            </button>
          </div>
        </>
      )}
    </form>
  );
}
const statusText: Record<WorkStatus, string> = {
  pending: "Recomendada pela IA",
  todo: "Na fila",
  running: "Trabalhando",
  waiting: "Aguardando você",
  done: "Concluída",
  failed: "Falhou",
  interrupted: "Interrompida",
};
function WorkCard({
  item,
  status,
  task,
  source,
  chat,
  run,
  onOpen,
}: {
  item: WorkItem;
  status: WorkStatus;
  task?: Task;
  source?: WorkItem;
  // The conversation that added it, if any.
  chat?: Task;
  run: Run;
  onOpen: (taskId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [confirm, setConfirm] = useState(false);
  const call = (method: string, args: object = {}) =>
    void run(() => api(method, { id: item.id, ...args }));
  if (editing)
    return (
      <article className="work-card editing" aria-label={item.title}>
        <input
          aria-label="Título da tarefa"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          aria-label="Descrição da tarefa"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="row-actions">
          <button
            className="primary compact"
            disabled={!title.trim()}
            onClick={() =>
              void run(async () => {
                await api("work.edit", { id: item.id, title, description });
                setEditing(false);
              })
            }
          >
            Salvar
          </button>
          <button className="quiet compact" onClick={() => setEditing(false)}>
            Cancelar
          </button>
        </div>
      </article>
    );
  const remove = (
    <button
      className={`icon danger-icon ${confirm ? "confirm" : ""}`}
      title={
        confirm
          ? "Clique de novo para excluir"
          : status === "pending"
            ? "Descartar"
            : "Excluir"
      }
      aria-label={status === "pending" ? "Descartar" : "Excluir"}
      onClick={() => (confirm ? call("work.delete") : setConfirm(true))}
      onBlur={() => setConfirm(false)}
    >
      {confirm ? <Check size={14} /> : <Trash2 size={14} />}
    </button>
  );
  return (
    <article
      className={`work-card status-${status}`}
      aria-label={item.title}
      title={item.description || item.title}
    >
      <header>
        <strong>{item.title}</strong>
        {item.origin === "ai" ? (
          <span className="badge" title="Sugerida por um agente">
            IA
          </span>
        ) : (
          item.chatId && (
            <span className="badge" title="Pedida numa conversa do projeto">
              Conversa
            </span>
          )
        )}
      </header>
      {item.description && <p>{item.description}</p>}
      {source && <small className="work-source">De: {source.title}</small>}
      {chat && (
        <button
          className="text-button work-source"
          title="Abrir a conversa"
          onClick={() => onOpen(chat.id)}
        >
          Da conversa: {chat.title}
        </button>
      )}
      <footer>
        <span className={`work-status ${status}`}>
          {task && ["running", "waiting"].includes(status) && (
            <AgentMark agent={task.agent} />
          )}
          {statusText[status]}
          {["done", "failed", "interrupted"].includes(status) &&
            ` · ${ago(task?.updatedAt ?? item.updatedAt)}`}
        </span>
        <span className="work-actions">
          {status === "pending" && (
            <>
              <button
                className="quiet compact"
                onClick={() => call("work.approve")}
              >
                <Check size={13} />
                Aprovar
              </button>
              <button
                className="icon"
                title="Editar"
                aria-label="Editar"
                onClick={() => setEditing(true)}
              >
                <Pencil size={14} />
              </button>
              {remove}
            </>
          )}
          {status === "todo" && (
            <>
              <button
                className="icon"
                title="Executar agora, mesmo com o modo desligado"
                aria-label="Executar agora"
                onClick={() => call("work.start")}
              >
                <Play size={14} />
              </button>
              <button
                className="icon"
                title="Subir na fila"
                aria-label="Subir na fila"
                onClick={() => call("work.move", { direction: -1 })}
              >
                <ArrowUp size={14} />
              </button>
              <button
                className="icon"
                title="Descer na fila"
                aria-label="Descer na fila"
                onClick={() => call("work.move", { direction: 1 })}
              >
                <ArrowDown size={14} />
              </button>
              <button
                className="icon"
                title="Editar"
                aria-label="Editar"
                onClick={() => setEditing(true)}
              >
                <Pencil size={14} />
              </button>
              {remove}
            </>
          )}
          {(status === "running" || status === "waiting") && task && (
            <>
              <button className="quiet compact" onClick={() => onOpen(task.id)}>
                <MessageSquare size={13} />
                Acompanhar
              </button>
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
            </>
          )}
          {(status === "failed" || status === "interrupted") && (
            <button
              className="quiet compact"
              onClick={() => call("work.retry")}
            >
              <RotateCcw size={13} />
              Tentar de novo
            </button>
          )}
          {["done", "failed", "interrupted"].includes(status) && task && (
            <button
              className="icon"
              title="Abrir a sessão"
              aria-label="Abrir a sessão"
              onClick={() => onOpen(task.id)}
            >
              <MessageSquare size={14} />
            </button>
          )}
          {["done", "failed", "interrupted"].includes(status) && remove}
        </span>
      </footer>
    </article>
  );
}
