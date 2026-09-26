// Shown in the UI and sent to the CLIs. Bump with package.json; a test checks both.
export const appVersion = "0.2.5";
export type AgentId = "codex" | "claude" | "devin";
export const agentIds: AgentId[] = ["codex", "claude", "devin"];
export const agentNames: Record<AgentId, string> = {
  codex: "Codex",
  claude: "Claude",
  devin: "Devin",
};
export type ImageProviderId = "codex" | "openai" | "comfyui";
export const imageProviderNames: Record<ImageProviderId, string> = {
  codex: "Codex",
  openai: "OpenAI",
  comfyui: "ComfyUI",
};
export type TaskStatus =
  "idle" | "queued" | "running" | "waiting" | "interrupted" | "failed";
export interface Model {
  id: string;
  name: string;
  verified?: boolean;
  efforts?: string[];
  defaultEffort?: string;
  description?: string;
  resolvedModel?: string;
  contextWindow?: number;
}
// Slash commands and skills offered by the agent CLI for a folder.
export interface AgentCommand {
  name: string;
  description: string;
  kind: "skill" | "command";
  hint?: string;
  path?: string;
}
export interface ContextUsage {
  used: number;
  size?: number;
}
// Plan usage reported by the agent CLI for the logged-in account.
export interface QuotaWindow {
  label: string;
  usedPercent: number;
  // Unix seconds.
  resetsAt?: number;
}
export interface AgentQuota {
  plan?: string;
  windows: QuotaWindow[];
  note?: string;
  checkedAt: string;
}
// A task on the multitask board with its latest activity.
export interface BoardCard {
  task: Task;
  // Recent conversation, followed by requests still waiting for the user.
  entries: Entry[];
  artifact?: Artifact;
}
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: string[];
  createdAt: string;
}
export interface Installation {
  agent: AgentId;
  path: string;
  command: string;
  args: string[];
  version: string;
  error?: string;
}
export interface AgentInfo {
  id: AgentId;
  name: string;
  installations: Installation[];
  selected?: Installation;
  auth: "unknown" | "ready" | "missing" | "error";
  authMessage?: string;
  models: Model[];
  catalogStatus?: "loading" | "ready" | "error";
  catalogError?: string;
  quota?: AgentQuota;
  quotaError?: string;
}
export interface Project {
  id: string;
  name: string;
  path: string;
  git: boolean;
  trusted: boolean;
}
export interface ImageOptions {
  provider: ImageProviderId;
  model: string;
  quality: "auto" | "low" | "medium" | "high";
  size: string;
  workflow: string;
  seed: number;
  inputImage?: string;
}
export type TaskMode = "plan" | "execute" | "bypass";
export interface SubagentOptions {
  enabled: boolean;
  agent: AgentId;
  model: string;
  effort: string;
  max: number;
}
export interface Task {
  id: string;
  // Empty for conversations without a project; they run in a Codebit folder.
  projectId: string;
  title: string;
  agent: AgentId;
  model: string;
  cwd: string;
  effort?: string;
  worktree: boolean;
  mode: TaskMode;
  status: TaskStatus;
  nativeId?: string;
  // Native sessions of agents used earlier in this task, for switching back.
  nativeIds?: Partial<Record<AgentId, string>>;
  // Set when the agent changed; the next message carries the missed context.
  contextPending?: boolean;
  // Last entry each agent saw before the task switched away from it.
  seen?: Partial<Record<AgentId, string>>;
  // Context window usage reported by the agent in its latest turn.
  context?: ContextUsage;
  // Messages waiting to be sent after the current response.
  queue?: QueuedMessage[];
  // When the task was placed on the multitask board; absent when off it.
  boardAt?: string;
  // Background commands and sub-agents of the open session, if any.
  background?: number;
  subagents?: SubagentOptions;
  parentId?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  images: ImageOptions;
}
export interface RequestPrompt {
  id: string;
  kind: "approval" | "question";
  title: string;
  detail: string;
  questions?: {
    id: string;
    question: string;
    options?: string[];
    multiSelect?: boolean;
  }[];
  choices?: string[];
  // The tool asking, when the CLI says (Claude: ExitPlanMode, Bash…).
  tool?: string;
}
export interface Entry {
  id: string;
  taskId: string;
  kind:
    | "user"
    | "assistant"
    | "activity"
    | "warning"
    | "error"
    | "image"
    | "request";
  text: string;
  createdAt: string;
  request?: RequestPrompt;
  artifactId?: string;
  attachments?: string[];
  resolved?: boolean;
  agent?: AgentId;
}
// A quick request kept in the sidebar and run apart from the conversations.
export interface SavedPrompt {
  id: string;
  name: string;
  text: string;
  // Empty for prompts available in every project.
  projectId: string;
  mode: Task["mode"];
  createdAt: string;
}
// A run of a saved prompt; it lives in memory while Codebit is open.
export interface QuickRun {
  id: string;
  promptId: string;
  name: string;
  text: string;
  agent: AgentId;
  model: string;
  effort?: string;
  mode: Task["mode"];
  projectId: string;
  cwd: string;
  status: "running" | "waiting" | "done" | "failed" | "interrupted";
  reply: string;
  activity: string[];
  request?: RequestPrompt;
  error?: string;
  nativeId?: string;
  startedAt: string;
}
export interface Artifact {
  id: string;
  taskId: string;
  path: string;
  prompt: string;
  provider: ImageProviderId;
  model: string;
  createdAt: string;
  options: ImageOptions;
}
export interface Workflow {
  id: string;
  name: string;
  kind: "generate" | "edit";
  graph: Record<string, any>;
  bindings: Record<string, string>;
  builtin?: boolean;
}
export interface McpConfig {
  id: string;
  name: string;
  // "both" predates Devin and means every agent.
  agent: AgentId | "both";
  enabled: boolean;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}
