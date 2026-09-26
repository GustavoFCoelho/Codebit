import {
  memo,
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Code2,
  Plus,
  Search,
  Folder,
  FolderOpen,
  File,
  Settings as SettingsIcon,
  Layers,
  ChevronDown,
  ChevronRight,
  Paperclip,
  ArrowUp,
  Square,
  Check,
  X,
  Minus,
  Maximize2,
  Archive,
  PanelRightClose,
  PanelRightOpen,
  ArrowRightLeft,
  Image as ImageIcon,
  Terminal as TerminalIcon,
  Pencil,
  LoaderCircle,
  ShieldCheck,
  RefreshCw,
  Download,
  CircleAlert,
  TriangleAlert,
  Users,
  MessageSquare,
  ListOrdered,
  ListPlus,
  ChevronUp,
  Eye,
  EyeOff,
  Gauge,
  LayoutGrid,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AgentCommand,
  AgentId,
  AgentInfo,
  Artifact,
  BoardCard,
  Entry,
  ImageModel,
  Model,
  Project,
  QuickRun,
  SavedPrompt,
  Snapshot,
  Task,
} from "../shared/types";
import {
  agentIds,
  agentNames,
  appVersion,
  defaultSubagents,
  imageProviderNames,
} from "../shared/types";
import { api, artifactUrl, fileName, fileUrl, readBase64 } from "./api";
import { ContextMeter, RequestCard, statusName } from "./parts";
import { effortLabel } from "../shared/models";
import { SettingsView } from "./Settings";
import { PromptList, PromptModal, QuickPanel } from "./Prompts";
import {
  isImagePath,
  linkedImage,
  LinkedText,
  markdownUrl,
  remarkImagePaths,
} from "./mentions";
import { Inspector } from "./Inspector";
import { Board, taskMime } from "./Board";
type Modal = "new" | "handoff" | "rename" | "model" | null;
const MemoInspector = memo(Inspector);
// Same function identity across renders, always calling the latest version.
function useStable<T extends (...args: any[]) => any>(fn: T): T {
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback(((...args) => latest.current(...args)) as T, []);
}
export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [selected, setSelected] = useState(
    localStorage.getItem("codebit.task") || "",
  );
  const [view, setView] = useState<
    "workspace" | "settings" | "extensions" | "board"
  >("workspace");
  const viewRef = useRef(view);
  viewRef.current = view;
  const [board, setBoard] = useState<BoardCard[]>([]);
  const [task, setTask] = useState<Task>();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<Modal>(null);
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");
  const [newAgent, setNewAgent] = useState<AgentId>("codex");
  const [subagentsOpen, setSubagentsOpen] = useState(false);
  const [hideContext, setHideContext] = useState(
    localStorage.getItem("codebit.hideContext") === "1",
  );
  // Commands and skills of the selected task's agent, keyed by task and agent.
  const [commands, setCommands] = useState<{
    key: string;
    list?: AgentCommand[];
    error?: string;
  }>({ key: "" });
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteClosed, setPaletteClosed] = useState(false);
  const [worktree, setWorktree] = useState(false);
  const [summary, setSummary] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [panel, setPanel] = useState(true);
  const [tab, setTab] = useState("Alterações");
  const [imageModels, setImageModels] = useState<ImageModel[]>([]);
  const [imageProgress, setImageProgress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<string>();
  // Saved prompts: the form being edited and the panel with their runs.
  const [promptForm, setPromptForm] = useState<SavedPrompt | "new">();
  // An image file mentioned in the chat, shown in the side panel.
  const [openedImage, setOpenedImage] = useState<string>();
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickSelected, setQuickSelected] = useState<string>();
  const handoffDraft = useRef<{ id: string; text: string } | undefined>(
    undefined,
  );
  const imageProgressByTask = useRef(new Map<string, string>());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const bottom = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const scrollToEnd = () =>
    bottom.current?.scrollIntoView({ behavior: "instant", block: "end" });
  const run = useCallback(
    async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await work();
      } catch (e) {
        setError(
          (e as Error).message.replace(
            /^Error invoking remote method '[^']+': (?:Error: )?/,
            "",
          ),
        );
      }
    },
    [],
  );
  async function refresh() {
    const data = await api<Snapshot>("snapshot");
    setSnapshot(data);
    if (viewRef.current === "board") {
      setBoard(await api<BoardCard[]>("board.read"));
      return;
    }
    const id = selectedRef.current;
    if (id && data.tasks.some((t) => t.id === id)) {
      const value = await api<{
        task: Task;
        entries: Entry[];
        artifacts: Artifact[];
      }>("task.read", { id });
      if (selectedRef.current === id) {
        setTask(value.task);
        setEntries(value.entries);
        setArtifacts(value.artifacts);
      }
    }
  }
  useEffect(() => {
    void run(refresh);
    return window.codebit.onEvent((event) => {
      if (event.type === "refresh") void run(refresh);
      if (event.type === "open-task") {
        setSelected(event.taskId);
        setView("workspace");
      }
      if (event.type === "image-progress") {
        imageProgressByTask.current.set(event.taskId, event.message);
        if (event.taskId === selectedRef.current)
          setImageProgress(event.message);
      }
    });
  }, []);
  useEffect(() => {
    setTask(undefined);
    setEntries([]);
    setArtifacts([]);
    setDraft(
      handoffDraft.current?.id === selected ? handoffDraft.current.text : "",
    );
    handoffDraft.current = undefined;
    setAttachments([]);
    setImageProgress(imageProgressByTask.current.get(selected) || "");
    setSelectedArtifact(undefined);
    setOpenedImage(undefined);
    setSubagentsOpen(false);
    localStorage.setItem("codebit.task", selected);
    void run(refresh);
  }, [selected]);
  // Each view loads its own data when it opens.
  useEffect(() => {
    void run(refresh);
  }, [view]);
  const openTask = useStable((id: string) => {
    setSelected(id);
    setView("workspace");
  });
  // Saved prompts borrow the open task's agent and model, never its chat.
  function runPrompt(prompt: SavedPrompt) {
    void run(async () => {
      const started = await api<QuickRun>("quick.start", {
        promptId: prompt.id,
        taskId: task?.id,
      });
      setQuickSelected(started.id);
      setQuickOpen(true);
    });
  }
  const closeQuick = useStable(() => setQuickOpen(false));
  const keptQuick = useStable((id: string) => {
    setQuickOpen(false);
    openTask(id);
  });
  // Opening a task, or returning to the chat, starts at the latest message.
  const opened = useRef("");
  useLayoutEffect(() => {
    const key = `${view}:${task?.id ?? ""}`;
    if (key !== opened.current) {
      opened.current = key;
      stickBottom.current = true;
    }
    if (stickBottom.current) scrollToEnd();
  }, [entries, view, task?.id]);
  useEffect(() => {
    setImageModels([]);
    if (task?.images.provider)
      void api<ImageModel[]>("images.models", {
        provider: task.images.provider,
      })
        .then(setImageModels)
        .catch(() => {});
  }, [
    task?.images.provider,
    snapshot?.agents.find((a) => a.id === "codex")?.selected?.path,
    snapshot?.settings.hasOpenAIKey,
    snapshot?.settings.comfyUrl,
    JSON.stringify(snapshot?.settings.workflows),
  ]);
  const project = snapshot?.projects.find((p) => p.id === task?.projectId);
  // Conversations without a project run in a Codebit folder and need no trust.
  const trusted = !task?.projectId || !!project?.trusted;
  const active = task && ["running", "waiting", "queued"].includes(task.status);
  // A session kept open for background work keeps its settings.
  const locked = !!active || !!task?.background;
  const subagents = task?.subagents ?? defaultSubagents;
  const subagentInfo = snapshot?.agents.find((a) => a.id === subagents.agent);
  const subagentModel = subagentInfo?.models.find(
    (m) => m.id === subagents.model,
  );
  const selectedInfo = snapshot?.agents.find((a) => a.id === task?.agent);
  const selectedModel = selectedInfo?.models.find((m) => m.id === task?.model);
  const efforts = selectedModel?.efforts || [];
  // "Ocultar contexto" keeps the conversation and drops tool runs and
  // approvals already answered.
  const visibleEntries = useMemo(
    () =>
      hideContext
        ? entries.filter(
            (e) =>
              e.kind !== "activity" && !(e.kind === "request" && e.resolved),
          )
        : entries,
    [entries, hideContext],
  );
  // Typing "/" at the start of the message lists the agent's skills and commands.
  const slash = /^\/(\S*)$/.exec(draft)?.[1];
  const paletteOpen = !!task && slash !== undefined && !paletteClosed;
  const commandKey = task ? `${task.id}:${task.agent}` : "";
  const matches = (commandKey === commands.key ? commands.list || [] : [])
    .filter((c) => c.name.toLowerCase().includes((slash || "").toLowerCase()))
    .sort(
      (a, b) =>
        +!a.name.toLowerCase().startsWith(slash?.toLowerCase() || "") -
        +!b.name.toLowerCase().startsWith(slash?.toLowerCase() || ""),
    )
    .slice(0, 50);
  useEffect(() => {
    if (!paletteOpen || commands.key === commandKey) return;
    setCommands({ key: commandKey });
    void loadCommands(false);
  }, [paletteOpen, commandKey]);
  useEffect(() => {
    setPaletteIndex(0);
    if (slash === undefined) setPaletteClosed(false);
  }, [slash]);
  async function loadCommands(refresh: boolean) {
    if (!task) return;
    const key = commandKey;
    try {
      const list = await api<AgentCommand[]>("task.commands", {
        id: task.id,
        refresh,
      });
      setCommands({ key, list });
    } catch (e) {
      setCommands({ key, list: [], error: (e as Error).message });
    }
  }
  // Codex invokes skills with $name; Claude and Devin run /name.
  function chooseCommand(c: AgentCommand) {
    setDraft(`${task?.agent === "codex" ? "$" : "/"}${c.name} `);
  }
  async function addProject() {
    const p = await api<Project | null>("project.add");
    if (p) {
      await refresh();
      setProjectId(p.id);
      setTitle("");
      setModal("new");
    }
  }
  // An empty project id creates a conversation without a project.
  function newTask(p = project?.id ?? snapshot?.projects[0]?.id ?? "") {
    setProjectId(p);
    setTitle("");
    setWorktree(false);
    setModal("new");
  }
  async function pasteImages(files: File[]) {
    if (!task) return;
    const types: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
    };
    const saved: string[] = [];
    for (const file of files) {
      if (!types[file.type])
        throw new Error("Cole imagens PNG, JPEG, WebP ou GIF.");
      saved.push(
        await api<string>("attachments.paste", {
          id: task.id,
          name: `imagem-colada.${types[file.type]}`,
          data: await readBase64(file),
        }),
      );
    }
    setAttachments((current) => [...current, ...saved].slice(0, 10));
  }
  async function patchSubagents(value: Partial<typeof subagents>) {
    await patch({ subagents: { ...subagents, ...value } });
  }
  // Stable identities let the memoized chat rows and panel skip re-renders.
  const patch = useStable(async (value: Partial<Task>) => {
    if (task) await api("task.update", { id: task.id, patch: value });
  });
  const onImageLoad = useStable(() => {
    if (stickBottom.current) scrollToEnd();
  });
  const openImage = useStable((path: string) => {
    setOpenedImage(path);
    setTab("Imagens");
    setPanel(true);
  });
  const onImage = useStable((action: "open" | "edit", artifactId: string) => {
    setOpenedImage(undefined);
    if (action === "open") setSelectedArtifact(artifactId);
    else
      void run(async () => {
        await selectInputImage(artifactId);
        setDraft("Edite esta imagem: ");
      });
    setTab("Imagens");
    setPanel(true);
  });
  async function selectInputImage(id?: string) {
    if (!task) return;
    await patch({
      images: {
        ...task.images,
        inputImage: id,
        workflow: task.images.workflow.startsWith("sdxl-")
          ? id
            ? "sdxl-edit"
            : "sdxl-text"
          : task.images.workflow,
      },
    });
    if (id) {
      setTab("Imagens");
      setPanel(true);
    }
  }
  async function submit() {
    if (!task || submitting) return;
    setSubmitting(true);
    try {
      // While the agent works, messages wait in the task queue.
      await api(active ? "task.enqueue" : "task.send", {
        id: task.id,
        text: draft,
        attachments,
      });
      setDraft("");
      setAttachments([]);
      stickBottom.current = true;
    } finally {
      setSubmitting(false);
    }
  }
  async function generateImage() {
    if (!task || !draft.trim()) return;
    setTab("Imagens");
    setPanel(true);
    const prompt = draft;
    setDraft("");
    try {
      const result = await api<Artifact>("images.generate", {
        id: task.id,
        prompt,
      });
      setSelectedArtifact(result.id);
    } catch (e) {
      setDraft(prompt);
      throw e;
    }
  }
  async function saveModal() {
    if (modal === "new") {
      const t = await api<Task>("task.create", {
        projectId,
        title: title.trim() || (projectId ? "Nova tarefa" : "Nova conversa"),
        agent: newAgent,
        worktree: !!projectId && worktree,
      });
      setSelected(t.id);
      setView("workspace");
    }
    if (modal === "rename") await patch({ title: title.trim() });
    if (modal === "model") await patch({ model: title.trim() });
    if (modal === "handoff" && task) {
      const result = await api<{ task: Task; draft: string }>("task.handoff", {
        id: task.id,
        agent: newAgent,
        summary,
      });
      handoffDraft.current = { id: result.task.id, text: result.draft };
      setSelected(result.task.id);
    }
    setModal(null);
    await refresh();
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Code2 size={30} />
          <span>Codebit</span>
          <span className="version">LOCAL</span>
        </div>
        <button className="primary new-task" onClick={() => newTask()}>
          <Plus size={19} />
          Nova tarefa
        </button>
        <label className="search">
          <Search size={16} />
          <input
            aria-label="Buscar tarefas"
            placeholder="Buscar"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <kbd>⌕</kbd>
        </label>
        <button
          className={`board-link ${view === "board" ? "active-link" : ""}`}
          onClick={() => setView("board")}
        >
          <LayoutGrid size={17} />
          Multitarefa
          {(() => {
            const running = snapshot?.tasks.filter(
              (t) =>
                t.boardAt &&
                ["running", "waiting", "queued"].includes(t.status),
            ).length;
            return running ? (
              <span className="badge success">{running}</span>
            ) : null;
          })()}
        </button>
        <nav className="project-list">
          <PromptList
            prompts={snapshot?.prompts ?? []}
            projectId={task?.projectId ?? ""}
            onRun={runPrompt}
            onEdit={setPromptForm}
            onNew={() => setPromptForm("new")}
          />
          <div className="section-label">
            <span>CONVERSAS</span>
            <button
              className="icon"
              title="Nova conversa sem projeto"
              aria-label="Nova conversa sem projeto"
              onClick={() => newTask("")}
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="project conversations">
            {snapshot?.tasks
              .filter(
                (t) =>
                  !t.projectId &&
                  t.archived === showArchived &&
                  t.title.toLowerCase().includes(search.toLowerCase()),
              )
              .map((t) => (
                <TaskItem
                  key={t.id}
                  task={t}
                  selected={t.id === selected && view === "workspace"}
                  icon={<MessageSquare size={15} />}
                  onSelect={() => {
                    setSelected(t.id);
                    setView("workspace");
                  }}
                />
              ))}
          </div>
          <div className="section-label">
            <span>PROJETOS</span>
            <button
              className="icon"
              title="Adicionar projeto"
              aria-label="Adicionar projeto"
              onClick={() => void run(addProject)}
            >
              <Plus size={15} />
            </button>
          </div>
          {!snapshot?.projects.length && (
            <p className="sidebar-hint">
              Abra uma pasta para começar seu primeiro projeto.
            </p>
          )}
          {snapshot?.projects.map((p) => (
            <div className="project" key={p.id}>
              <div className="project-title">
                <ChevronDown size={14} />
                <Folder size={17} />
                <span>{p.name}</span>
                <button
                  className="icon on-hover"
                  title="Nova tarefa neste projeto"
                  onClick={() => newTask(p.id)}
                >
                  <Plus size={14} />
                </button>
              </div>
              {snapshot.tasks
                .filter(
                  (t) =>
                    t.projectId === p.id &&
                    t.archived === showArchived &&
                    t.title.toLowerCase().includes(search.toLowerCase()),
                )
                .map((t) => (
                  <TaskItem
                    key={t.id}
                    task={t}
                    selected={t.id === selected && view === "workspace"}
                    icon={<File size={15} />}
                    onSelect={() => {
                      setSelected(t.id);
                      setView("workspace");
                    }}
                  />
                ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={showArchived ? "active-link" : ""}
            onClick={() => setShowArchived(!showArchived)}
          >
            <Archive size={17} />
            {showArchived ? "Mostrar tarefas ativas" : "Arquivadas"}
          </button>
          <button
            className={view === "extensions" ? "active-link" : ""}
            onClick={() => setView("extensions")}
          >
            <Layers size={18} />
            Skills e MCP
          </button>
          <button
            className={view === "settings" ? "active-link" : ""}
            onClick={() => setView("settings")}
          >
            <SettingsIcon size={18} />
            Configurações
          </button>
          {snapshot?.update?.available && (
            <div className="update-pill" role="status">
              {snapshot.update.status === "idle" ? (
                <button
                  title="Espera as tarefas terminarem, abre a versão nova e fecha esta. As conversas continuam na mesma sessão dos agentes."
                  onClick={() => void run(() => api("update.apply"))}
                >
                  <Download size={14} />v{snapshot.update.available.version}{" "}
                  disponível · Atualizar
                </button>
              ) : (
                <>
                  <LoaderCircle size={13} className="spin" />
                  <span>
                    {snapshot.update.status === "waiting"
                      ? `Atualiza para v${snapshot.update.available.version} quando as tarefas terminarem`
                      : `Abrindo a v${snapshot.update.available.version}…`}
                  </span>
                  {snapshot.update.status === "waiting" && (
                    <button
                      className="text-button"
                      onClick={() => void run(() => api("update.cancel"))}
                    >
                      Cancelar
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          <div className="local-label">
            <span className="status-dot" />
            Seu workspace local<span>v{appVersion}</span>
          </div>
        </div>
      </aside>
      <main className="main-shell">
        <header className="titlebar">
          <div className="title-context">
            {view === "workspace" && task ? (
              <>
                <h1
                  onDoubleClick={() => {
                    setTitle(task.title);
                    setModal("rename");
                  }}
                >
                  {task.title}
                </h1>
                <span>
                  {project ? (
                    <>
                      {project.name}
                      <span className="slash">/</span>
                      {task.worktree ? "worktree isolada" : "pasta original"}
                    </>
                  ) : (
                    "Conversa sem projeto"
                  )}
                  {task.parentId && (
                    <span className="linked"> · tarefa vinculada</span>
                  )}
                </span>
              </>
            ) : (
              <span className="title-subtle">
                {view === "board"
                  ? "Modo Multitarefa"
                  : view === "workspace"
                    ? "Seu próximo projeto começa aqui"
                    : view === "settings"
                      ? "Configurações"
                      : "Extensões do workspace"}
              </span>
            )}
          </div>
          <div className="title-actions">
            {task && view === "workspace" && (
              <>
                <button
                  className={`quiet compact ${hideContext ? "toggled" : ""}`}
                  aria-pressed={hideContext}
                  title="Mostra só a conversa, sem as execuções de ferramentas e aprovações respondidas"
                  onClick={() => {
                    localStorage.setItem(
                      "codebit.hideContext",
                      hideContext ? "0" : "1",
                    );
                    setHideContext(!hideContext);
                  }}
                >
                  {hideContext ? <Eye size={15} /> : <EyeOff size={15} />}
                  <span>
                    {hideContext ? "Mostrar contexto" : "Ocultar contexto"}
                  </span>
                </button>
                <button
                  className="quiet compact"
                  disabled={locked}
                  title="Continuar com outro agente"
                  onClick={() =>
                    void run(async () => {
                      setSummary(
                        await api("task.handoffSummary", { id: task.id }),
                      );
                      setNewAgent(
                        agentIds.find((a) => a !== task.agent) ?? "codex",
                      );
                      setModal("handoff");
                    })
                  }
                >
                  <ArrowRightLeft size={15} />
                  <span>Continuar com outro agente</span>
                </button>
                <button
                  className="icon"
                  title="Renomear tarefa"
                  onClick={() => {
                    setTitle(task.title);
                    setModal("rename");
                  }}
                  disabled={locked}
                >
                  <Pencil size={15} />
                </button>
                <button
                  className="icon"
                  title={task.archived ? "Restaurar tarefa" : "Arquivar tarefa"}
                  onClick={() =>
                    void run(() => patch({ archived: !task.archived }))
                  }
                  disabled={locked}
                >
                  <Archive size={16} />
                </button>
                <button
                  className="icon"
                  title="Alternar painel"
                  onClick={() => setPanel(!panel)}
                >
                  {panel ? (
                    <PanelRightClose size={18} />
                  ) : (
                    <PanelRightOpen size={18} />
                  )}
                </button>
              </>
            )}
            <div className="window-actions">
              <button
                aria-label="Minimizar"
                onClick={() => void api("window.minimize")}
              >
                <Minus size={15} />
              </button>
              <button
                aria-label="Maximizar"
                onClick={() => void api("window.maximize")}
              >
                <Maximize2 size={13} />
              </button>
              <button
                aria-label="Fechar"
                onClick={() => void api("window.close")}
              >
                <X size={18} />
              </button>
            </div>
          </div>
        </header>
        {view === "board" && snapshot ? (
          <Board
            cards={board}
            snapshot={snapshot}
            run={run}
            onOpen={openTask}
          />
        ) : view !== "workspace" ? (
          <SettingsView
            snapshot={snapshot}
            extensionsOnly={view === "extensions"}
            task={task}
            refresh={refresh}
            run={run}
            invokeSkill={(name) => {
              // Same syntax the "/" palette inserts for each agent.
              setDraft(
                `${task?.agent === "codex" ? "$" : "/"}${name} ${draft}`,
              );
              setView("workspace");
            }}
          />
        ) : !task ? (
          <div className="welcome">
            <div className="welcome-mark">
              <Code2 size={42} />
            </div>
            <span className="eyebrow">UM WORKSPACE. SEUS AGENTES.</span>
            <h2>O que vamos construir?</h2>
            <p>
              Codex, Claude e Devin, no mesmo lugar.
              <br />
              Seu código, suas ferramentas e seus modelos de imagem.
            </p>
            <div className="button-row">
              <button className="primary" onClick={() => void run(addProject)}>
                <FolderOpen size={18} />
                Abrir um projeto
              </button>
              <button className="quiet" onClick={() => newTask("")}>
                <MessageSquare size={17} />
                Conversa sem projeto
              </button>
            </div>
            <div className="welcome-providers">
              {snapshot?.agents.map((a) => (
                <span key={a.id}>
                  <span
                    className={`status-dot ${a.selected ? "" : "muted-dot"}`}
                  />
                  {a.name}
                  <small>{a.selected ? "Detectado" : "Não encontrado"}</small>
                </span>
              ))}
            </div>
            <button className="text-button" onClick={() => setView("settings")}>
              Configurar agentes e imagens <ChevronRight size={14} />
            </button>
          </div>
        ) : (
          <div className={`workspace ${panel ? "" : "no-panel"}`}>
            <section className="chat">
              {!trusted && (
                <div className="trust-banner">
                  <ShieldCheck size={19} />
                  <div>
                    <strong>Confie nesta pasta para começar</strong>
                    <p>
                      Os CLIs poderão carregar instruções, hooks e servidores
                      MCP deste projeto.
                    </p>
                  </div>
                  <button
                    className="quiet"
                    onClick={() =>
                      void run(() =>
                        api("project.trust", {
                          id: project?.id,
                          trusted: true,
                        }),
                      )
                    }
                  >
                    Confiar no projeto
                  </button>
                </div>
              )}
              <div
                className="messages"
                ref={list}
                onScroll={() => {
                  const el = list.current!;
                  stickBottom.current =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 120;
                }}
              >
                {!entries.length && (
                  <div className="conversation-empty">
                    <Code2 size={31} />
                    <h2>
                      {project
                        ? `Vamos trabalhar em ${project.name}.`
                        : "Uma conversa livre."}
                    </h2>
                    <p>
                      Descreva uma mudança, peça uma revisão ou crie uma imagem.
                      <br />
                      {project
                        ? "O agente usará a pasta deste projeto."
                        : "Sem projeto, o agente usa uma pasta própria do Codebit."}
                    </p>
                    <div className="suggestions">
                      {(project
                        ? [
                            "Explore o projeto e explique sua estrutura.",
                            "Revise o código e identifique melhorias.",
                          ]
                        : [
                            "Me ajude a planejar uma nova ideia.",
                            "Crie um script pequeno para automatizar uma tarefa.",
                          ]
                      ).map((s) => (
                        <button key={s} onClick={() => setDraft(s)}>
                          {s}
                          <ArrowUp size={14} />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {visibleEntries.map((e) => (
                  <EntryView
                    key={e.id}
                    entry={e}
                    agent={task.agent}
                    taskId={task.id}
                    artifact={
                      e.artifactId
                        ? artifacts.find((a) => a.id === e.artifactId)
                        : undefined
                    }
                    run={run}
                    onImage={onImage}
                    onImageLoad={onImageLoad}
                    onOpenImage={openImage}
                  />
                ))}
                {task.status === "running" && (
                  <div className="working">
                    <LoaderCircle size={15} className="spin" />O agente está
                    trabalhando…
                  </div>
                )}
                {task.status === "idle" && !!task.background && (
                  <div className="working">
                    <LoaderCircle size={15} className="spin" />
                    {task.background === 1
                      ? "1 comando ou sub-agente segue"
                      : `${task.background} comandos ou sub-agentes seguem`}{" "}
                    em segundo plano. A sessão fica aberta até terminarem.
                    <button
                      className="text-button"
                      onClick={() =>
                        void run(() => api("task.interrupt", { id: task.id }))
                      }
                    >
                      Interromper
                    </button>
                  </div>
                )}
                {imageProgress && (
                  <div className="working">
                    <LoaderCircle size={15} className="spin" />
                    {imageProgress}
                    <button
                      className="text-button"
                      onClick={() =>
                        void run(() => api("images.cancel", { id: task.id }))
                      }
                    >
                      Cancelar
                    </button>
                  </div>
                )}
                <div ref={bottom} />
              </div>
              <div className="composer-wrap">
                <QueuePanel task={task} run={run} notify={setError} />
                {task.images.inputImage && (
                  <div className="input-image-tag">
                    <ImageIcon size={13} />
                    Imagem de referência selecionada
                    <button
                      className="icon"
                      title="Remover imagem de referência"
                      onClick={() => void run(() => selectInputImage())}
                    >
                      <X size={13} />
                    </button>
                  </div>
                )}
                {attachments.length > 0 && (
                  <div className="attachment-row">
                    {attachments.map((a) => (
                      <span className="attachment" key={a}>
                        {fileName(a)}
                        {/\.(png|jpe?g|webp)$/i.test(a) && (
                          <button
                            className="icon"
                            title="Usar imagem para edição"
                            onClick={() => void run(() => selectInputImage(a))}
                          >
                            <Pencil size={12} />
                          </button>
                        )}
                        <button
                          className="icon"
                          onClick={() =>
                            setAttachments(attachments.filter((x) => x !== a))
                          }
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {paletteOpen && (
                  <CommandPalette
                    agent={task.agent}
                    loading={commands.key !== commandKey || !commands.list}
                    error={commands.error}
                    trusted={trusted}
                    matches={matches}
                    index={paletteIndex}
                    onHover={setPaletteIndex}
                    onChoose={chooseCommand}
                    onRefresh={() => {
                      setCommands({ key: commandKey });
                      void loadCommands(true);
                    }}
                  />
                )}
                <div className="composer">
                  <textarea
                    aria-label="Mensagem"
                    placeholder={
                      active
                        ? "Escreva a próxima mensagem; ela entra na fila…"
                        : task.mode === "plan"
                          ? "O que você quer planejar?"
                          : "Peça uma alteração ou digite / para skills e comandos…"
                    }
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onPaste={(e) => {
                      const images = [...e.clipboardData.files].filter((f) =>
                        f.type.startsWith("image/"),
                      );
                      if (!images.length) return;
                      // Keep text pasted together with an image (e.g. from a page).
                      if (!e.clipboardData.getData("text/plain"))
                        e.preventDefault();
                      void run(() => pasteImages(images));
                    }}
                    onKeyDown={(e) => {
                      if (paletteOpen && matches.length) {
                        const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
                        if (move) {
                          e.preventDefault();
                          setPaletteIndex(
                            (paletteIndex + move + matches.length) %
                              matches.length,
                          );
                          return;
                        }
                        if (
                          e.key === "Tab" ||
                          (e.key === "Enter" && !e.shiftKey)
                        ) {
                          e.preventDefault();
                          chooseCommand(matches[paletteIndex] ?? matches[0]);
                          return;
                        }
                      }
                      if (paletteOpen && e.key === "Escape") {
                        e.preventDefault();
                        setPaletteClosed(true);
                        return;
                      }
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void run(submit);
                      }
                    }}
                  />
                  <div className="composer-buttons">
                    <button
                      className="icon"
                      title="Anexar arquivos"
                      onClick={() =>
                        void run(async () => {
                          const a = await api<string[]>("attachments.add", {
                            id: task.id,
                          });
                          setAttachments([...attachments, ...a].slice(0, 10));
                        })
                      }
                    >
                      <Paperclip size={20} />
                    </button>
                    <span className="composer-hint">
                      {active ? "Enter adiciona à fila" : "Enter para enviar"} ·
                      Shift + Enter para nova linha
                    </span>
                    <button
                      className="quiet compact"
                      disabled={!draft.trim() || !!imageProgress}
                      title="Gerar imagem diretamente com o modelo selecionado"
                      onClick={() => void run(generateImage)}
                    >
                      <ImageIcon size={15} />
                      Gerar imagem
                    </button>
                    {active && (
                      <button
                        className="send queue"
                        title="Adicionar à fila"
                        aria-label="Adicionar à fila"
                        disabled={
                          submitting || (!draft.trim() && !attachments.length)
                        }
                        onClick={() => void run(submit)}
                      >
                        <ListPlus size={19} />
                      </button>
                    )}
                    {active ? (
                      <button
                        className="send stop"
                        title="Interromper"
                        aria-label="Interromper"
                        onClick={() =>
                          void run(() => api("task.interrupt", { id: task.id }))
                        }
                      >
                        <Square size={16} />
                      </button>
                    ) : (
                      <button
                        className="send"
                        title="Enviar mensagem"
                        aria-label="Enviar mensagem"
                        disabled={
                          submitting ||
                          (!draft.trim() && !attachments.length) ||
                          !trusted
                        }
                        onClick={() => void run(submit)}
                      >
                        <ArrowUp size={21} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="composer-toolbar">
                  <div className="selector-group">
                    <span className="tiny-label">
                      Agente · modelo
                      {selectedInfo?.catalogStatus === "loading" &&
                        " · carregando…"}
                    </span>
                    <div className="selector-row">
                      <select
                        aria-label="Agente"
                        className="agent-select"
                        title="Trocar de agente mantém esta conversa"
                        disabled={locked}
                        value={task.agent}
                        onChange={(e) =>
                          void run(() =>
                            patch({ agent: e.target.value as AgentId }),
                          )
                        }
                      >
                        {agentIds.map((id) => (
                          <option
                            key={id}
                            value={id}
                            disabled={
                              !snapshot?.agents.find((a) => a.id === id)
                                ?.selected
                            }
                          >
                            {agentNames[id]}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label="Modelo do agente"
                        title={
                          selectedModel?.description ||
                          "Selecione um modelo disponível no CLI"
                        }
                        disabled={locked}
                        value={task.model}
                        onChange={(e) => {
                          if (e.target.value === "__manual") {
                            setTitle(task.model);
                            setModal("model");
                          } else
                            void run(() => patch({ model: e.target.value }));
                        }}
                      >
                        <option value="">Padrão do CLI</option>
                        {selectedInfo?.catalogStatus === "loading" && (
                          <option disabled>Carregando modelos…</option>
                        )}
                        {selectedInfo?.catalogStatus === "error" && (
                          <option disabled>
                            Catálogo indisponível · atualize ↻
                          </option>
                        )}
                        {selectedInfo?.models.map((m) => (
                          <option key={m.id} value={m.id} title={m.description}>
                            {m.name}
                            {m.resolvedModel ? ` · ${m.resolvedModel}` : ""}
                          </option>
                        ))}
                        {task.model &&
                          !selectedInfo?.models.some(
                            (m) => m.id === task.model,
                          ) && (
                            <option value={task.model}>
                              {task.model} · manual
                            </option>
                          )}
                        <option value="__manual">Informar modelo…</option>
                      </select>
                      <button
                        className="catalog-refresh icon-button"
                        aria-label="Atualizar modelos do agente"
                        title={
                          selectedInfo?.catalogError ||
                          "Atualizar modelos disponíveis"
                        }
                        disabled={
                          locked ||
                          !selectedInfo?.selected ||
                          selectedInfo.catalogStatus === "loading"
                        }
                        onClick={() =>
                          void run(() => api("auth", { agent: task.agent }))
                        }
                      >
                        <RefreshCw
                          size={13}
                          className={
                            selectedInfo?.catalogStatus === "loading"
                              ? "spin"
                              : undefined
                          }
                        />
                      </button>
                    </div>
                  </div>
                  <div className="selector-group effort-selector">
                    <span className="tiny-label">Esforço</span>
                    <div className="selector-row">
                      <select
                        aria-label="Esforço do agente"
                        title={
                          !task.model
                            ? "Selecione um modelo para escolher o esforço"
                            : !efforts.length
                              ? "O CLI não informou níveis de esforço para este modelo"
                              : "Nível de raciocínio usado nas próximas mensagens"
                        }
                        disabled={
                          locked ||
                          !efforts.length ||
                          selectedInfo?.catalogStatus === "loading"
                        }
                        value={task.effort || ""}
                        onChange={(e) =>
                          void run(() => patch({ effort: e.target.value }))
                        }
                      >
                        <option value="">
                          {!task.model
                            ? "Escolha um modelo"
                            : !efforts.length
                              ? "Padrão do CLI"
                              : selectedModel?.defaultEffort
                                ? `Padrão · ${effortLabel(selectedModel.defaultEffort)}`
                                : "Padrão do CLI"}
                        </option>
                        {efforts.map((effort) => (
                          <option key={effort} value={effort}>
                            {effortLabel(effort)} · {effort}
                          </option>
                        ))}
                        {task.effort && !efforts.includes(task.effort) && (
                          <option value={task.effort}>
                            {effortLabel(task.effort)} · indisponível
                          </option>
                        )}
                      </select>
                    </div>
                  </div>
                  <div className="selector-group images-selector">
                    <span className="tiny-label">Imagens</span>
                    <div className="selector-row">
                      <select
                        aria-label="Provedor de imagem"
                        disabled={locked || !!imageProgress}
                        value={task.images.provider}
                        onChange={(e) =>
                          void run(() =>
                            patch({
                              images: {
                                ...task.images,
                                provider: e.target.value as any,
                                model:
                                  e.target.value === "codex"
                                    ? "gpt-image"
                                    : e.target.value === "openai"
                                      ? "gpt-image-2.5-flare"
                                      : "",
                                inputImage: undefined,
                                workflow: "sdxl-text",
                              },
                            }),
                          )
                        }
                      >
                        <option value="codex">Codex · Login local</option>
                        <option value="openai">OpenAI · Chave da API</option>
                        <option value="comfyui">ComfyUI · Local</option>
                      </select>
                      <select
                        aria-label="Modelo de imagem"
                        value={task.images.model + "|" + task.images.workflow}
                        disabled={locked || !!imageProgress}
                        onChange={(e) => {
                          const [model, workflow] = e.target.value.split("|");
                          void run(() =>
                            patch({
                              images: {
                                ...task.images,
                                model,
                                workflow: workflow || "sdxl-text",
                              },
                            }),
                          );
                        }}
                      >
                        <option
                          value={task.images.model + "|" + task.images.workflow}
                        >
                          {imageModels.find(
                            (m) =>
                              m.id === task.images.model &&
                              (m.workflow || "sdxl-text") ===
                                task.images.workflow,
                          )?.name ||
                            task.images.model ||
                            "Selecionar modelo"}
                        </option>
                        {imageModels.map((m) => (
                          <option
                            key={m.id + "|" + m.workflow}
                            value={m.id + "|" + (m.workflow || "sdxl-text")}
                            disabled={!m.available}
                          >
                            {m.name}
                            {!m.available ? " · configurar" : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="selector-group subagents-selector">
                    <span className="tiny-label">Sub-agentes</span>
                    <div className="selector-row">
                      <button
                        className={`subagents-toggle ${subagents.enabled ? "on" : ""}`}
                        aria-label="Configurar sub-agentes"
                        aria-expanded={subagentsOpen}
                        disabled={locked}
                        onClick={() => setSubagentsOpen(!subagentsOpen)}
                      >
                        <Users size={14} />
                        {subagents.enabled
                          ? `${agentNames[subagents.agent]} · ${subagents.max}`
                          : "Desligados"}
                      </button>
                    </div>
                    {subagentsOpen && !active && (
                      <div
                        className="subagents-popover"
                        role="dialog"
                        aria-label="Sub-agentes"
                      >
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            checked={subagents.enabled}
                            onChange={(e) =>
                              void run(() =>
                                patchSubagents({ enabled: e.target.checked }),
                              )
                            }
                          />
                          Permitir que o agente delegue a sub-agentes
                        </label>
                        <label>
                          CLI
                          <select
                            aria-label="CLI dos sub-agentes"
                            value={subagents.agent}
                            onChange={(e) => {
                              const agent = e.target.value as AgentId;
                              void run(() =>
                                patchSubagents({
                                  agent,
                                  model:
                                    snapshot?.settings.defaultModels[agent] ??
                                    "",
                                  effort: "",
                                }),
                              );
                            }}
                          >
                            {agentIds.map((id) => (
                              <option
                                key={id}
                                value={id}
                                disabled={
                                  !snapshot?.agents.find((a) => a.id === id)
                                    ?.selected
                                }
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
                            value={subagents.model}
                            onChange={(e) =>
                              void run(() =>
                                patchSubagents({
                                  model: e.target.value,
                                  effort: "",
                                }),
                              )
                            }
                          >
                            <option value="">Padrão do CLI</option>
                            {subagentInfo?.models.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name}
                              </option>
                            ))}
                            {subagents.model && !subagentModel && (
                              <option value={subagents.model}>
                                {subagents.model} · manual
                              </option>
                            )}
                          </select>
                        </label>
                        {!!subagentModel?.efforts?.length && (
                          <label>
                            Esforço
                            <select
                              aria-label="Esforço dos sub-agentes"
                              value={subagents.effort}
                              onChange={(e) =>
                                void run(() =>
                                  patchSubagents({ effort: e.target.value }),
                                )
                              }
                            >
                              <option value="">Padrão do modelo</option>
                              {subagentModel.efforts.map((effort) => (
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
                            value={subagents.max}
                            onChange={(e) => {
                              const max = Math.min(
                                8,
                                Math.max(1, Math.round(+e.target.value || 1)),
                              );
                              void run(() => patchSubagents({ max }));
                            }}
                          />
                        </label>
                        <p className="help">
                          {task.agent === "devin"
                            ? "O Devin CLI ainda não usa ferramentas MCP do Codebit como agente principal. Escolha Codex ou Claude para delegar; o Devin funciona como sub-agente."
                            : "O agente principal recebe a ferramenta run_subagents. Os sub-agentes trabalham na mesma pasta e seguem o modo da tarefa."}
                        </p>
                      </div>
                    )}
                  </div>
                  <div className="mode-toggle">
                    <button
                      className={task.mode === "plan" ? "selected" : ""}
                      disabled={locked}
                      onClick={() => void run(() => patch({ mode: "plan" }))}
                    >
                      Planejar
                    </button>
                    <button
                      className={task.mode === "execute" ? "selected" : ""}
                      disabled={locked}
                      onClick={() => void run(() => patch({ mode: "execute" }))}
                    >
                      Executar
                    </button>
                    <button
                      className={`bypass ${task.mode === "bypass" ? "selected" : ""}`}
                      disabled={locked}
                      title="Executa comandos e altera arquivos sem pedir permissão. Use apenas em projetos em que você confia."
                      onClick={() => void run(() => patch({ mode: "bypass" }))}
                    >
                      Bypass
                    </button>
                  </div>
                </div>
              </div>
            </section>
            {panel && (
              <MemoInspector
                task={task}
                artifacts={artifacts}
                selectedArtifact={selectedArtifact}
                setSelectedArtifact={setSelectedArtifact}
                openedImage={openedImage}
                setOpenedImage={setOpenedImage}
                tab={tab}
                setTab={setTab}
                patch={patch}
                run={run}
                setDraft={setDraft}
                imageProgress={imageProgress}
              />
            )}
          </div>
        )}
        <footer className="statusbar">
          <span>
            <span
              className={`status-dot ${task?.status === "waiting" ? "amber" : task?.status === "failed" ? "red" : ""}`}
            />
            {view === "workspace" && task ? statusName(task) : "Pronto"}
          </span>
          {task && view === "workspace" && (
            <>
              <span className="status-divider" />
              <button
                onClick={() =>
                  void run(() => api("folder.open", { id: task.id }))
                }
              >
                <Folder size={13} />
                {project
                  ? `${project.name} / ${task.worktree ? "worktree isolada" : "pasta original"}`
                  : "Pasta da conversa"}
              </button>
              <span className="status-spacer" />
              {selectedInfo && <QuotaMeter info={selectedInfo} run={run} />}
              <span className="status-divider" />
              <ContextMeter task={task} model={selectedModel} />
              <span className="status-divider" />
              <span>{agentNames[task.agent]}</span>
              <span className="status-divider" />
              <span>
                {imageProviderNames[task.images.provider]} ·{" "}
                {task.images.model || "Configurar imagens"}
              </span>
            </>
          )}
        </footer>
      </main>
      {error && (
        <div className="toast" role="alert">
          <CircleAlert size={19} />
          <span>{error}</span>
          <button
            className="icon"
            onClick={() => setError("")}
            aria-label="Fechar aviso"
          >
            <X size={17} />
          </button>
        </div>
      )}
      {quickOpen && (
        <QuickPanel
          selected={quickSelected}
          onSelect={setQuickSelected}
          onClose={closeQuick}
          onOpenTask={keptQuick}
          run={run}
        />
      )}
      {promptForm && snapshot && (
        <PromptModal
          key={promptForm === "new" ? "new" : promptForm.id}
          prompt={promptForm === "new" ? undefined : promptForm}
          projects={snapshot.projects}
          onClose={() => setPromptForm(undefined)}
          run={run}
        />
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <form
            className={`modal ${modal === "handoff" ? "wide" : ""}`}
            onSubmit={(e) => {
              e.preventDefault();
              void run(saveModal);
            }}
          >
            <div className="modal-header">
              <h2>
                {modal === "new"
                  ? "Nova tarefa"
                  : modal === "rename"
                    ? "Renomear tarefa"
                    : modal === "model"
                      ? "Selecionar modelo manualmente"
                      : "Continuar com outro agente"}
              </h2>
              <button
                type="button"
                className="icon"
                onClick={() => setModal(null)}
              >
                <X size={19} />
              </button>
            </div>
            {modal === "new" && (
              <>
                <label>
                  Projeto
                  <select
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                  >
                    <option value="">Sem projeto · conversa</option>
                    {snapshot?.projects.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Título
                  <input
                    autoFocus
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="O que vamos construir?"
                  />
                </label>
                <label>
                  Agente
                  <AgentSelect value={newAgent} onChange={setNewAgent} />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={!!projectId && worktree}
                    disabled={
                      !snapshot?.projects.find((p) => p.id === projectId)?.git
                    }
                    onChange={(e) => setWorktree(e.target.checked)}
                  />
                  Criar worktree isolada
                </label>
                <p className="help">
                  {!projectId
                    ? "A conversa usará uma pasta própria do Codebit, sem vínculo com projetos."
                    : worktree
                      ? "A worktree parte do commit atual. Alterações ainda não commitadas ficam na pasta original."
                      : "A tarefa trabalhará diretamente na pasta original do projeto."}
                </p>
              </>
            )}
            {modal === "rename" && (
              <label>
                Título
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  autoFocus
                />
              </label>
            )}
            {modal === "model" && (
              <>
                <label>
                  Identificador do modelo
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    required
                    autoFocus
                    placeholder="Identificador aceito pelo CLI"
                  />
                </label>
                <p className="help">
                  A disponibilidade será verificada pelo agente na próxima
                  execução. Para consultar o catálogo antes de executar, use
                  Verificar acesso em Configurações.
                </p>
              </>
            )}
            {modal === "handoff" && (
              <>
                <p className="help">
                  Uma nova tarefa receberá o contexto abaixo. A conversa
                  original será preservada.
                </p>
                <label>
                  Novo agente
                  <AgentSelect value={newAgent} onChange={setNewAgent} />
                </label>
                <label>
                  Contexto transferido
                  <textarea
                    className="handoff-text"
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                  />
                </label>
              </>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="quiet"
                onClick={() => setModal(null)}
              >
                Cancelar
              </button>
              <button className="primary" type="submit">
                {modal === "handoff"
                  ? "Criar tarefa vinculada"
                  : modal === "new"
                    ? "Criar tarefa"
                    : "Salvar"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
// Plan usage of the task's agent, read from its CLI.
function QuotaMeter({ info, run }: { info: AgentInfo; run: any }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const load = (refresh: boolean) => {
    setLoading(true);
    return api("agent.quota", { agent: info.id, refresh }).finally(() =>
      setLoading(false),
    );
  };
  useEffect(() => {
    if (info.selected) void load(false).catch(() => {});
  }, [info.id, !!info.selected]);
  const quota = info.quota;
  const top = Math.max(0, ...(quota?.windows ?? []).map((w) => w.usedPercent));
  const level = top >= 90 ? "high" : top >= 70 ? "mid" : "";
  return (
    <span className="quota">
      <button
        className={`quota-meter ${level}`}
        aria-expanded={open}
        title="Uso do plano do agente"
        onClick={() => setOpen(!open)}
      >
        <Gauge size={13} />
        {quota?.windows.length
          ? `Cota: ${Math.round(top)}% usada`
          : quota
            ? `Plano: ${quota.plan ?? "sem dados"}`
            : info.quotaError
              ? "Cota indisponível"
              : "Cota…"}
      </button>
      {open && (
        <div
          className="quota-popover"
          role="dialog"
          aria-label="Cota do agente"
        >
          <div className="quota-head">
            <strong>
              {agentNames[info.id]}
              {quota?.plan ? ` · ${quota.plan}` : ""}
            </strong>
            <button
              className="icon"
              title="Atualizar"
              aria-label="Atualizar cota"
              onClick={() => void run(() => load(true))}
            >
              <RefreshCw size={13} className={loading ? "spin" : undefined} />
            </button>
          </div>
          {quota?.windows.map((w) => (
            <div className="quota-window" key={w.label}>
              <span>{w.label}</span>
              <span className="meter">
                <span
                  className={
                    w.usedPercent >= 90
                      ? "high"
                      : w.usedPercent >= 70
                        ? "mid"
                        : ""
                  }
                  style={{ width: `${Math.min(100, w.usedPercent)}%` }}
                />
              </span>
              <small>
                {Math.round(w.usedPercent)}% usado
                {w.resetsAt
                  ? ` · renova ${new Date(w.resetsAt * 1000).toLocaleString(
                      "pt-BR",
                      {
                        weekday: "short",
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      },
                    )}`
                  : ""}
              </small>
            </div>
          ))}
          {quota?.note && <p className="help">{quota.note}</p>}
          {info.quotaError && <p className="help">{info.quotaError}</p>}
          {quota && (
            <small>
              Consultado às{" "}
              {new Date(quota.checkedAt).toLocaleTimeString("pt-BR", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </small>
          )}
        </div>
      )}
    </span>
  );
}
function CommandPalette({
  agent,
  loading,
  error,
  trusted,
  matches,
  index,
  onHover,
  onChoose,
  onRefresh,
}: {
  agent: AgentId;
  loading: boolean;
  error?: string;
  trusted: boolean;
  matches: AgentCommand[];
  index: number;
  onHover: (index: number) => void;
  onChoose: (command: AgentCommand) => void;
  onRefresh: () => void;
}) {
  const selected = useRef<HTMLButtonElement>(null);
  useEffect(
    () => selected.current?.scrollIntoView({ block: "nearest" }),
    [index],
  );
  return (
    <div
      className="command-palette"
      role="listbox"
      aria-label="Skills e comandos"
    >
      <div className="command-palette-head">
        <span>Skills e comandos · {agentNames[agent]}</span>
        <button
          className="icon"
          title="Atualizar lista"
          aria-label="Atualizar skills e comandos"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onRefresh}
        >
          <RefreshCw size={13} className={loading ? "spin" : undefined} />
        </button>
      </div>
      {!trusted ? (
        <p className="help">Confie no projeto para listar as skills dele.</p>
      ) : loading ? (
        <p className="help">Consultando o CLI…</p>
      ) : error ? (
        <p className="help">{error}</p>
      ) : !matches.length ? (
        <p className="help">Nenhuma skill ou comando encontrado.</p>
      ) : (
        matches.map((c, i) => (
          <button
            key={c.kind + c.name}
            ref={i === index ? selected : undefined}
            role="option"
            aria-selected={i === index}
            className={`command-item ${i === index ? "selected" : ""}`}
            // Keep focus in the message field while choosing.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onHover(i)}
            onClick={() => onChoose(c)}
          >
            <strong>
              {agent === "codex" ? "$" : "/"}
              {c.name}
            </strong>
            {c.hint && <code>{c.hint}</code>}
            <span className="badge">
              {c.kind === "skill" ? "skill" : "comando"}
            </span>
            <small>{c.description}</small>
          </button>
        ))
      )}
    </div>
  );
}
// Chat rows re-render only when their own content changes, so typing in a
// long conversation does not re-render every message.
const EntryView = memo(
  function EntryView({
    entry: e,
    agent,
    taskId,
    artifact,
    run,
    onImage,
    onImageLoad,
    onOpenImage,
  }: {
    entry: Entry;
    agent: AgentId;
    taskId: string;
    artifact?: Artifact;
    run: <T>(work: () => Promise<T>) => Promise<T | undefined>;
    onImage: (action: "open" | "edit", artifactId: string) => void;
    onImageLoad: () => void;
    // Opens an image file mentioned in the chat in the side panel.
    onOpenImage: (path: string) => void;
  }) {
    return (
      <div className={`entry entry-${e.kind}`}>
        {["user", "assistant"].includes(e.kind) && (
          <>
            <div
              className={`avatar ${e.kind === "assistant" ? "agent-avatar" : ""}`}
            >
              {e.kind === "user" ? (
                "V"
              ) : (e.agent ?? agent) === "codex" ? (
                <Code2 size={18} />
              ) : (
                agentNames[e.agent ?? agent][0]
              )}
            </div>
            <div className="entry-body">
              <div className="entry-meta">
                <strong>
                  {e.kind === "user" ? "Você" : agentNames[e.agent ?? agent]}
                </strong>
                <time>
                  {new Date(e.createdAt).toLocaleTimeString("pt-BR", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <div className="markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkImagePaths]}
                  urlTransform={markdownUrl}
                  components={{
                    a: ({ href, children }) => {
                      const image = linkedImage(href);
                      return (
                        <a
                          href="#"
                          className={image ? "file-link" : undefined}
                          title={image ? "Abrir no painel lateral" : href}
                          onClick={(ev) => {
                            ev.preventDefault();
                            if (image) onOpenImage(image);
                            else if (href)
                              void run(() =>
                                api("external.open", { url: href }),
                              );
                          }}
                        >
                          {children}
                        </a>
                      );
                    },
                    // Local images show in the chat through Codebit.
                    img: ({ src, alt }) => {
                      const path =
                        typeof src === "string" ? linkedImage(src) : undefined;
                      return path ? (
                        <img
                          className="chat-image"
                          src={fileUrl(taskId, path)}
                          alt={alt ?? ""}
                          title="Abrir no painel lateral"
                          onClick={() => onOpenImage(path)}
                        />
                      ) : (
                        <img src={src} alt={alt ?? ""} />
                      );
                    },
                  }}
                >
                  {e.text || "…"}
                </ReactMarkdown>
              </div>
              {e.attachments?.map((a) =>
                isImagePath(a) ? (
                  <a
                    key={a}
                    href="#"
                    className="attachment"
                    title="Abrir no painel lateral"
                    onClick={(ev) => {
                      ev.preventDefault();
                      onOpenImage(a);
                    }}
                  >
                    <ImageIcon size={12} />
                    {fileName(a)}
                  </a>
                ) : (
                  <span key={a} className="attachment">
                    <Paperclip size={12} />
                    {fileName(a)}
                  </span>
                ),
              )}
            </div>
          </>
        )}
        {e.kind === "activity" && (
          <>
            <span className="activity-icon">
              <Check size={12} />
            </span>
            <span>
              <LinkedText text={e.text} onOpen={onOpenImage} />
            </span>
          </>
        )}
        {e.kind === "warning" && (
          <div className="warning-card" role="status">
            <TriangleAlert size={18} />
            <div>
              <strong>Conflito com outra conversa</strong>
              <p>{e.text}</p>
            </div>
          </div>
        )}
        {e.kind === "error" && (
          <div className="error-card">
            <CircleAlert size={18} />
            <div>
              <strong>A execução precisa de atenção</strong>
              <p>{e.text}</p>
            </div>
          </div>
        )}
        {e.kind === "request" && e.request && (
          <RequestCard entry={e} taskId={taskId} run={run} />
        )}
        {e.kind === "image" &&
          (() => {
            const a = artifact;
            return a ? (
              <div className="image-message">
                <img
                  src={artifactUrl(a.id)}
                  alt={a.prompt}
                  // Images grow the chat after the first scroll.
                  onLoad={onImageLoad}
                  onClick={() => onImage("open", a.id)}
                />
                <div className="image-caption">
                  <div>
                    <strong>imagem-{a.id.slice(0, 8)}.png</strong>
                    <span>
                      {imageProviderNames[a.provider]} · {a.model}
                    </span>
                  </div>
                  <button
                    className="quiet compact"
                    onClick={() => onImage("edit", a.id)}
                  >
                    <Pencil size={13} />
                    Editar
                  </button>
                  <button
                    className="quiet compact"
                    onClick={() =>
                      void run(() => api("images.export", { id: a.id }))
                    }
                  >
                    <Download size={13} />
                    Exportar
                  </button>
                </div>
              </div>
            ) : null;
          })()}
      </div>
    );
  },
  (a, b) =>
    a.entry.id === b.entry.id &&
    a.entry.text === b.entry.text &&
    a.entry.resolved === b.entry.resolved &&
    a.entry.agent === b.entry.agent &&
    a.agent === b.agent &&
    a.taskId === b.taskId &&
    a.artifact?.id === b.artifact?.id,
);
function AgentSelect({
  value,
  onChange,
}: {
  value: AgentId;
  onChange: (agent: AgentId) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as AgentId)}>
      {agentIds.map((id) => (
        <option key={id} value={id}>
          {agentNames[id]}
        </option>
      ))}
    </select>
  );
}
// Messages waiting to be sent after the current response.
function QueuePanel({
  task,
  run,
  notify,
}: {
  task: Task;
  run: any;
  notify: (message: string) => void;
}) {
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const [dragged, setDragged] = useState("");
  const queue = task.queue ?? [];
  if (!queue.length) return null;
  const items = queue.map(({ id, text }) => ({ id, text }));
  const save = (next: typeof items) =>
    run(() => api("task.queue", { id: task.id, items: next }));
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= items.length) return;
    const next = [...items];
    next.splice(to, 0, ...next.splice(from, 1));
    void save(next);
  };
  return (
    <div className="queue-panel" role="list" aria-label="Fila de mensagens">
      <div className="queue-head">
        <ListOrdered size={14} />
        <strong>Fila · {queue.length}</strong>
        <small>Enviadas em ordem quando o agente terminar.</small>
      </div>
      {queue.map((q, i) => (
        <div
          key={q.id}
          role="listitem"
          className={`queue-item ${dragged === q.id ? "dragging" : ""}`}
          draggable={editing?.id !== q.id}
          onDragStart={() => setDragged(q.id)}
          onDragEnd={() => setDragged("")}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            move(
              items.findIndex((x) => x.id === dragged),
              i,
            );
            setDragged("");
          }}
        >
          <span className="queue-index">{i + 1}</span>
          {editing?.id === q.id ? (
            <textarea
              aria-label="Editar mensagem da fila"
              autoFocus
              rows={2}
              value={editing.text}
              onChange={(e) => setEditing({ ...editing, text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(undefined);
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void save(
                    items.map((x) =>
                      x.id === q.id ? { ...x, text: editing.text } : x,
                    ),
                  ).then(() => setEditing(undefined));
                }
              }}
            />
          ) : (
            <p title={q.text}>
              {q.text || "Somente anexos"}
              {q.attachments.length > 0 && (
                <span className="queue-attachments">
                  <Paperclip size={11} />
                  {q.attachments.length}
                </span>
              )}
            </p>
          )}
          <div className="queue-actions">
            <button
              className="icon"
              title="Enviar agora"
              aria-label="Enviar agora"
              onClick={() =>
                void run(async () => {
                  const result = await api<string>("task.sendQueued", {
                    id: task.id,
                    itemId: q.id,
                  });
                  if (result === "next")
                    notify(
                      `${agentNames[task.agent]} responde uma mensagem por vez. Ela será enviada assim que a resposta atual terminar.`,
                    );
                })
              }
            >
              <ArrowUp size={14} />
            </button>
            <button
              className="icon"
              title="Mover para cima"
              aria-label="Mover para cima"
              disabled={i === 0}
              onClick={() => move(i, i - 1)}
            >
              <ChevronUp size={14} />
            </button>
            <button
              className="icon"
              title="Mover para baixo"
              aria-label="Mover para baixo"
              disabled={i === queue.length - 1}
              onClick={() => move(i, i + 1)}
            >
              <ChevronDown size={14} />
            </button>
            <button
              className="icon"
              title="Editar"
              aria-label="Editar"
              onClick={() => setEditing({ id: q.id, text: q.text })}
            >
              <Pencil size={13} />
            </button>
            <button
              className="icon"
              title="Remover da fila"
              aria-label="Remover da fila"
              onClick={() => void save(items.filter((x) => x.id !== q.id))}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
function TaskItem({
  task,
  selected,
  icon,
  onSelect,
}: {
  task: Task;
  selected: boolean;
  icon: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      className={`task-item ${selected ? "selected" : ""}`}
      onClick={onSelect}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(taskMime, task.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      {icon}
      <span>{task.title}</span>
      {["running", "waiting", "queued"].includes(task.status) && (
        <span
          className={`status-dot ${task.status === "waiting" ? "amber" : ""}`}
        />
      )}
    </button>
  );
}
