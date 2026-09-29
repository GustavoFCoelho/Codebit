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
  Trash2,
  X,
  Minus,
  Maximize2,
  Archive,
  ArchiveRestore,
  PanelRightClose,
  PanelRightOpen,
  ArrowRightLeft,
  Image as ImageIcon,
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
  ListTodo,
  ArrowLeft,
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
  subagentsFor,
} from "../shared/types";
import { api, artifactUrl, fileName, fileUrl, readBase64 } from "./api";
import {
  ActivityIcon,
  AgentMark,
  ContextMeter,
  RequestCard,
  SectionLabel,
  statusName,
  statusNames,
  SubagentOptionsForm,
} from "./parts";
import { effortLabel } from "../shared/models";
import { SettingsView } from "./Settings";
import { PromptList, PromptModal, QuickPanel } from "./Prompts";
import {
  isImagePath,
  linkedImage,
  linkMenu,
  LinkedText,
  MarkdownLink,
  markdownUrl,
  remarkImagePaths,
} from "./mentions";
import { Inspector } from "./Inspector";
import { Board, taskMime } from "./Board";
import { WorkBoard } from "./Work";
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
    "workspace" | "settings" | "extensions" | "board" | "work"
  >("workspace");
  // The project whose task board is open.
  const [workProject, setWorkProject] = useState("");
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
  // The task being renamed, and the one waiting for delete confirmation.
  const [renameId, setRenameId] = useState<string>();
  const [deleting, setDeleting] = useState<Task>();
  const [removeFolder, setRemoveFolder] = useState(false);
  // The composer popover open: agent and model, images or sub-agents.
  const [pop, setPop] = useState<"agent" | "images" | "subagents" | null>(null);
  // Sidebar sections the user collapsed, kept between sessions.
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("codebit.collapsed") || "[]");
    } catch {
      return [];
    }
  });
  const searchInput = useRef<HTMLInputElement>(null);
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
      // A new plan opens in the side panel of the task on screen.
      if (event.type === "plan" && event.taskId === selectedRef.current) {
        setTab("Plano");
        setPanel(true);
      }
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
    setPop(null);
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
  function startRename(t: Task) {
    setRenameId(t.id);
    setTitle(t.title);
    setModal("rename");
  }
  function startDelete(t: Task) {
    setRemoveFolder(false);
    setDeleting(t);
  }
  async function deleteTask(t: Task) {
    await api("task.delete", { id: t.id, folder: removeFolder });
    setDeleting(undefined);
    if (selectedRef.current === t.id) setSelected("");
  }
  // Sidebar actions, from the row buttons or the right-click menu.
  const taskAction = useStable((t: Task, action?: string) => {
    if (action === "open") openTask(t.id);
    if (action === "rename") startRename(t);
    if (action === "archive")
      void run(() =>
        api("task.update", { id: t.id, patch: { archived: !t.archived } }),
      );
    if (action === "delete") startDelete(t);
  });
  // A search shows every match, even in collapsed sections.
  const isOpen = (key: string) => !!search || !collapsed.includes(key);
  function toggleSection(key: string) {
    const next = collapsed.includes(key)
      ? collapsed.filter((k) => k !== key)
      : [...collapsed, key];
    setCollapsed(next);
    localStorage.setItem("codebit.collapsed", JSON.stringify(next));
  }
  // Popovers close on a click outside them or with Escape.
  useEffect(() => {
    if (!pop) return;
    const click = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(".chip-wrap")) setPop(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPop(null);
    };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", key);
    };
  }, [pop]);
  // Ctrl+K searches, Ctrl+N starts a task, Ctrl+. stops the open one.
  const shortcut = useStable((e: KeyboardEvent) => {
    if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
    const key = e.key.toLowerCase();
    if (key === "k") {
      e.preventDefault();
      searchInput.current?.focus();
      searchInput.current?.select();
    } else if (key === "n") {
      e.preventDefault();
      newTask();
    } else if (key === "." && task && (active || task.background)) {
      e.preventDefault();
      void run(() => api("task.interrupt", { id: task.id }));
    }
  });
  useEffect(() => {
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
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
  // The chat's own sub-agents, or the default from the settings.
  const subagents = task
    ? subagentsFor(task, snapshot?.settings ?? {})
    : defaultSubagents;
  const synced = !!snapshot?.settings.syncSubagents;
  const selectedInfo = snapshot?.agents.find((a) => a.id === task?.agent);
  const selectedModel = selectedInfo?.models.find((m) => m.id === task?.model);
  const efforts = selectedModel?.efforts || [];
  // What the composer chips show.
  // The chips stay short; their titles and popovers carry the rest.
  const agentSummary = task
    ? [
        agentNames[task.agent],
        selectedModel?.name ?? task.model,
        task.effort ? effortLabel(task.effort) : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const imageModelName = task
    ? imageModels.find(
        (m) =>
          m.id === task.images.model &&
          (m.workflow || "sdxl-text") === task.images.workflow,
      )?.name || task.images.model
    : "";
  const imageSummary = task
    ? imageModelName ||
      `${imageProviderNames[task.images.provider]} · sem modelo`
    : "";
  // An approval or question still waiting, pointed to above the composer.
  const pendingRequest = entries.findLast(
    (e) => e.kind === "request" && !e.resolved,
  );
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
  const showPlan = useStable(() => {
    setTab("Plano");
    setPanel(true);
  });
  // The plan approval still waiting, if any, for the buttons in the panel.
  const planRequest = entries.findLast(
    (e) => e.kind === "request" && e.request?.plan && !e.resolved,
  )?.id;
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
    if (modal === "rename" && renameId)
      await api("task.update", {
        id: renameId,
        patch: { title: title.trim() },
      });
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
          <Code2 size={24} />
          <span>Codebit</span>
        </div>
        <button
          className="primary new-task"
          title="Nova tarefa (Ctrl+N)"
          onClick={() => newTask()}
        >
          <Plus size={17} />
          Nova tarefa
        </button>
        <label className="search">
          <Search size={15} />
          <input
            ref={searchInput}
            aria-label="Buscar tarefas"
            placeholder="Buscar"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearch("");
                e.currentTarget.blur();
              }
            }}
          />
          <kbd>Ctrl K</kbd>
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
          {showArchived && (
            <div className="archived-note" role="status">
              <Archive size={13} />
              Tarefas arquivadas
              <button
                className="text-button"
                onClick={() => setShowArchived(false)}
              >
                Voltar às ativas
              </button>
            </div>
          )}
          <PromptList
            prompts={snapshot?.prompts ?? []}
            projectId={task?.projectId ?? ""}
            open={isOpen("prompts")}
            onToggle={() => toggleSection("prompts")}
            onRun={runPrompt}
            onEdit={setPromptForm}
            onNew={() => setPromptForm("new")}
          />
          <SectionLabel
            label="CONVERSAS"
            open={isOpen("conversas")}
            onToggle={() => toggleSection("conversas")}
          >
            <button
              className="icon"
              title="Nova conversa sem projeto"
              aria-label="Nova conversa sem projeto"
              onClick={() => newTask("")}
            >
              <Plus size={15} />
            </button>
          </SectionLabel>
          {isOpen("conversas") && (
            <div className="project conversations">
              {snapshot?.tasks
                .filter(
                  (t) =>
                    !t.projectId &&
                    !t.workItemId &&
                    t.archived === showArchived &&
                    t.title.toLowerCase().includes(search.toLowerCase()),
                )
                .map((t) => (
                  <TaskItem
                    key={t.id}
                    task={t}
                    selected={t.id === selected && view === "workspace"}
                    onSelect={() => openTask(t.id)}
                    onAction={taskAction}
                  />
                ))}
            </div>
          )}
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
                <button
                  className="project-toggle"
                  aria-expanded={isOpen(`project:${p.id}`)}
                  title={isOpen(`project:${p.id}`) ? "Recolher" : "Expandir"}
                  onClick={() => toggleSection(`project:${p.id}`)}
                >
                  {isOpen(`project:${p.id}`) ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )}
                  <Folder size={16} />
                  <span>{p.name}</span>
                </button>
                <button
                  className="icon on-hover"
                  title="Nova tarefa neste projeto"
                  onClick={() => newTask(p.id)}
                >
                  <Plus size={14} />
                </button>
              </div>
              {isOpen(`project:${p.id}`) && (
                <button
                  className={`work-link ${(view === "work" && workProject === p.id) || (view === "workspace" && task?.workItemId && task.projectId === p.id) ? "active-link" : ""}`}
                  title="Quadro de tarefas do projeto"
                  aria-label={`Tarefas de ${p.name}`}
                  onClick={() => {
                    setWorkProject(p.id);
                    setView("work");
                  }}
                >
                  <ListTodo size={15} />
                  <span>Tarefas</span>
                  {p.work?.enabled && (
                    <span
                      className="status-dot pulse"
                      title="Modo tarefas ligado"
                    />
                  )}
                  {(() => {
                    const pending = snapshot.work.filter(
                      (i) => i.projectId === p.id && i.state === "pending",
                    ).length;
                    return pending ? (
                      <span
                        className="badge attention"
                        title="Recomendações esperando aprovação"
                      >
                        {pending}
                      </span>
                    ) : null;
                  })()}
                </button>
              )}
              {isOpen(`project:${p.id}`) &&
                snapshot.tasks
                  .filter(
                    (t) =>
                      t.projectId === p.id &&
                      !t.workItemId &&
                      t.archived === showArchived &&
                      t.title.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((t) => (
                    <TaskItem
                      key={t.id}
                      task={t}
                      selected={t.id === selected && view === "workspace"}
                      onSelect={() => openTask(t.id)}
                      onAction={taskAction}
                    />
                  ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {snapshot?.source &&
            (snapshot.source.building ||
              snapshot.source.error ||
              snapshot.source.interface ||
              snapshot.source.core) && (
              <div
                className={`update-pill ${snapshot.source.core || snapshot.source.interface || snapshot.source.building ? "" : "error"}`}
                role="status"
              >
                {snapshot.source.core ? (
                  snapshot.source.waiting ? (
                    <>
                      <LoaderCircle size={13} className="spin" />
                      <span>Reinicia quando as tarefas terminarem</span>
                      <button
                        className="text-button"
                        onClick={() => void run(() => api("source.cancel"))}
                      >
                        Cancelar
                      </button>
                    </>
                  ) : (
                    <button
                      title="Fecha e reabre o Codebit com o código novo, esperando as tarefas terminarem. As conversas continuam na mesma sessão dos agentes."
                      onClick={() => void run(() => api("source.restart"))}
                    >
                      <RefreshCw size={14} />
                      App atualizado · Reiniciar
                    </button>
                  )
                ) : snapshot.source.interface ? (
                  <button
                    title="Recarrega a janela com a interface nova; os agentes continuam rodando."
                    onClick={() => void run(() => api("source.reload"))}
                  >
                    <RefreshCw size={14} />
                    Interface atualizada · Recarregar
                  </button>
                ) : snapshot.source.building ? (
                  <>
                    <LoaderCircle size={13} className="spin" />
                    <span>Preparando o código novo…</span>
                  </>
                ) : (
                  <span title={snapshot.source.error}>
                    Código com erro · a versão atual continua
                  </span>
                )}
              </div>
            )}
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
          <div className="sidebar-footer">
            <span className="local-label" title={`Codebit v${appVersion}`}>
              <span className="status-dot" />
              Seu workspace local
            </span>
            <button
              className={`icon ${showArchived ? "active-link" : ""}`}
              title={showArchived ? "Mostrar tarefas ativas" : "Arquivadas"}
              aria-label={
                showArchived ? "Mostrar tarefas ativas" : "Arquivadas"
              }
              aria-pressed={showArchived}
              onClick={() => setShowArchived(!showArchived)}
            >
              <Archive size={16} />
            </button>
            <button
              className={`icon ${view === "extensions" ? "active-link" : ""}`}
              title="Skills e MCP"
              aria-label="Skills e MCP"
              onClick={() => setView("extensions")}
            >
              <Layers size={16} />
            </button>
            <button
              className={`icon ${view === "settings" ? "active-link" : ""}`}
              title="Configurações"
              aria-label="Configurações"
              onClick={() => setView("settings")}
            >
              <SettingsIcon size={16} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-shell">
        <header className="titlebar">
          <div className="title-context">
            {view === "workspace" && task ? (
              <>
                {task.workItemId && (
                  <button
                    className="icon back-to-board"
                    title="Voltar ao quadro de tarefas"
                    aria-label="Voltar ao quadro de tarefas"
                    onClick={() => {
                      setWorkProject(task.projectId);
                      setView("work");
                    }}
                  >
                    <ArrowLeft size={16} />
                  </button>
                )}
                <h1
                  title="Clique duas vezes para renomear"
                  onDoubleClick={() => startRename(task)}
                >
                  {task.title}
                </h1>
                <span className="title-meta">
                  {project ? (
                    <>
                      <Folder size={12} />
                      {project.name}
                    </>
                  ) : (
                    "Conversa sem projeto"
                  )}
                  {task.worktree && <span className="badge">worktree</span>}
                  {task.workItemId && (
                    <span className="badge">tarefa do quadro</span>
                  )}
                  {task.parentId && (
                    <span className="badge">tarefa vinculada</span>
                  )}
                </span>
              </>
            ) : (
              <span className="title-subtle">
                {view === "board"
                  ? "Modo Multitarefa"
                  : view === "work"
                    ? "Quadro de tarefas"
                    : view === "workspace"
                      ? "Seu próximo projeto começa aqui"
                      : "Configurações"}
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
                  onClick={() => startRename(task)}
                  disabled={locked}
                >
                  <Pencil size={15} />
                </button>
                <button
                  className="icon"
                  title={task.archived ? "Restaurar tarefa" : "Arquivar tarefa"}
                  aria-label={
                    task.archived ? "Restaurar tarefa" : "Arquivar tarefa"
                  }
                  onClick={() =>
                    void run(() => patch({ archived: !task.archived }))
                  }
                  disabled={locked}
                >
                  {task.archived ? (
                    <ArchiveRestore size={16} />
                  ) : (
                    <Archive size={16} />
                  )}
                </button>
                <button
                  className="icon danger-icon"
                  title={
                    locked
                      ? "Interrompa a tarefa antes de excluí-la"
                      : "Excluir tarefa"
                  }
                  aria-label="Excluir tarefa"
                  onClick={() => startDelete(task)}
                  disabled={locked}
                >
                  <Trash2 size={15} />
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
        {view === "work" &&
        snapshot?.projects.some((p) => p.id === workProject) ? (
          <WorkBoard
            project={snapshot.projects.find((p) => p.id === workProject)!}
            snapshot={snapshot}
            run={run}
            onOpen={openTask}
          />
        ) : view === "board" && snapshot ? (
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
                    onShowPlan={showPlan}
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
                {pendingRequest && (
                  <button
                    className="pending-strip"
                    onClick={() =>
                      document
                        .getElementById(`entry-${pendingRequest.id}`)
                        ?.scrollIntoView({ block: "center" })
                    }
                  >
                    <TriangleAlert size={14} />
                    <span className="truncate">
                      O agente espera sua decisão:{" "}
                      <strong>{pendingRequest.request?.title}</strong>
                    </span>
                    <span className="pending-go">Ver</span>
                  </button>
                )}
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
                        {isImagePath(a) ? (
                          <img
                            className="attachment-thumb"
                            src={fileUrl(task.id, a)}
                            alt=""
                          />
                        ) : (
                          <Paperclip size={12} />
                        )}
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
                          title="Remover anexo"
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
                  <div className="composer-bar">
                    <button
                      className="icon"
                      title="Anexar arquivos"
                      aria-label="Anexar arquivos"
                      onClick={() =>
                        void run(async () => {
                          const a = await api<string[]>("attachments.add", {
                            id: task.id,
                          });
                          setAttachments([...attachments, ...a].slice(0, 10));
                        })
                      }
                    >
                      <Paperclip size={17} />
                    </button>
                    <div className="chip-wrap">
                      <button
                        className={`chip ${pop === "agent" ? "open" : ""}`}
                        aria-label="Agente e modelo"
                        aria-expanded={pop === "agent"}
                        title={`${agentSummary}${task.model ? "" : " · modelo padrão do CLI"}`}
                        onClick={() => setPop(pop === "agent" ? null : "agent")}
                      >
                        <AgentMark agent={task.agent} />
                        <span className="truncate">{agentSummary}</span>
                        {selectedInfo?.catalogStatus === "loading" ? (
                          <LoaderCircle size={12} className="spin" />
                        ) : (
                          <ChevronDown size={12} />
                        )}
                      </button>
                      {pop === "agent" && (
                        <div
                          className="popover"
                          role="dialog"
                          aria-label="Agente e modelo"
                        >
                          <strong className="popover-title">
                            Agente e modelo
                          </strong>
                          <label>
                            Agente
                            <select
                              aria-label="Agente"
                              className="agent-select"
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
                          </label>
                          <label>
                            Modelo
                            <span className="field-row">
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
                                    setPop(null);
                                    setTitle(task.model);
                                    setModal("model");
                                  } else
                                    void run(() =>
                                      patch({ model: e.target.value }),
                                    );
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
                                  <option
                                    key={m.id}
                                    value={m.id}
                                    title={m.description}
                                  >
                                    {m.name}
                                    {m.resolvedModel
                                      ? ` · ${m.resolvedModel}`
                                      : ""}
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
                                <option value="__manual">
                                  Informar modelo…
                                </option>
                              </select>
                              <button
                                className="icon"
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
                                  void run(() =>
                                    api("auth", { agent: task.agent }),
                                  )
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
                            </span>
                          </label>
                          <label>
                            Esforço
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
                                void run(() =>
                                  patch({ effort: e.target.value }),
                                )
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
                              {task.effort &&
                                !efforts.includes(task.effort) && (
                                  <option value={task.effort}>
                                    {effortLabel(task.effort)} · indisponível
                                  </option>
                                )}
                            </select>
                          </label>
                          <p className="help">
                            {locked
                              ? "Bloqueado enquanto o agente trabalha."
                              : "Trocar de agente mantém esta conversa; o novo agente recebe o que perdeu."}
                          </p>
                        </div>
                      )}
                    </div>
                    <div className="chip-wrap">
                      <button
                        className={`chip compactable ${pop === "images" ? "open" : ""}`}
                        aria-label="Configurar imagens"
                        aria-expanded={pop === "images"}
                        title={`Imagens: ${imageProviderNames[task.images.provider]} · ${imageSummary}`}
                        onClick={() =>
                          setPop(pop === "images" ? null : "images")
                        }
                      >
                        {imageProgress ? (
                          <LoaderCircle size={13} className="spin" />
                        ) : (
                          <ImageIcon size={13} />
                        )}
                        <span className="truncate">{imageSummary}</span>
                        <ChevronDown size={12} />
                      </button>
                      {pop === "images" && (
                        <div
                          className="popover"
                          role="dialog"
                          aria-label="Imagens"
                        >
                          <strong className="popover-title">Imagens</strong>
                          <label>
                            Provedor
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
                              <option value="openai">
                                OpenAI · Chave da API
                              </option>
                              <option value="comfyui">ComfyUI · Local</option>
                            </select>
                          </label>
                          <label>
                            Modelo
                            <select
                              aria-label="Modelo de imagem"
                              value={
                                task.images.model + "|" + task.images.workflow
                              }
                              disabled={locked || !!imageProgress}
                              onChange={(e) => {
                                const [model, workflow] =
                                  e.target.value.split("|");
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
                                value={
                                  task.images.model + "|" + task.images.workflow
                                }
                              >
                                {imageModelName || "Selecionar modelo"}
                              </option>
                              {imageModels.map((m) => (
                                <option
                                  key={m.id + "|" + m.workflow}
                                  value={
                                    m.id + "|" + (m.workflow || "sdxl-text")
                                  }
                                  disabled={!m.available}
                                >
                                  {m.name}
                                  {!m.available ? " · configurar" : ""}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            className="primary compact"
                            disabled={!draft.trim() || !!imageProgress}
                            title="Gerar imagem diretamente com o modelo selecionado"
                            onClick={() => {
                              setPop(null);
                              void run(generateImage);
                            }}
                          >
                            <ImageIcon size={14} />
                            Gerar imagem
                          </button>
                          <p className="help">
                            {draft.trim()
                              ? "Usa o texto da mensagem como descrição da imagem."
                              : "Escreva a descrição da imagem na mensagem para gerar."}{" "}
                            Dimensões e qualidade ficam na aba Imagens do
                            painel.
                          </p>
                        </div>
                      )}
                    </div>
                    <div className="chip-wrap">
                      <button
                        className={`chip compactable ${subagents.enabled ? "on" : ""} ${pop === "subagents" ? "open" : ""}`}
                        aria-label="Configurar sub-agentes"
                        aria-expanded={pop === "subagents"}
                        title="Sub-agentes"
                        onClick={() =>
                          setPop(pop === "subagents" ? null : "subagents")
                        }
                      >
                        <Users size={13} />
                        <span className="truncate">
                          {subagents.enabled
                            ? `${agentNames[subagents.agent]} · ${subagents.max}`
                            : "Desligados"}
                        </span>
                        <ChevronDown size={12} />
                      </button>
                      {pop === "subagents" && (
                        <div
                          className="popover subagents-popover"
                          role="dialog"
                          aria-label="Sub-agentes"
                        >
                          <strong className="popover-title">Sub-agentes</strong>
                          {synced && (
                            <p className="help subagents-synced">
                              Esta conversa segue os sub-agentes padrão,
                              aplicados a todas as conversas. Mude em
                              Configurações → Comportamento → Sub-agentes
                              padrão.
                            </p>
                          )}
                          <SubagentOptionsForm
                            value={subagents}
                            disabled={synced || locked}
                            agents={snapshot?.agents ?? []}
                            defaultModels={snapshot?.settings.defaultModels}
                            onChange={(value) =>
                              void run(() => patchSubagents(value))
                            }
                          />
                          <p className="help">
                            {locked
                              ? "Bloqueado enquanto o agente trabalha."
                              : task.agent === "devin"
                                ? "O Devin CLI ainda não usa ferramentas MCP do Codebit como agente principal. Escolha Codex ou Claude para delegar; o Devin funciona como sub-agente."
                                : "O agente principal recebe a ferramenta run_subagents. Os sub-agentes trabalham na mesma pasta e seguem o modo da tarefa."}
                          </p>
                          {task.subagents && !synced && !locked && (
                            <button
                              className="text-button"
                              title="Esta conversa passa a seguir os sub-agentes padrão das Configurações."
                              onClick={() =>
                                void run(() => patch({ subagents: null }))
                              }
                            >
                              Voltar ao padrão
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    <span className="composer-spacer" />
                    <div className="mode-toggle" role="group" aria-label="Modo">
                      <button
                        className={task.mode === "plan" ? "selected" : ""}
                        aria-pressed={task.mode === "plan"}
                        disabled={locked}
                        title="O agente só lê e propõe um plano para você aprovar."
                        onClick={() => void run(() => patch({ mode: "plan" }))}
                      >
                        Planejar
                      </button>
                      <button
                        className={task.mode === "execute" ? "selected" : ""}
                        aria-pressed={task.mode === "execute"}
                        disabled={locked}
                        title="O agente pede permissão antes de comandos e alterações sensíveis."
                        onClick={() =>
                          void run(() => patch({ mode: "execute" }))
                        }
                      >
                        Executar
                      </button>
                      <button
                        className={`bypass ${task.mode === "bypass" ? "selected" : ""}`}
                        aria-pressed={task.mode === "bypass"}
                        disabled={locked}
                        title="Executa comandos e altera arquivos sem pedir permissão. Use apenas em projetos em que você confia."
                        onClick={() =>
                          void run(() => patch({ mode: "bypass" }))
                        }
                      >
                        Bypass
                      </button>
                    </div>
                    {active && (
                      <button
                        className="send queue"
                        title="Adicionar à fila (Enter)"
                        aria-label="Adicionar à fila"
                        disabled={
                          submitting || (!draft.trim() && !attachments.length)
                        }
                        onClick={() => void run(submit)}
                      >
                        <ListPlus size={18} />
                      </button>
                    )}
                    {active ? (
                      <button
                        className="send stop"
                        title="Interromper (Ctrl+.)"
                        aria-label="Interromper"
                        onClick={() =>
                          void run(() => api("task.interrupt", { id: task.id }))
                        }
                      >
                        <Square size={15} />
                      </button>
                    ) : (
                      <button
                        className="send"
                        title="Enviar (Enter) · Shift+Enter para nova linha"
                        aria-label="Enviar mensagem"
                        disabled={
                          submitting ||
                          (!draft.trim() && !attachments.length) ||
                          !trusted
                        }
                        onClick={() => void run(submit)}
                      >
                        <ArrowUp size={19} />
                      </button>
                    )}
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
                planRequest={planRequest}
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
      {deleting && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDeleting(undefined);
          }}
        >
          <form
            className="modal"
            role="dialog"
            aria-label="Excluir tarefa"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => deleteTask(deleting));
            }}
          >
            <div className="modal-header">
              <h2>Excluir “{deleting.title}”?</h2>
              <button
                type="button"
                className="icon"
                aria-label="Fechar"
                onClick={() => setDeleting(undefined)}
              >
                <X size={19} />
              </button>
            </div>
            <p className="help">
              Apaga o histórico da conversa, os anexos copiados para ela, as
              imagens geradas nela e o plano salvo. Não dá para desfazer; para
              guardar uma imagem, exporte antes. Se só quiser tirá-la da lista,
              use Arquivar.
            </p>
            <p className="help">
              {deleting.projectId
                ? "Os arquivos do projeto não são alterados."
                : "Conversas sem projeto trabalham numa pasta própria do Codebit."}
            </p>
            {deleting.worktree && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={removeFolder}
                  onChange={(e) => setRemoveFolder(e.target.checked)}
                />
                Remover também a worktree da tarefa (alterações não commitadas
                nela serão perdidas; o branch continua no repositório)
              </label>
            )}
            {!deleting.projectId && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={removeFolder}
                  onChange={(e) => setRemoveFolder(e.target.checked)}
                />
                Apagar também a pasta da conversa, com os arquivos criados nela
              </label>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="quiet"
                onClick={() => setDeleting(undefined)}
              >
                Cancelar
              </button>
              <button className="primary danger-button" type="submit" autoFocus>
                <Trash2 size={15} />
                Excluir
              </button>
            </div>
          </form>
        </div>
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
    onShowPlan,
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
    onShowPlan: () => void;
  }) {
    return (
      <div className={`entry entry-${e.kind}`} id={`entry-${e.id}`}>
        {["user", "assistant"].includes(e.kind) && (
          <>
            <div
              className={`avatar ${e.kind === "assistant" ? `agent-avatar ${e.agent ?? agent}` : ""}`}
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
                    a: ({ href, children }) => (
                      <MarkdownLink
                        href={href}
                        base={{ id: taskId }}
                        run={run}
                        onOpenImage={onOpenImage}
                      >
                        {children}
                      </MarkdownLink>
                    ),
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
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      void run(() => linkMenu({ id: taskId }, a, true));
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
            <ActivityIcon text={e.text} ok={e.ok} />
            <span>
              <LinkedText
                text={e.text}
                onOpen={onOpenImage}
                onMenu={(path) =>
                  void run(() => linkMenu({ id: taskId }, path, true))
                }
              />
            </span>
          </>
        )}
        {e.kind === "warning" && (
          <div className="warning-card" role="status">
            <TriangleAlert size={18} />
            <div>
              <strong>{e.title ?? "Conflito com outra conversa"}</strong>
              <p>{e.text.charAt(0).toUpperCase() + e.text.slice(1)}</p>
            </div>
          </div>
        )}
        {e.kind === "error" && (
          <div className="error-card">
            <CircleAlert size={18} />
            <div>
              <strong>{errorTitle(e.text)}</strong>
              <p>{e.text}</p>
            </div>
          </div>
        )}
        {e.kind === "request" && e.request && (
          <RequestCard
            entry={e}
            taskId={taskId}
            run={run}
            onShowPlan={onShowPlan}
          />
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
    a.entry.ok === b.entry.ok &&
    a.entry.agent === b.entry.agent &&
    a.agent === b.agent &&
    a.taskId === b.taskId &&
    a.artifact?.id === b.artifact?.id,
);
// A known cause as the error card title; otherwise a general one.
function errorTitle(text: string) {
  if (/cota|quota|rate limit|usage limit|limite de uso/i.test(text))
    return "Limite de uso atingido";
  if (/ENOTFOUND|resolve host|ECONNREFUSED|ECONNRESET|sem conexão/i.test(text))
    return "Falha de rede";
  if (/tempo esgotado|timed out|timeout/i.test(text)) return "Tempo esgotado";
  if (/CLI não encontrado|ENOENT|not recognized/i.test(text))
    return "CLI não encontrado";
  if (/not logged|unauthori[sz]ed|login necessário/i.test(text))
    return "Login necessário";
  return "A execução precisa de atenção";
}
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
// How long ago, short enough for the sidebar.
function ago(iso: string) {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return days < 30
    ? `${days} d`
    : new Date(iso).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "short",
      });
}
function TaskItem({
  task,
  selected,
  onSelect,
  onAction,
}: {
  task: Task;
  selected: boolean;
  onSelect: () => void;
  onAction: (task: Task, action?: string) => void;
}) {
  const busy = ["running", "waiting", "queued"].includes(task.status);
  const flagged = busy || ["failed", "interrupted"].includes(task.status);
  const locked = busy || !!task.background;
  return (
    <div
      className="task-row"
      onContextMenu={(e) => {
        e.preventDefault();
        void api<string | undefined>("task.menu", { id: task.id }).then(
          (action) => onAction(task, action),
        );
      }}
    >
      <button
        className={`task-item ${selected ? "selected" : ""}`}
        title={`${task.title} · ${agentNames[task.agent]} · ${statusNames[task.status]}`}
        onClick={onSelect}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(taskMime, task.id);
          e.dataTransfer.effectAllowed = "copy";
        }}
      >
        <AgentMark agent={task.agent} />
        <span className="task-title">{task.title}</span>
        {flagged ? (
          <span
            className={`status-dot ${task.status === "waiting" ? "amber" : task.status === "failed" ? "red" : task.status === "interrupted" ? "muted-dot" : "pulse"}`}
            aria-hidden
          />
        ) : (
          <time className="task-time" aria-hidden>
            {ago(task.updatedAt)}
          </time>
        )}
      </button>
      {!locked && (
        <span className="task-actions">
          <button
            className="icon"
            title={task.archived ? "Restaurar" : "Arquivar"}
            aria-label={task.archived ? "Restaurar" : "Arquivar"}
            onClick={() => onAction(task, "archive")}
          >
            {task.archived ? (
              <ArchiveRestore size={14} />
            ) : (
              <Archive size={14} />
            )}
          </button>
          <button
            className="icon danger-icon"
            title="Excluir"
            aria-label="Excluir"
            onClick={() => onAction(task, "delete")}
          >
            <Trash2 size={14} />
          </button>
        </span>
      )}
    </div>
  );
}
