// Shown in the UI and sent to the CLIs. Bump with package.json; a test checks both.
export const appVersion = "0.2.7";
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
  // What it is made of, when the CLI tells (Claude Code), in display order:
  // instructions, tools, skills, conversation and the compaction reserve.
  parts?: ContextPart[];
  // Tool definitions kept out until the agent searches for them.
  deferred?: number;
}
export interface ContextPart {
  id: "instructions" | "tools" | "skills" | "conversation" | "reserve";
  tokens: number;
  // The heaviest pieces of the part: memory files, MCP servers, skills…
  items?: { label: string; tokens: number }[];
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
  // Extra environment of a session's process: the user's secrets.
  env?: Record<string, string>;
}
// A value the user keeps in Codebit, such as an API key. Only the name and
// the description reach the interface; the value stays encrypted and goes to
// the agents' processes as an environment variable.
export interface UserSecret {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}
export const secretNamePattern = /^[A-Z_][A-Z0-9_]{0,99}$/;
// Variables a CLI reads for its own login or settings. A secret with one of
// these names would, for example, switch Claude Code from the subscription to
// billing an API key, so it is not given to that agent.
const agentOwnVariables: Record<AgentId, RegExp> = {
  claude: /^(ANTHROPIC_|CLAUDE_)/,
  codex: /^(CODEX_|OPENAI_BASE_URL$)/,
  devin: /^(DEVIN_|WINDSURF_)/,
};
export function secretBlockedFor(name: string, agent: AgentId) {
  return agentOwnVariables[agent].test(name);
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
  // The project's task board: off by default.
  work?: WorkSettings;
}
// Task board mode: when on, agents start on the board's tasks by themselves.
export interface WorkSettings {
  enabled: boolean;
  agent: AgentId;
  model: string;
  effort: string;
  mode: "execute" | "bypass";
  // Tasks worked on at the same time, in the project folder.
  max: number;
}
export const defaultWork: WorkSettings = {
  enabled: false,
  agent: "codex",
  model: "",
  effort: "",
  mode: "bypass",
  max: 1,
};
// A task on a project's board. The user's and the approved ones wait in
// "todo"; the AI's recommendations stay "pending" until approved.
export interface WorkItem {
  id: string;
  projectId: string;
  title: string;
  description: string;
  origin: "user" | "ai";
  state: "pending" | "todo" | "started";
  // The internal session working on it, kept out of the sidebar.
  taskId?: string;
  // Position among the tasks waiting to start.
  order: number;
  // The board task whose session recommended this one.
  sourceId?: string;
  // The project conversation that added it through codebit_tasks.
  chatId?: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
}
export type WorkStatus =
  | "pending"
  | "todo"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "interrupted";
