import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  CircleAlert,
  LoaderCircle,
  MessageSquarePlus,
  RotateCcw,
  Square,
  X,
  Zap,
} from "lucide-react";
import type { AgentId, QuickRun, Snapshot, Task } from "../shared/types";
import { agentIds, agentNames } from "../shared/types";
import { api } from "./api";
import { getDraft, saveDraft } from "./drafts";
import { RequestCard } from "./parts";
import { MarkdownLink, markdownUrl, remarkFilePaths } from "./mentions";
// Quick chat: questions and small jobs apart from the conversations. Each
// message is a quick run that resumes the previous one's session; the thread
// lives only here, until "Nova" or Codebit closes (a window reload keeps it).
interface Turn {
  text: string;
  // Missing while the message is being sent.
  run?: QuickRun;
}
interface Thread {
  agent: AgentId;
  projectId: string;
  turns: Turn[];
}
const threadKey = "codebit.quickChat";
const prefsKey = "codebit.quickChat.prefs";
const modeNames: Record<Task["mode"], string> = {
  plan: "Só leitura",
  execute: "Executar",
  bypass: "Bypass",
};
const modeHelp: Record<Task["mode"], string> = {
  plan: "O agente só lê e responde, sem alterar arquivos.",
  execute: "O agente pede permissão antes de comandos e alterações sensíveis.",
  bypass: "Executa comandos e altera arquivos sem pedir permissão.",
};
let thread: Thread | undefined = loadThread();
const listeners = new Set<() => void>();
function loadThread(): Thread | undefined {
  try {
    const saved = JSON.parse(sessionStorage.getItem(threadKey) || "null");
    return Array.isArray(saved?.turns) && saved.turns.length
      ? saved
      : undefined;
  } catch {
    return undefined;
  }
}
let timer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(timer);
  timer = undefined;
  try {
    if (thread) sessionStorage.setItem(threadKey, JSON.stringify(thread));
    else sessionStorage.removeItem(threadKey);
  } catch {}
}
window.addEventListener("beforeunload", persist);
function setThread(next: Thread | undefined) {
  thread = next;
  timer ??= setTimeout(persist, 400);
  for (const listener of listeners) listener();
}
function updateRun(run: QuickRun) {
  if (!thread?.turns.some((t) => t.run?.id === run.id)) return;
  setThread({
    ...thread,
    turns: thread.turns.map((t) => (t.run?.id === run.id ? { ...t, run } : t)),
  });
}
// Answers keep arriving with the panel closed.
window.codebit.onEvent((e) => {
  if (e.type === "quick" && e.run.kind === "chat") updateRun(e.run);
});
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const useQuickChat = () => useSyncExternalStore(subscribe, () => thread);
const latest = (t?: Thread) => t?.turns.at(-1);
const working = (turn?: Turn) =>
  !!turn && (!turn.run || ["running", "waiting"].includes(turn.run.status));
// Whether the quick chat has an answer on the way, for the sidebar.
export const quickChatStatus = (t?: Thread) =>
  !working(latest(t))
    ? undefined
    : latest(t)?.run?.status === "waiting"
      ? "waiting"
      : "running";
