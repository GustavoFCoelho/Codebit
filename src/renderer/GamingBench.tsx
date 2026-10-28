import { useEffect, useState } from "react";
import { Gamepad2, Play, ExternalLink, Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import type { AgentId, GamingBenchPrompt, Snapshot, Task } from "../shared/types";
import { agentIds, agentNames } from "../shared/types";
import { api } from "./api";

const categories = [
  { id: "frontier", title: "Bench Modelos de Fronteira", description: "Desafios amplos de arquitetura, implementação e validação." },
  { id: "mid", title: "Bench Modelos de meio termo", description: "Tarefas focadas de implementação e diagnóstico." },
  { id: "economic", title: "Bench de modelos econômicos", description: "Desafios curtos com escopo e critérios objetivos." },
] as const;

const defaults: GamingBenchPrompt[] = [
  { id: "frontier-survival", category: "frontier", name: "Loop de sobrevivência", prompt: "Implemente um loop de sobrevivência para um jogo 2D: coleta, inventário limitado, ciclo dia/noite e condição de derrota. Trabalhe em uma pasta temporária vazia, crie uma demonstração executável e valide os casos principais. Entregue resumo das decisões e arquivos criados." },
  { id: "frontier-boss", category: "frontier", name: "Combate com chefes", prompt: "Crie uma demonstração jogável de luta contra chefe com três fases legíveis, ataques telegráficos, janelas de vulnerabilidade e dificuldade crescente. Trabalhe em uma pasta temporária vazia, implemente e valide a solução sem dependências desnecessárias." },
  { id: "frontier-procedural", category: "frontier", name: "Geração procedural", prompt: "Implemente uma demonstração de geração procedural de uma área jogável. O mapa precisa ser alcançável do início ao objetivo, evitar salas isoladas e variar entre execuções. Inclua seed reproduzível e valide invariantes importantes." },
  { id: "mid-movement", category: "mid", name: "Movimento com aceleração", prompt: "Crie uma demonstração pequena de movimento de personagem com aceleração, desaceleração e limite de velocidade. Evite movimento diagonal mais rápido, inclua controles claros e valide os casos relevantes." },
  { id: "mid-enemy", category: "mid", name: "Inimigo perseguidor", prompt: "Implemente uma demonstração de inimigo que patrulha entre dois pontos, detecta o jogador dentro de um alcance e o persegue sem atravessar obstáculos. Trate perda de alvo e limites do mapa e valide o comportamento." },
  { id: "mid-save", category: "mid", name: "Salvar e carregar", prompt: "Implemente um exemplo autocontido de salvamento e carregamento de progresso de jogo. Persista apenas os dados necessários, lide com arquivo ausente ou inválido sem quebrar a inicialização e inclua uma verificação simples." },
  { id: "economic-score", category: "economic", name: "Pontuação e recorde", prompt: "Crie um exemplo mínimo de jogo com contador de pontos e recorde local persistente. Mostre a pontuação na interface e trate armazenamento indisponível com segurança." },
  { id: "economic-pause", category: "economic", name: "Pausa", prompt: "Implemente um exemplo de pausa e retomada de jogo pela tecla Escape. Ao pausar, interrompa atualizações de gameplay, mostre um indicador claro e evite disparos repetidos da tecla." },
  { id: "economic-collision", category: "economic", name: "Colisão", prompt: "Implemente uma função de colisão AABB 2D para retângulos alinhados aos eixos, com tratamento correto de bordas encostadas. Inclua testes para sobreposição, separação, contenção e contato de borda." },
];

export function GamingBench({ snapshot, run, onOpen }: {
  snapshot: Snapshot;
  run: (fn: () => Promise<unknown>) => void;
  onOpen: (id: string) => void;
}) {
  const availableAgents = snapshot.agents.filter((a) => a.installations.length);
  const [agent, setAgent] = useState<AgentId>(availableAgents[0]?.id ?? "codex");
  const selectedAgent = snapshot.agents.find((a) => a.id === agent);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [expandedBatches, setExpandedBatches] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [prompts, setPrompts] = useState<GamingBenchPrompt[]>(snapshot.settings.gamingBenchPrompts ?? defaults);

  useEffect(() => {
    setPrompts(snapshot.settings.gamingBenchPrompts ?? defaults);
  }, [JSON.stringify(snapshot.settings.gamingBenchPrompts)]);

  const persist = (next: GamingBenchPrompt[]) => {
    setPrompts(next);
    run(async () => {
      await api("settings.save", { ...snapshot.settings, gamingBenchPrompts: next });
    });
  };

  const selectedModel = selectedAgent?.models.find((m) => m.id === (model || snapshot.settings.defaultModels[agent]));
  const effectiveModelId = model || snapshot.settings.defaultModels[agent] || "Modelo padrão";
  const effectiveEffort = effort || selectedModel?.defaultEffort || "Padrão";
  const batchTitle = `${selectedModel?.name ?? effectiveModelId} · ${effectiveEffort}`;

  const runPrompt = async (category: string, item: GamingBenchPrompt, batch: { id: string; title: string; category: string; createdAt: string }) => {
    const title = `Gaming Bench · ${category} · ${item.name}`;
    // An empty projectId gives every benchmark task its own Codebit scratch folder.
    const task = await api<Task>("task.create", { projectId: "", title, agent, worktree: false, gamingBenchBatch: batch });
    if (model || effort) await api("task.update", { id: task.id, patch: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } });
    await api("task.send", { id: task.id, text: item.prompt, attachments: [] });
  };

  const startBatch = async (category: typeof categories[number], items: GamingBenchPrompt[]) => {
    const batch = { id: crypto.randomUUID(), title: batchTitle, category: category.title, createdAt: new Date().toISOString() };
    for (const item of items) await runPrompt(category.title, item, batch);
  };

  const runCategory = async (category: typeof categories[number]) => {
    const batch = prompts.filter((p) => p.category === category.id);
    if (!batch.length) return;
    setBusy(true);
    try {
      await startBatch(category, batch);
    } finally {
      setBusy(false);
    }
  };

  const updatePrompt = (id: string, changes: Partial<GamingBenchPrompt>) =>
    setPrompts((current) => current.map((p) => p.id === id ? { ...p, ...changes } : p));
  const savePrompts = () => persist(prompts);
  const addPrompt = (category: GamingBenchPrompt["category"]) => {
    const next = [...prompts, { id: crypto.randomUUID(), category, name: "Novo prompt", prompt: "Descreva o teste de jogo que o modelo deve executar." }];
    persist(next);
  };

  return (
    <div className="settings-content gaming-bench">
      <div className="settings-heading"><div><h2>Gaming Bench</h2><p>Edite os testes e compare modelos. Cada execução usa uma tarefa nova em uma pasta temporária independente, sem vínculo com seus projetos.</p></div></div>
      <div className="settings-card bench-config">
        <label>Agente<select value={agent} onChange={(e) => { setAgent(e.target.value as AgentId); setModel(""); setEffort(""); }}>
          {agentIds.map((id) => <option key={id} value={id}>{agentNames[id]}{!availableAgents.some((a) => a.id === id) ? " · não detectado" : ""}</option>)}
        </select></label>
        <label>Modelo<select value={model} onChange={(e) => { setModel(e.target.value); setEffort(""); }}>
          <option value="">Padrão do agente</option>
          {(selectedAgent?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.name} ({m.id})</option>)}
        </select></label>
        <label>Esforço<select value={effort} onChange={(e) => setEffort(e.target.value)}>
          <option value="">Padrão do modelo{selectedModel?.defaultEffort ? ` · ${selectedModel.defaultEffort}` : ""}</option>
          {(selectedModel?.efforts ?? []).map((value) => <option key={value} value={value}>{value}</option>)}
        </select></label>
      </div>
      <div className="bench-grid">
        {categories.map((category) => {
          const items = prompts.filter((p) => p.category === category.id);
          return <section className="settings-card bench-card" key={category.id}>
            <div className="bench-card-head"><Gamepad2 size={19} /><div><h3>{category.title}</h3><p>{category.description}</p></div></div>
            {items.map((item) => <div className="bench-prompt-editor" key={item.id}>
              <div className="bench-prompt-fields">
                <input aria-label="Nome do prompt" value={item.name} onChange={(e) => updatePrompt(item.id, { name: e.target.value })} onBlur={savePrompts} />
                <textarea aria-label={`Texto do prompt: ${item.name}`} value={item.prompt} onChange={(e) => updatePrompt(item.id, { prompt: e.target.value })} onBlur={savePrompts} />
                <select aria-label="Categoria do prompt" value={item.category} onChange={(e) => { const next = prompts.map((p) => p.id === item.id ? { ...p, category: e.target.value as GamingBenchPrompt["category"] } : p); persist(next); }}>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </select>
              </div>
              <div className="bench-prompt-actions">
                <button className="quiet compact" disabled={busy || !selectedAgent?.installations.length || !item.name.trim() || !item.prompt.trim()} onClick={() => run(() => startBatch(category, [item]))}><Play size={14} /> Executar</button>
                <button className="quiet compact danger-icon" aria-label={`Remover prompt ${item.name}`} title="Remover prompt" onClick={() => persist(prompts.filter((p) => p.id !== item.id))}><Trash2 size={14} /></button>
              </div>
            </div>)}
            <div className="bench-category-actions">
              <button className="quiet compact" onClick={() => addPrompt(category.id)}><Plus size={14} /> Adicionar prompt</button>
              <button className="primary" disabled={busy || !items.length || !selectedAgent?.installations.length} onClick={() => run(() => runCategory(category))}><Play size={15} /> Executar categoria</button>
            </div>
          </section>;
        })}
      </div>
      <div className="bench-history">
        <h3>Execuções por batch</h3>
        {(() => {
          const executions = snapshot.tasks.filter((t) => t.gamingBenchBatch || t.title.startsWith("Gaming Bench ·"));
          const groups = new Map<string, { id: string; title: string; category: string; createdAt: string; tasks: Task[] }>();
          for (const task of executions) {
            const batch = task.gamingBenchBatch;
            const id = batch?.id ?? `legacy-${task.id}`;
            const group = groups.get(id) ?? { id, title: batch?.title ?? `${task.model || "Modelo antigo"} · ${task.effort || "Padrão"}`, category: batch?.category ?? "Execução anterior", createdAt: batch?.createdAt ?? task.createdAt, tasks: [] };
            group.tasks.push(task);
            groups.set(id, group);
          }
          const recent = [...groups.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
          return recent.length ? recent.map((batch) => <section className="bench-run-card" key={batch.id}>
            <button className="bench-run-head" aria-expanded={!!expandedBatches[batch.id]} onClick={() => setExpandedBatches((current) => ({ ...current, [batch.id]: !current[batch.id] }))}>
              {expandedBatches[batch.id] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <span className="bench-run-title">{batch.title}</span><span className="badge">{batch.tasks.length} {batch.tasks.length === 1 ? "sessão" : "sessões"}</span>
            </button>
            {expandedBatches[batch.id] && <div className="bench-run-sessions">{batch.tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((task) => <button className="bench-history-item" key={task.id} onClick={() => onOpen(task.id)}><span>{task.title.replace(/^Gaming Bench · /, "")}</span><span className="badge">{task.status}</span><ExternalLink size={14} /></button>)}</div>}
          </section>) : <p className="help">As execuções aparecerão aqui.</p>;
        })()}
      </div>
    </div>
  );
}