// Where a board task stands, from its session.
export function workStatus(item: WorkItem, task?: Task): WorkStatus {
  if (item.state !== "started") return item.state;
  if (!task) return "interrupted";
  if (task.status === "waiting") return "waiting";
  if (["running", "queued"].includes(task.status) || task.background)
    return "running";
  if (task.status === "failed") return "failed";
  if (task.status === "interrupted") return "interrupted";
  return "done";
}
export interface ImageOptions {
  provider: ImageProviderId;
  model: string;
  quality: "auto" | "low" | "medium" | "high";
  size: string;
  workflow: string;
  seed: number;
  inputImage?: string;
  // Transparent works with GPT Image; ComfyUI presets ignore it.
  background?: "auto" | "transparent" | "opaque";
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
  // Why Codebit stopped the last run; told to the agent with the next message.
  guardNote?: string;
  // The latest plan proposed in plan mode, kept as a .md file.
  plan?: { text: string; path: string; agent: AgentId; at: string };
  // Own sub-agent options; null in an update returns to the default.
  subagents?: SubagentOptions | null;
  parentId?: string;
  // Internal session of a board task: not listed with the conversations.
  workItemId?: string;
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
  // Approval to leave plan mode; the plan itself is in the side panel.
  plan?: boolean;
  // A social media post waiting for the user: exactly what goes out.
  social?: SocialPreview;
  // A command that deletes files or throws away work: what it reaches.
  blast?: BlastPreview;
}
// What a destructive command would reach, measured before it runs.
export interface BlastPreview {
  summary: string;
  files: number;
  dirs: number;
  bytes: number;
  // The heaviest items, relative to the task folder when inside it.
  entries: { path: string; bytes: number; dir: boolean }[];
  more: number;
  // Something it deletes is outside the task folder (scratch aside).
  outside: boolean;
  // What is in caches and scratch folders: routine, not held to the limits.
  temporary?: { files: number; bytes: number };
  // The count stopped early (a very large folder).
  partial?: boolean;
  // Filters (find, -Include) decide what goes: the numbers are the most.
  filtered?: boolean;
  // Why part of the scope could not be worked out (variables, wildcards).
  unknown?: string;
  // Files whose uncommitted changes Git would throw away.
  git?: string[];
  gitMore?: number;
}
// Given to the agents' sessions: what a command would delete. "asking" is
// true when an approval is already being shown, false for a command about to
// run on its own, which only stops when it is risky.
export type InspectCommand = (
  command: string,
  asking: boolean,
  cwd?: string,
) => Promise<BlastPreview | undefined>;
export interface DeleteGuardSettings {
  enabled: boolean;
  // Asks from this many files, or this size; always outside the task folder.
  files: number;
  megabytes: number;
}
// "61,2 GB", "340 KB".
export const formatBytes = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} GB`
    : n >= 1024 ** 2
      ? `${(n / 1024 ** 2).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`
      : n >= 1024
        ? `${Math.round(n / 1024)} KB`
        : `${n} bytes`;
// Asset projects (Blender files of a gigabyte and more) set the size limit.
export const defaultDeleteGuard: DeleteGuardSettings = {
  enabled: true,
  files: 50,
  megabytes: 1024,
};
export type SocialNetwork = "instagram" | "patreon";
export const socialNetworkNames: Record<SocialNetwork, string> = {
  instagram: "Instagram",
  patreon: "Patreon",
};
// A social account connected to one project. Tokens live apart, encrypted.
export interface SocialAccount {
  id: string;
  projectId: string;
  network: SocialNetwork;
  // @username on Instagram, the user name on Patreon.
  name: string;
  // Instagram: the professional account's id and type.
  userId?: string;
  accountType?: string;
  // Instagram tokens last 60 days; Codebit renews them before that.
  expiresAt?: string;
  refreshedAt?: string;
  createdAt: string;
  // The last renewal or check that failed, shown in Settings.
  error?: string;
}
export interface SocialPreview {
  network: SocialNetwork;
  account: string;
  // Files exactly as they will be published (Instagram: converted JPEGs).
  images: string[];
  text: string;
  title?: string;
  // Instagram: feed or story. Patreon: who can see the post.
  kind?: string;
  audience?: string;
}
export interface SocialPost {
  id: string;
  projectId: string;
  taskId?: string;
  network: SocialNetwork;
  accountId: string;
  url?: string;
  mediaId?: string;
  text: string;
  title?: string;
  images: string[];
  createdAt: string;
  deletedAt?: string;
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
  // Heading of a warning card (conflict when unset, as in older entries).
  title?: string;
  // Result of the tool call behind an activity row, once it is known.
  ok?: boolean;
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
  // A saved prompt's run, or a message of the quick chat.
  kind?: "prompt" | "chat";
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
  // The prompt the generator used, when the provider rewrites it (Codex).
  revisedPrompt?: string;
  // Images sent to be edited or used as references, in order.
  references?: string[];
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
  voice?: import("./voice").VoiceOptions;
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
  // Stops agents that keep repeating an action that is not working.
  loopGuard?: LoopGuardSettings;
  // Confirmation before commands that delete a lot or discard work.
  deleteGuard?: DeleteGuardSettings;
  // Sub-agents of chats without their own; with syncSubagents, of every chat.
  defaultSubagents?: SubagentOptions;
  syncSubagents?: boolean;
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
export interface LoopGuardSettings {
  enabled: boolean;
  // The same action with no file edited in between.
  repeats: number;
  // Failed tool calls in a row.
  failures: number;
}
export const defaultLoopGuard: LoopGuardSettings = {
  enabled: true,
  repeats: 4,
  failures: 6,
};
// Self update from a folder of portable builds.
export interface UpdateState {
  current: string;
  folder?: string;
  available?: { version: string; path: string };
  // waiting: the user asked to update and something is still running.
  status: "idle" | "waiting" | "applying";
  error?: string;
}
// Running from the project folder instead of a packaged build.
export interface SourceState {
  root?: string;
  building: boolean;
  error?: string;
  // Built since this window (interface) or process (core) loaded.
  interface: boolean;
  core: boolean;
  builtAt?: string;
  // The user asked to restart and something is still running.
  waiting?: boolean;
}
export interface Snapshot {
  projects: Project[];
  tasks: Task[];
  prompts: SavedPrompt[];
  work: WorkItem[];
  update?: UpdateState;
  source?: SourceState;
  settings: Settings;
  agents: AgentInfo[];
  secrets: UserSecret[];
}
export type AgentEvent =
  | { type: "text"; text: string }
  // Files lists what an edit tool changed, to spot conflicting chats; key
  // identifies the action with its full input, to spot an agent repeating it.
  // id: the tool call, so its outcome marks the same row.
  | {
      type: "activity";
      text: string;
      files?: string[];
      key?: string;
      id?: string;
    }
  // Whether a tool call (command, edit, MCP tool) worked.
  | { type: "outcome"; ok: boolean; id?: string }
  // A plan proposed in plan mode (Claude's ExitPlanMode, a Codex plan item).
  | { type: "plan"; text: string; path?: string }
  | { type: "request"; request: RequestPrompt }
  | { type: "native"; id: string }
  | {
      type: "usage";
      used: number;
      size?: number;
      parts?: ContextPart[];
      deferred?: number;
    }
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
  // Changes the permission mode of the running session (after a plan).
  setMode?(mode: Task["mode"]): Promise<void>;
  respond(id: string, value: any): void;
  interrupt(): Promise<void>;
  close(): void;
  models(): Promise<Model[]>;
}
export type AppEvent =
  | { type: "voice"; state: import("./voice").VoiceState }
  | { type: "task-signal"; signal: import("./voice").TaskSignal }
  | { type: "refresh"; taskId?: string }
  | { type: "terminal"; taskId: string; data: string }
  | { type: "image-progress"; taskId: string; message: string }
  // A notification was clicked: show this task.
  | { type: "open-task"; taskId: string }
  // A task got a new plan: show it in the side panel.
  | { type: "plan"; taskId: string }
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
// The sub-agents a chat uses: the default from Settings when it is applied to
// every chat, otherwise the chat's own, falling back to that default.
export function subagentsFor(
  task: Pick<Task, "subagents">,
  settings: Pick<Settings, "defaultSubagents" | "syncSubagents">,
) {
  const fallback = settings.defaultSubagents ?? defaultSubagents;
  return settings.syncSubagents ? fallback : (task.subagents ?? fallback);
}
// How the agents are told what their sub-agents run: "Codex · gpt-6-luna ·
// esforço xhigh, até 4 ao mesmo tempo".
export function subagentLabel(
  o: Pick<SubagentOptions, "agent" | "model" | "effort" | "max">,
) {
  return [
    agentNames[o.agent] ?? o.agent,
    o.model || "modelo padrão",
    ...(o.effort ? [`esforço ${o.effort}`] : []),
  ]
    .join(" · ")
    .concat(o.max > 1 ? `, até ${o.max} ao mesmo tempo` : ", um por vez");
}
export const defaultImages: ImageOptions = {
  provider: "codex",
  model: "gpt-image",
  quality: "auto",
  size: "1024x1024",
  workflow: "sdxl-text",
  seed: 0,
};