function loadPrefs(): { agent?: AgentId; mode?: Task["mode"] } {
  try {
    return JSON.parse(localStorage.getItem(prefsKey) || "{}") ?? {};
  } catch {
    return {};
  }
}
export function QuickChat({
  snapshot,
  projectId,
  onClose,
  onOpenTask,
  run,
}: {
  snapshot: Snapshot;
  // The open task's project, offered first for a new chat.
  projectId: string;
  onClose: () => void;
  onOpenTask: (id: string) => void;
  run: any;
}) {
  const current = useQuickChat();
  const installed = snapshot.agents.filter((a) => a.selected).map((a) => a.id);
  const choices = installed.length ? installed : agentIds;
  const [prefs, setPrefs] = useState(loadPrefs);
  const agent =
    current?.agent ??
    (prefs.agent && choices.includes(prefs.agent) ? prefs.agent : choices[0]);
  const mode = prefs.mode ?? snapshot.settings.defaultMode ?? "execute";
  const [where, setWhere] = useState(projectId);
  const folder = current?.projectId ?? where;
  const project = snapshot.projects.find((p) => p.id === folder);
  const [text, setRawText] = useState(() => getDraft("quick-chat")?.text ?? "");
  const setText = (value: string) => {
    setRawText(value);
    saveDraft("quick-chat", value, []);
  };
  const last = latest(current);
  const busy = working(last);
  const model =
    last?.run?.model ?? snapshot.settings.defaultModels[agent] ?? "";
  // Re-syncs after a window reload; a chat whose run is gone is over.
  useEffect(() => {
    void api<QuickRun[]>("quick.list").then((runs) => {
      const id = latest(thread)?.run?.id;
      if (!id) return;
      const found = runs.find((r) => r.id === id);
      if (found) updateRun(found);
      else setThread(undefined);
    });
  }, []);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);
  // Follows the answer while the user is at the bottom.
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (stick.current && body.current)
      body.current.scrollTop = body.current.scrollHeight;
  }, [current]);
  function remember(next: { agent?: AgentId; mode?: Task["mode"] }) {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    try {
      localStorage.setItem(prefsKey, JSON.stringify(merged));
    } catch {}
  }
  async function send() {
    const message = text.trim();
    if (!message || busy) return;
    const base: Thread = current ?? { agent, projectId: folder, turns: [] };
    const after = latest(base)?.run?.id;
    setThread({ ...base, turns: [...base.turns, { text: message }] });
    setText("");
    stick.current = true;
    try {
      const started = await api<QuickRun>("quick.chat", {
        text: message,
        agent: base.agent,
        mode,
        projectId: base.projectId || undefined,
        after,
      });
      // "Nova" while it was being sent: the answer is not wanted anymore.
      if (!thread) return void (await api("quick.dismiss", { id: started.id }));
      const turns = thread.turns;
      setThread({
        ...thread,
        turns: turns.map((t, i) =>
          i === turns.length - 1 && !t.run ? { ...t, run: started } : t,
        ),
      });
    } catch (e) {
      // Nothing started: the message goes back to the box.
      setThread(base.turns.length ? base : undefined);
      setText(message);
      throw e;
    }
  }
  async function restart() {
    const id = last?.run?.id;
    setThread(undefined);
    if (id) await api("quick.dismiss", { id });
    input.current?.focus();
  }
  async function keep() {
    const id = last?.run?.id;
    if (!current || !id) return;
    const task = await api<Task>("quick.keepChat", {
      id,
      turns: current.turns
        .filter((t) => t.run)
        .map((t) => ({ user: t.text, assistant: t.run!.reply })),
    });
    setThread(undefined);
    onOpenTask(task.id);
  }
  return (
    <aside className="quick-panel quick-chat" aria-label="Chat rápido">
      <header>
        <div>
          <strong>Chat rápido</strong>
          <span>
            {agentNames[agent]}
            {model ? ` · ${model}` : ""} · {project?.name ?? "Sem projeto"}
          </span>
        </div>
        <div className="quick-chat-actions">
          {current && (
            <>
              <button
                className="icon"
                title="Levar para uma conversa: cria uma conversa com as mensagens, que retoma a mesma sessão do agente"
                aria-label="Levar para uma conversa"
                disabled={busy}
                onClick={() => void run(keep)}
              >
                <MessageSquarePlus size={16} />
              </button>
              <button
                className="icon"
                title="Nova: apaga este chat e começa outro"
                aria-label="Novo chat rápido"
                onClick={() => void run(restart)}
              >
                <RotateCcw size={16} />
              </button>
            </>
          )}
          <button
            className="icon"
            title="Fechar painel (Ctrl+J)"
            aria-label="Fechar painel"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
      </header>
      <div
        className="quick-body"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!current && (
          <div className="quick-empty">
            <Zap size={20} />
            <strong>Pergunte ou peça algo rápido</strong>
            <p>
              Dúvidas e execuções simples, fora das conversas. Nada vai para o
              histórico: o chat some ao clicar em Nova ou ao fechar o Codebit.
            </p>
          </div>
        )}
        {current?.turns.map((t, i) => (
          <div className="quick-turn" key={t.run?.id ?? `pending-${i}`}>
            <div className="quick-question">{t.text}</div>
            {!!t.run?.activity.length && (
              <details className="quick-activity">
                <summary>
                  {t.run.activity.length === 1
                    ? "1 ação"
                    : `${t.run.activity.length} ações`}
                </summary>
                {t.run.activity.map((a, j) => (
                  <div key={j}>{a}</div>
                ))}
              </details>
            )}
            {t.run?.reply && (
              <div className="markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkFilePaths]}
                  urlTransform={markdownUrl}
                  components={{
                    a: ({ href, children }) => (
                      <MarkdownLink
                        href={href}
                        base={{ cwd: t.run!.cwd }}
                        run={run}
                      >
                        {children}
                      </MarkdownLink>
                    ),
                  }}
                >
                  {t.run.reply}
                </ReactMarkdown>
              </div>
            )}
            {(!t.run || t.run.status === "running") && (
              <div className="working">
                <LoaderCircle size={15} className="spin" />
                {t.run ? "O agente está trabalhando…" : "Enviando…"}
              </div>
            )}
            {t.run?.request && (
              <RequestCard
                entry={{
                  id: t.run.id,
                  taskId: "",
                  kind: "request",
                  text: t.run.request.title,
                  createdAt: t.run.startedAt,
                  request: t.run.request,
                }}
                taskId=""
                run={run}
                onRespond={(value) =>
                  api("quick.respond", { id: t.run!.id, value })
                }
              />
            )}
            {t.run?.error && (
              <div className="error-card">
                <CircleAlert size={18} />
                <div>
                  <strong>A resposta não terminou</strong>
                  <p>{t.run.error}</p>
                </div>
              </div>
            )}
            {t.run?.status === "interrupted" && !t.run.error && (
              <div className="quick-note">Interrompido.</div>
            )}
          </div>
        ))}
      </div>
      <footer className="quick-chat-composer">
        <div className="quick-chat-options">
          {!current && (
            <>
              <select
                aria-label="Agente do chat rápido"
                value={agent}
                onChange={(e) => remember({ agent: e.target.value as AgentId })}
              >
                {choices.map((id) => (
                  <option key={id} value={id}>
                    {agentNames[id]}
                  </option>
                ))}
              </select>
              <select
                aria-label="Pasta do chat rápido"
                title="Onde o agente trabalha"
                value={where}
                onChange={(e) => setWhere(e.target.value)}
              >
                <option value="">Sem projeto</option>
                {snapshot.projects.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.trusted}>
                    {p.name}
                    {p.trusted ? "" : " (não confiável)"}
                  </option>
                ))}
              </select>
            </>
          )}
          <div
            className="mode-toggle"
            role="group"
            aria-label="Permissão do chat rápido"
          >
            {(["plan", "execute", "bypass"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`${m === "bypass" ? "bypass" : ""} ${mode === m ? "selected" : ""}`}
                aria-pressed={mode === m}
                title={modeHelp[m]}
                onClick={() => remember({ mode: m })}
              >
                {modeNames[m]}
              </button>
            ))}
          </div>
        </div>
        <div className="quick-chat-input">
          <textarea
            ref={input}
            aria-label="Mensagem do chat rápido"
            placeholder={
              current ? "Continue a conversa…" : "Pergunte ou peça algo rápido…"
            }
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void run(send);
              }
            }}
          />
          {busy && last?.run ? (
            <button
              className="send stop"
              title="Interromper"
              aria-label="Interromper resposta"
              onClick={() =>
                void run(() => api("quick.stop", { id: last.run!.id }))
              }
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              className="send"
              title="Enviar (Enter) · Shift+Enter para nova linha"
              aria-label="Enviar no chat rápido"
              disabled={busy || !text.trim()}
              onClick={() => void run(send)}
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
      </footer>
    </aside>
  );
}
