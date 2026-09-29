import { useEffect, useState, type ReactNode } from "react";
import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Code2,
  FileJson,
  FolderOpen,
  Image as ImageIcon,
  KeyRound,
  Layers,
  Monitor,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Share2,
  SlidersHorizontal,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type {
  ImageModel,
  McpConfig,
  Settings,
  SkillInfo,
  Snapshot,
  Task,
  Workflow,
  ImageProviderId,
} from "../shared/types";
import {
  agentIds,
  agentNames,
  defaultGuidelines,
  defaultLoopGuard,
  defaultSubagents,
} from "../shared/types";
import { api } from "./api";
import { SubagentOptionsForm, Switch } from "./parts";
import { SocialSettings } from "./Social";
// Settings sections, in the order of the side navigation.
const sections = [
  {
    id: "Agentes",
    icon: Bot,
    title: "Agentes e modelos",
    description: "Use os CLIs instalados neste computador.",
  },
  {
    id: "Comportamento",
    icon: SlidersHorizontal,
    title: "Comportamento dos agentes",
    description: "Como as tarefas começam, delegam e param.",
  },
  {
    id: "Imagens",
    icon: ImageIcon,
    title: "Geração de imagens",
    description: "Conecte seus modelos em nuvem e seus workflows locais.",
  },
  {
    id: "Skills",
    icon: Layers,
    title: "Skills",
    description: "Skills locais que os agentes podem usar nas tarefas.",
  },
  {
    id: "MCP",
    icon: Plug,
    title: "Conexões MCP",
    description: "Servidores de ferramentas oferecidos aos agentes.",
  },
  {
    id: "Redes sociais",
    icon: Share2,
    title: "Redes sociais",
    description:
      "Instagram e Patreon de cada projeto, para os agentes publicarem com a sua aprovação.",
  },
  {
    id: "Aplicativo",
    icon: Monitor,
    title: "Aplicativo",
    description: "Notificações, atualizações e modo código do Codebit.",
  },
];
// A setting with its name and explanation on the left, the control on the right.
function SettingRow({
  title,
  help,
  children,
}: {
  title: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <strong>{title}</strong>
        {help && <small>{help}</small>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}
export function SettingsView({
  snapshot,
  extensionsOnly,
  task,
  refresh,
  run,
  invokeSkill,
}: {
  snapshot?: Snapshot;
  extensionsOnly: boolean;
  task?: Task;
  refresh: () => Promise<void>;
  run: any;
  invokeSkill: (name: string, path: string) => void;
}) {
  const [tab, setTab] = useState(extensionsOnly ? "Skills" : "Agentes");
  const [settings, setSettings] = useState<Settings>();
  const [key, setKey] = useState("");
  const [imageModels, setImageModels] = useState<ImageModel[]>([]);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState("");
  const [extensionData, setExtensionData] = useState<{
    skills: SkillInfo[];
    nativeMcp: any[];
  }>({ skills: [], nativeMcp: [] });
  const [filter, setFilter] = useState("");
  const [mcpDraft, setMcpDraft] = useState("");
  const [workflow, setWorkflow] = useState<Workflow>();
  const [bindings, setBindings] = useState("");
  useEffect(() => {
    setSettings(snapshot?.settings);
  }, [JSON.stringify(snapshot?.settings)]);
  useEffect(() => {
    setTab(extensionsOnly ? "Skills" : "Agentes");
  }, [extensionsOnly]);
  useEffect(() => {
    if (tab === "Skills" || tab === "MCP")
      void run(async () =>
        setExtensionData(await api("extensions", { taskId: task?.id })),
      );
  }, [tab, task?.id]);
  if (!settings || !snapshot)
    return (
      <div className="settings-page">
        <p>Carregando configurações…</p>
      </div>
    );
  const guard = settings.loopGuard ?? defaultLoopGuard;
  const subagentDefaults = settings.defaultSubagents ?? defaultSubagents;
  async function save(value: Settings) {
    await api("settings.save", value);
    setNotice("Configurações salvas.");
    await refresh();
  }
  async function checkImages(provider: ImageProviderId) {
    setChecking(true);
    try {
      setImageModels(await api("images.models", { provider }));
    } finally {
      setChecking(false);
    }
  }
  const section = sections.find((s) => s.id === tab) ?? sections[0];
  return (
    <div className="settings-page">
      <nav className="settings-nav" aria-label="Seções das configurações">
        {sections.map((s) => (
          <button
            key={s.id}
            className={tab === s.id ? "selected" : ""}
            aria-current={tab === s.id ? "page" : undefined}
            onClick={() => {
              setTab(s.id);
              setNotice("");
            }}
          >
            <s.icon size={16} />
            {s.id}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        <div className="settings-heading">
          <div>
            <h2>{section.title}</h2>
            <p>{section.description}</p>
          </div>
          {tab === "Agentes" && (
            <button
              className="quiet"
              onClick={() =>
                void run(async () => {
                  setChecking(true);
                  try {
                    await api("detect");
                  } finally {
                    setChecking(false);
                  }
                })
              }
            >
              <RefreshCw size={16} className={checking ? "spin" : ""} />
              Verificar novamente
            </button>
          )}
        </div>
        {notice && (
          <div className="notice" role="status">
            <Check size={15} />
            {notice}
            <button
              className="icon"
              aria-label="Fechar aviso"
              onClick={() => setNotice("")}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {tab === "Agentes" && (
          <div className="settings-grid">
            <section>
              {snapshot.agents.map((a) => (
                <div className="provider-card" key={a.id}>
                  <div className="provider-top">
                    <div className={`provider-monogram ${a.id}`}>
                      {a.id === "codex" ? (
                        <Code2 size={30} />
                      ) : (
                        agentNames[a.id][0]
                      )}
                    </div>
                    <div className="provider-identity">
                      <h3>{a.name}</h3>
                      <span>
                        {a.selected
                          ? "Versão " + a.selected.version
                          : "Instalação não encontrada"}
                      </span>
                      <code title={a.selected?.path}>
                        {a.selected?.path || "Selecione o executável instalado"}
                      </code>
                    </div>
                    <div className="provider-actions">
                      <button
                        className="quiet compact"
                        onClick={() =>
                          void run(() =>
                            api("settings.cliPath", { agent: a.id }),
                          )
                        }
                      >
                        <FolderOpen size={14} />
                        Selecionar caminho
                      </button>
                      <button
                        className="quiet compact"
                        disabled={!a.selected}
                        onClick={() =>
                          void run(() => api("auth", { agent: a.id }))
                        }
                      >
                        <KeyRound size={14} />
                        Verificar acesso
                      </button>
                    </div>
                  </div>
                  <div className="provider-status">
                    <div>
                      <small>Instalação</small>
                      <span className={a.selected ? "green" : "muted"}>
                        {a.selected ? (
                          <Check size={15} />
                        ) : (
                          <CircleAlert size={15} />
                        )}{" "}
                        {a.selected ? "Detectado" : "Não encontrado"}
                      </span>
                    </div>
                    <div>
                      <small>Acesso</small>
                      <span
                        className={a.auth === "ready" ? "green" : "amber-text"}
                      >
                        {a.auth === "ready" ? (
                          <Check size={15} />
                        ) : (
                          <CircleAlert size={15} />
                        )}{" "}
                        {a.auth === "ready"
                          ? "Configurado"
                          : a.auth === "unknown"
                            ? "Verificar login"
                            : a.auth === "missing"
                              ? "Login necessário"
                              : "Verificar configuração"}
                      </span>
                    </div>
                    <div>
                      <small>Modelos disponíveis</small>
                      <span>
                        {a.catalogStatus === "loading"
                          ? "Consultando o CLI…"
                          : a.models.length
                            ? `${a.models.length} disponíveis`
                            : a.catalogStatus === "error"
                              ? "Catálogo indisponível"
                              : "Aguardando descoberta"}
                      </span>
                    </div>
                  </div>
                  {a.authMessage && <p className="help">{a.authMessage}</p>}
                  {a.catalogError && <p className="help">{a.catalogError}</p>}
                  {a.installations.length > 1 && (
                    <label className="installation-choice">
                      Instalação selecionada
                      <select
                        value={a.selected?.path}
                        onChange={(e) =>
                          void run(async () => {
                            await save({
                              ...settings,
                              cliPaths: {
                                ...settings.cliPaths,
                                [a.id]: e.target.value,
                              },
                            });
                            await api("detect");
                          })
                        }
                      >
                        {a.installations.map((i) => (
                          <option key={i.path} value={i.path}>
                            {i.path} · {i.version}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              ))}
              <div className="settings-card">
                <div className="card-head">
                  <h3>Modelo padrão por agente</h3>
                  <p className="help">
                    Deixe vazio para usar o padrão do CLI. Identificadores
                    informados manualmente serão verificados pelo agente ao
                    iniciar uma tarefa.
                  </p>
                </div>
                <div className="form-grid three">
                  {agentIds.map((a) => (
                    <label key={a}>
                      {agentNames[a]}
                      <input
                        aria-label={`Modelo padrão ${a}`}
                        value={settings.defaultModels[a]}
                        placeholder="Padrão do CLI"
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            defaultModels: {
                              ...settings.defaultModels,
                              [a]: e.target.value,
                            },
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <div className="row-actions">
                  <button
                    className="quiet"
                    onClick={() => void run(() => save(settings))}
                  >
                    Salvar padrões
                  </button>
                </div>
              </div>
            </section>
            <aside className="settings-inspector">
              <h3>Um fluxo, três agentes</h3>
              <div className="capability-list">
                {[
                  "Conversa em streaming",
                  "Retomar tarefas",
                  "Aprovações na conversa",
                  "Skills locais",
                  "Ferramentas MCP",
                ].map((c) => (
                  <div key={c}>
                    <Check size={15} />
                    {c}
                  </div>
                ))}
              </div>
              <div className="divider" />
              <h3>Credenciais no CLI</h3>
              <p>O login continua sendo gerenciado pelo agente.</p>
              <p className="help">Se necessário, execute no terminal:</p>
              <code className="command">codex login</code>
              <code className="command">claude auth login</code>
              <code className="command">devin auth login</code>
              <div className="divider" />
              <p className="help">
                Uma instalação detectada ainda pode exigir login ou atualização.
                O Codebit informa falhas de protocolo sem substituir o agente.
              </p>
            </aside>
          </div>
        )}
        {tab === "Comportamento" && (
          <section className="settings-stack">
            <div className="settings-card">
              <div className="card-head">
                <h3>Diretrizes para os agentes</h3>
                <p className="help">
                  Enviadas a Codex, Claude e Devin no início de cada tarefa.
                  Tarefas já abertas recebem as novas diretrizes na próxima
                  sessão.
                </p>
              </div>
              <textarea
                className="guidelines"
                aria-label="Diretrizes para os agentes"
                value={settings.guidelines ?? ""}
                placeholder="Nenhuma diretriz"
                onChange={(e) =>
                  setSettings({ ...settings, guidelines: e.target.value })
                }
              />
              <div className="row-actions">
                <button
                  className="quiet"
                  onClick={() => void run(() => save(settings))}
                >
                  Salvar diretrizes
                </button>
                <button
                  className="quiet"
                  disabled={settings.guidelines === defaultGuidelines}
                  onClick={() =>
                    setSettings({ ...settings, guidelines: defaultGuidelines })
                  }
                >
                  Restaurar padrão
                </button>
              </div>
            </div>
            <div className="settings-card">
              <SettingRow
                title="Modo das novas tarefas"
                help="Cada tarefa pode trocar de modo depois, abaixo da conversa. Em Bypass, o agente e os sub-agentes executam comandos e alteram arquivos sem pedir permissão."
              >
                <div
                  className="mode-toggle settings-mode"
                  role="group"
                  aria-label="Modo das novas tarefas"
                >
                  {(
                    [
                      ["plan", "Planejar"],
                      ["execute", "Executar"],
                      ["bypass", "Bypass"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      className={`${mode === "bypass" ? "bypass" : ""} ${(settings.defaultMode ?? "bypass") === mode ? "selected" : ""}`}
                      aria-pressed={(settings.defaultMode ?? "bypass") === mode}
                      onClick={() =>
                        void run(() => save({ ...settings, defaultMode: mode }))
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </SettingRow>
            </div>
            <div className="settings-card subagents-defaults">
              <div className="card-head">
                <h3>Sub-agentes padrão</h3>
                <p className="help">
                  {settings.syncSubagents
                    ? "Todas as conversas usam esta configuração, inclusive as que você ajustou, e mudanças aqui valem na hora para todas. O ajuste por conversa fica bloqueado."
                    : "Vale para as conversas sem configuração própria, incluindo as novas. Conversas em que você ajustou os sub-agentes mantêm a delas."}
                </p>
              </div>
              <SubagentOptionsForm
                value={subagentDefaults}
                agents={snapshot.agents}
                defaultModels={settings.defaultModels}
                onChange={(patch) =>
                  void run(() =>
                    save({
                      ...settings,
                      defaultSubagents: { ...subagentDefaults, ...patch },
                    }),
                  )
                }
              />
              <div className="card-divider" />
              <Switch
                checked={!!settings.syncSubagents}
                onChange={(syncSubagents) =>
                  void run(() => save({ ...settings, syncSubagents }))
                }
              >
                Aplicar a todas as conversas automaticamente
              </Switch>
            </div>
            <div className="settings-card">
              <div className="card-head">
                <h3>Proteção contra repetição</h3>
                <p className="help">
                  Vale para agentes, sub-agentes e prompts salvos. Ao parar, o
                  Codebit explica o que se repetiu, avisa você e conta o motivo
                  ao agente na mensagem seguinte. Ler arquivos e acompanhar
                  comandos em segundo plano não contam como tentativa, e editar
                  um arquivo entre as tentativas conta como progresso.
                </p>
              </div>
              <Switch
                checked={guard.enabled}
                onChange={(enabled) =>
                  void run(() =>
                    save({ ...settings, loopGuard: { ...guard, enabled } }),
                  )
                }
              >
                Parar o agente quando ele insistir numa ação que não funciona
              </Switch>
              {(
                [
                  [
                    "repeats",
                    "Mesma ação, sem editar arquivos",
                    "Tentativas iguais seguidas, sem nenhum arquivo alterado entre elas.",
                  ],
                  [
                    "failures",
                    "Falhas seguidas",
                    "Ações que falham uma depois da outra, sem nenhum sucesso no meio.",
                  ],
                ] as const
              ).map(([field, label, help]) => (
                <SettingRow key={field} title={label} help={help}>
                  <input
                    className="narrow"
                    type="number"
                    min={2}
                    max={50}
                    disabled={!guard.enabled}
                    aria-label={label}
                    value={guard[field]}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        loopGuard: {
                          ...guard,
                          [field]: Number(e.target.value),
                        },
                      })
                    }
                    onBlur={() => void run(() => save(settings))}
                  />
                </SettingRow>
              ))}
            </div>
          </section>
        )}
        {tab === "Redes sociais" && (
          <SocialSettings snapshot={snapshot} task={task} run={run} />
        )}
        {tab === "Aplicativo" && (
          <section className="settings-stack">
            <div className="settings-card">
              <div className="card-head">
                <h3>Notificações</h3>
                <p className="help">
                  Só com o Codebit em segundo plano. Clicar na notificação abre
                  a tarefa.
                </p>
              </div>
              <Switch
                checked={settings.notifications !== false}
                onChange={(notifications) =>
                  void run(() => save({ ...settings, notifications }))
                }
              >
                Notificar no Windows quando uma tarefa terminar, falhar ou
                precisar de você
              </Switch>
            </div>
            <div className="settings-card">
              <div className="card-head">
                <h3>Atualizações do Codebit</h3>
                <p className="help">
                  O Codebit procura na pasta abaixo versões
                  Codebit-X.Y.Z-Windows.exe acompanhadas do arquivo .sha256
                  correspondente. Por padrão, é a pasta de onde ele foi aberto.
                  Ao clicar em Atualizar, ele espera as tarefas terminarem, abre
                  a versão nova e fecha esta; as conversas continuam na mesma
                  sessão dos agentes.
                </p>
              </div>
              <div className="property">
                <span>Versão em uso</span>
                <strong>v{snapshot.update?.current}</strong>
              </div>
              <div className="property">
                <span>Versão nova</span>
                <strong>
                  {snapshot.update?.available
                    ? `v${snapshot.update.available.version}`
                    : "Nenhuma"}
                </strong>
              </div>
              <div className="property">
                <span>Pasta</span>
                <code className="update-folder" title={snapshot.update?.folder}>
                  {snapshot.update?.folder ?? "Não definida"}
                </code>
              </div>
              {snapshot.update?.error && (
                <p className="help amber-text">{snapshot.update.error}</p>
              )}
              <div className="row-actions">
                <button
                  className="quiet"
                  onClick={() => void run(() => api("settings.updateFolder"))}
                >
                  <FolderOpen size={14} />
                  Escolher pasta
                </button>
                <button
                  className="quiet"
                  onClick={() => void run(() => api("update.check"))}
                >
                  <RefreshCw size={14} />
                  Verificar agora
                </button>
              </div>
            </div>
            {snapshot.source && (
              <div className="settings-card">
                <div className="card-head">
                  <h3>Modo código</h3>
                  <p className="help">
                    Mudanças em src/ são preparadas sozinhas. A interface nova
                    aplica ao recarregar a janela; mudanças no núcleo pedem
                    reinício, que espera as tarefas terminarem.
                  </p>
                </div>
                <div className="property">
                  <span>Rodando da pasta</span>
                  <code className="update-folder">{snapshot.source.root}</code>
                </div>
                <div className="property">
                  <span>Último preparo</span>
                  <strong>
                    {snapshot.source.building
                      ? "Preparando…"
                      : snapshot.source.builtAt
                        ? new Date(snapshot.source.builtAt).toLocaleString(
                            "pt-BR",
                          )
                        : "Nenhum desde que abriu"}
                  </strong>
                </div>
                {snapshot.source.error && (
                  <pre className="source-error">{snapshot.source.error}</pre>
                )}
                <div className="row-actions">
                  <button
                    className="quiet"
                    disabled={snapshot.source.building}
                    onClick={() => void run(() => api("source.build"))}
                  >
                    <RefreshCw size={14} />
                    Preparar agora
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
        {tab === "Imagens" && (
          <div className="settings-grid">
            <section>
              {(() => {
                const codex = snapshot.agents.find((a) => a.id === "codex");
                return (
                  <div className="settings-card">
                    <div className="card-title">
                      <div className="provider-monogram codex">
                        <Code2 size={25} />
                      </div>
                      <div>
                        <h3>Codex · Login local</h3>
                        <p>Geração e edição com GPT Image pelo Codex CLI</p>
                      </div>
                      <span
                        className={`badge ${codex?.selected && codex.auth === "ready" ? "success" : ""}`}
                      >
                        {!codex?.selected
                          ? "CLI não encontrado"
                          : codex.auth === "ready"
                            ? "Login configurado"
                            : "Verificar login"}
                      </span>
                    </div>
                    <p className="help">
                      Usa a instalação e o login do Codex detectados em Agentes,
                      sem chave da API. O Codex escolhe o modelo de imagem, e o
                      uso conta nos limites da sua assinatura.
                    </p>
                    <div className="button-row">
                      <button
                        className="quiet"
                        disabled={!codex?.selected || checking}
                        onClick={() => void run(() => checkImages("codex"))}
                      >
                        <RefreshCw size={14} />
                        Verificar acesso
                      </button>
                    </div>
                  </div>
                );
              })()}
              <div className="settings-card">
                <div className="card-title">
                  <div className="provider-monogram codex">
                    <Code2 size={25} />
                  </div>
                  <div>
                    <h3>OpenAI</h3>
                    <p>Geração e edição com GPT Image</p>
                  </div>
                  <span
                    className={`badge ${snapshot.settings.hasOpenAIKey ? "success" : ""}`}
                  >
                    {snapshot.settings.hasOpenAIKey
                      ? "Chave configurada"
                      : "Configuração pendente"}
                  </span>
                </div>
                <label>
                  Chave da API
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      snapshot.settings.hasOpenAIKey
                        ? "Digite para substituir a chave"
                        : "Sua chave da API OpenAI"
                    }
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                  />
                </label>
                <p className="help">
                  Armazenada com a proteção do Windows. A cobrança de imagens
                  usa sua conta da API, separada do login do Codex.
                </p>
                <div className="button-row">
                  <button
                    className="primary"
                    disabled={!key.trim()}
                    onClick={() =>
                      void run(async () => {
                        await api("settings.key", { key });
                        setKey("");
                        setNotice("Chave salva com proteção do Windows.");
                        await refresh();
                      })
                    }
                  >
                    Salvar chave
                  </button>
                  <button
                    className="quiet"
                    disabled={!snapshot.settings.hasOpenAIKey || checking}
                    onClick={() => void run(() => checkImages("openai"))}
                  >
                    Consultar modelos
                  </button>
                  {snapshot.settings.hasOpenAIKey && (
                    <button
                      className="text-button"
                      onClick={() =>
                        void run(async () => {
                          await api("settings.key", { key: "" });
                          await refresh();
                        })
                      }
                    >
                      Remover chave salva
                    </button>
                  )}
                </div>
              </div>
              <div className="settings-card">
                <div className="card-title">
                  <div className="provider-monogram">
                    <Layers size={25} />
                  </div>
                  <div>
                    <h3>ComfyUI</h3>
                    <p>Modelos e workflows na sua máquina</p>
                  </div>
                </div>
                <label>
                  Endereço do servidor
                  <input
                    value={settings.comfyUrl}
                    onChange={(e) =>
                      setSettings({ ...settings, comfyUrl: e.target.value })
                    }
                  />
                </label>
                <div className="button-row">
                  <button
                    className="quiet"
                    onClick={() => void run(() => save(settings))}
                  >
                    Salvar endereço
                  </button>
                  <button
                    className="quiet"
                    disabled={checking}
                    onClick={() =>
                      void run(async () => {
                        await save(settings);
                        await checkImages("comfyui");
                      })
                    }
                  >
                    <RefreshCw size={14} />
                    Verificar conexão
                  </button>
                </div>
                <p className="help">
                  Inclui presets SDXL de texto para imagem e imagem para imagem.
                  O ComfyUI e os modelos devem estar instalados e em execução.
                </p>
                <div className="divider" />
                <h3>Workflows personalizados</h3>
                {settings.workflows.map((w) => (
                  <div className="extension-row" key={w.id}>
                    <FileJson size={18} />
                    <div>
                      <strong>{w.name}</strong>
                      <small>{w.kind === "edit" ? "Edição" : "Geração"}</small>
                    </div>
                    <button
                      className="icon"
                      title="Editar mapeamento"
                      onClick={() => {
                        setWorkflow(w);
                        setBindings(JSON.stringify(w.bindings, null, 2));
                      }}
                    >
                      <ChevronRight size={17} />
                    </button>
                    <button
                      className="icon"
                      title="Remover workflow"
                      onClick={() =>
                        void run(() =>
                          save({
                            ...settings,
                            workflows: settings.workflows.filter(
                              (x) => x.id !== w.id,
                            ),
                          }),
                        )
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
                <button
                  className="quiet"
                  onClick={() =>
                    void run(async () => {
                      const w = await api<Workflow | null>("workflow.import");
                      if (w) {
                        setWorkflow(w);
                        setBindings(JSON.stringify(w.bindings, null, 2));
                      }
                    })
                  }
                >
                  <Plus size={16} />
                  Importar workflow API
                </button>
              </div>
            </section>
            <aside className="settings-inspector">
              <h3>Modelos encontrados</h3>
              {checking ? (
                <p>Consultando o provedor…</p>
              ) : imageModels.length ? (
                imageModels.map((m) => (
                  <div className="model-result" key={m.id + "|" + m.workflow}>
                    <span className={m.available ? "green" : "amber-text"}>
                      {m.available ? (
                        <Check size={15} />
                      ) : (
                        <CircleAlert size={15} />
                      )}
                    </span>
                    <div>
                      <strong>{m.name}</strong>
                      <small>
                        {m.reason ||
                          "Listado pelo provedor; a execução depende de acesso e recursos disponíveis."}
                      </small>
                    </div>
                  </div>
                ))
              ) : (
                <p>Consulte um provedor para ver os modelos disponíveis.</p>
              )}
            </aside>
          </div>
        )}
        {tab === "Skills" && (
          <section>
            <label className="search settings-search">
              <Search size={16} />
              <input
                placeholder="Buscar skills"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </label>
            <p className="help">
              Skills locais reconhecidas nos diretórios dos agentes. Cada CLI
              continua responsável pela descoberta e execução de suas extensões.
            </p>
            {!extensionData.skills.length && (
              <div className="empty-card">
                Nenhuma skill encontrada nos diretórios locais deste projeto e
                usuário.
              </div>
            )}
            {extensionData.skills
              .filter((s) =>
                (s.name + s.description)
                  .toLowerCase()
                  .includes(filter.toLowerCase()),
              )
              .map((s) => (
                <div className="skill-row" key={s.agent + s.path}>
                  <Layers size={20} />
                  <div>
                    <strong>
                      {s.name}
                      <span className="badge">{s.agent}</span>
                    </strong>
                    <p>{s.description || "Skill local"}</p>
                    <code>{s.path}</code>
                  </div>
                  {task && task.agent === s.agent && (
                    <button
                      className="quiet compact"
                      onClick={() => invokeSkill(s.name, s.path)}
                    >
                      Usar na tarefa
                    </button>
                  )}
                </div>
              ))}
          </section>
        )}
        {tab === "MCP" && (
          <section>
            <div className="section-heading">
              <div>
                <h3>Conexões do Codebit</h3>
                <p className="help">
                  Servidores adicionais são aplicados à próxima execução. As
                  configurações globais dos CLIs são preservadas.
                </p>
              </div>
              <button
                className="quiet"
                onClick={() =>
                  setMcpDraft(
                    JSON.stringify(
                      {
                        id: crypto.randomUUID(),
                        name: "meu-servidor",
                        agent: "both",
                        enabled: true,
                        transport: "stdio",
                        command: "",
                        args: [],
                      },
                      null,
                      2,
                    ),
                  )
                }
              >
                <Plus size={16} />
                Adicionar conexão
              </button>
            </div>
            <div className="extension-row">
              <Layers size={20} />
              <div>
                <strong>codebit_images</strong>
                <small>
                  Geração e edição de imagens · conexão interna por tarefa
                </small>
              </div>
              <span className="badge success">Integrado</span>
            </div>
            <div className="extension-row">
              <Users size={20} />
              <div>
                <strong>codebit_agents</strong>
                <small>
                  Sub-agentes · oferecida ao agente quando a delegação está
                  ligada
                </small>
              </div>
              <span className="badge success">Integrado</span>
            </div>
            <div className="extension-row">
              <Share2 size={19} />
              <div>
                <strong>codebit_social</strong>
                <small>
                  Instagram e Patreon · oferecida nas tarefas de projetos com
                  redes conectadas; cada post espera a sua aprovação
                </small>
              </div>
              <span className="badge success">Integrado</span>
            </div>
            {settings.mcp.map((m) => (
              <div className="extension-row" key={m.id}>
                <Layers size={19} />
                <div>
                  <strong>{m.name}</strong>
                  <small>
                    {m.agent} · {m.transport} ·{" "}
                    {m.enabled ? "Ativo" : "Desativado"}
                  </small>
                </div>
                <button
                  className="quiet compact"
                  onClick={() => setMcpDraft(JSON.stringify(m, null, 2))}
                >
                  Editar
                </button>
                <button
                  className="icon"
                  title="Remover conexão"
                  onClick={() =>
                    void run(() =>
                      save({
                        ...settings,
                        mcp: settings.mcp.filter((x) => x.id !== m.id),
                      }),
                    )
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
            <h3 className="subheading">Configurações nativas detectadas</h3>
            {extensionData.nativeMcp.map((m, i) => (
              <div className="extension-row" key={i}>
                <Layers size={18} />
                <div>
                  <strong>
                    {m.name}
                    <span className="badge">{m.agent}</span>
                  </strong>
                  <small>{m.source}</small>
                </div>
                <span className="help">Gerenciado pelo CLI</span>
              </div>
            ))}
            {!extensionData.nativeMcp.length && (
              <p className="help">
                Nenhum servidor encontrado nos arquivos de configuração
                consultados.
              </p>
            )}
          </section>
        )}
      </div>
      {mcpDraft && (
        <div className="modal-backdrop">
          <div className="modal wide">
            <div className="modal-header">
              <h2>Conexão MCP</h2>
              <button className="icon" onClick={() => setMcpDraft("")}>
                <X size={18} />
              </button>
            </div>
            <p className="help">
              Configure command e args para stdio; url para HTTP (o Devin aceita
              apenas stdio). Agente: codex, claude, devin ou both (todos). No
              campo env, use {'"TOKEN": "${MINHA_VARIAVEL}"'} para ler uma
              variável do ambiente sem salvar seu segredo.
            </p>
            <textarea
              className="json-editor"
              value={mcpDraft}
              onChange={(e) => setMcpDraft(e.target.value)}
              spellCheck={false}
            />
            <div className="modal-actions">
              <button className="quiet" onClick={() => setMcpDraft("")}>
                Cancelar
              </button>
              <button
                className="primary"
                onClick={() =>
                  void run(async () => {
                    const value: McpConfig = JSON.parse(mcpDraft);
                    await save({
                      ...settings,
                      mcp: [
                        ...settings.mcp.filter((m) => m.id !== value.id),
                        value,
                      ],
                    });
                    setMcpDraft("");
                  })
                }
              >
                Salvar conexão
              </button>
            </div>
          </div>
        </div>
      )}
      {workflow && (
        <div className="modal-backdrop">
          <div className="modal wide">
            <div className="modal-header">
              <h2>Mapear workflow</h2>
              <button className="icon" onClick={() => setWorkflow(undefined)}>
                <X size={18} />
              </button>
            </div>
            <label>
              Nome
              <input
                value={workflow.name}
                onChange={(e) =>
                  setWorkflow({ ...workflow, name: e.target.value })
                }
              />
            </label>
            <label>
              Operação
              <select
                value={workflow.kind}
                onChange={(e) =>
                  setWorkflow({ ...workflow, kind: e.target.value as any })
                }
              >
                <option value="generate">Geração</option>
                <option value="edit">Edição com imagem</option>
              </select>
            </label>
            <p className="help">
              Associe prompt, model, seed, width, height e image aos campos do
              grafo. Exemplo: "prompt": "6.inputs.text". Mantenha apenas os
              campos usados pelo workflow.
            </p>
            <textarea
              className="json-editor"
              value={bindings}
              onChange={(e) => setBindings(e.target.value)}
              spellCheck={false}
            />
            <details>
              <summary>Nós disponíveis</summary>
              <pre>
                {Object.entries(workflow.graph)
                  .map(
                    ([id, n]) =>
                      `${id}: ${n.class_type} — ${Object.keys(n.inputs || {}).join(", ")}`,
                  )
                  .join("\n")}
              </pre>
            </details>
            <div className="modal-actions">
              <button className="quiet" onClick={() => setWorkflow(undefined)}>
                Cancelar
              </button>
              <button
                className="primary"
                onClick={() =>
                  void run(async () => {
                    const value = {
                      ...workflow,
                      bindings: JSON.parse(bindings),
                    };
                    await save({
                      ...settings,
                      workflows: [
                        ...settings.workflows.filter((w) => w.id !== value.id),
                        value,
                      ],
                    });
                    setWorkflow(undefined);
                  })
                }
              >
                Salvar workflow
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