export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  agent: AgentId;
  source: string;
}
export interface Settings {
  cliPaths: Partial<Record<AgentId, string>>;
  comfyUrl: string;
  defaultModels: Record<AgentId, string>;
  mcp: McpConfig[];
  workflows: Workflow[];
  // Standing instructions sent to every agent (Codex, Claude and Devin).
  guidelines?: string;
  // Windows notifications when a task ends, fails or needs the user.
  notifications?: boolean;
  // Mode of new tasks; Bypass when unset.
  defaultMode?: Task["mode"];
  // Folder with new builds; the running portable's folder when unset.
  updateFolder?: string;
  hasOpenAIKey?: boolean;
}
export const defaultGuidelines =
  "Ferramentas desatualizadas: se uma ferramenta ou CLI necessária estiver desatualizada (Codex, Claude Code, Devin ou dependências que eles usam), você tem permissão para atualizá-la diretamente, sem pedir confirmação, e deve atualizar também as informações internas que dependem da versão (configurações, documentação e registros do projeto). Ao terminar, informe a versão anterior e a nova. Se a instalação for gerenciada por outro aplicativo, como o Devin Desktop, explique como atualizar em vez de forçar.";
export interface ImageModel extends Model {
  provider: ImageProviderId;
  available: boolean;
  reason?: string;
  workflow?: string;
  kind?: "generate" | "edit";
}
// Self update from a folder of portable builds.
export interface UpdateState {
  current: string;
  folder?: string;
  available?: { version: string; path: string };
  // waiting: the user asked to update and something is still running.
  status: "idle" | "waiting" | "applying";
  error?: string;
}
export interface Snapshot {
  projects: Project[];
  tasks: Task[];
  prompts: SavedPrompt[];
  update?: UpdateState;
  settings: Settings;
  agents: AgentInfo[];
}
export type AgentEvent =
  | { type: "text"; text: string }
  // Files lists what an edit tool changed, to spot conflicting chats.
  | { type: "activity"; text: string; files?: string[] }
  | { type: "request"; request: RequestPrompt }
  | { type: "native"; id: string }
  | { type: "usage"; used: number; size?: number }
  // An image the agent generated with its own tool (base64 PNG or a file).
  | { type: "image"; prompt: string; data?: string; path?: string }
  | { type: "quota"; windows: QuotaWindow[] }
  | { type: "commands"; commands: AgentCommand[] }
  // Commands and sub-agents still running in the background; they keep the
  // session open after the turn ends.
  | { type: "background"; count: number }
  // A turn started, including one the agent starts on its own when
  // background work finishes.
  | { type: "turn" }
  | { type: "done" }
  | { type: "error"; text: string };
export interface AgentSession {
  send(text: string, attachments: string[]): Promise<void>;
  // Adds a message to the response in progress, when the CLI supports it.
  steer?(text: string, attachments: string[]): Promise<void>;
  respond(id: string, value: any): void;
  interrupt(): Promise<void>;
  close(): void;
  models(): Promise<Model[]>;
}
export type AppEvent =
  | { type: "refresh"; taskId?: string }
  | { type: "terminal"; taskId: string; data: string }
  | { type: "image-progress"; taskId: string; message: string }
  // A notification was clicked: show this task.
  | { type: "open-task"; taskId: string }
  | { type: "quick"; run: QuickRun }
  | { type: "quick-removed"; id: string };
export interface DesktopAPI {
  call<T = any>(method: string, args?: any): Promise<T>;
  onEvent(handler: (event: AppEvent) => void): () => void;
}
export const defaultSubagents: SubagentOptions = {
  enabled: false,
  agent: "codex",
  model: "",
  effort: "",
  max: 2,
};
export const defaultImages: ImageOptions = {
  provider: "codex",
  model: "gpt-image",
  quality: "auto",
  size: "1024x1024",
  workflow: "sdxl-text",
  seed: 0,
};
