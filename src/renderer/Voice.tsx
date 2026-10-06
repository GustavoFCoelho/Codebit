import { useEffect, useState } from "react";
import { Mic, MicOff, Pause, ChevronDown, ChevronUp } from "lucide-react";
import type { Snapshot } from "../shared/types";
import {
  defaultVoice,
  type VoiceState,
  type VoicePhase,
} from "../shared/voice";
import { api } from "./api";
import "./styles/voice.css";
const labels: Record<VoicePhase, string> = {
  off: "Desligada",
  checking: "Verificando motor local",
  unavailable: "Motor indisponível",
  starting: "Preparando microfone",
  wake: "Aguardando frase",
  listening: "Ouvindo instrução",
  review: "Revise antes de enviar",
  sending: "Enviando",
  speaking: "Anunciando · microfone fechado",
  paused: "Pausada · microfone fechado",
  error: "Erro · microfone desligado",
};
export function VoicePanel({
  snapshot,
  onOpen,
}: {
  snapshot?: Snapshot;
  onOpen: (id: string) => void;
}) {
  const [state, setState] = useState<VoiceState>({
    phase: "off",
    enabled: false,
    options: defaultVoice,
  });
  const [expanded, setExpanded] = useState(false);
  const [options, setOptions] = useState(defaultVoice);
  const [target, setTarget] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const unsub = window.codebit.onEvent((e) => {
      if (e.type === "voice" && live) setState(e.state);
    });
    void api<VoiceState>("voice.state")
      .then((v) => {
        if (live) setState(v);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
      unsub();
    };
  }, []);
  const saved = JSON.stringify(state.options);
  useEffect(() => {
    setOptions(JSON.parse(saved));
    setTarget(state.taskId || "");
  }, [saved, state.taskId]);
  useEffect(() => {
    if (state.draft) {
      setText(state.draft.text);
      setExpanded(true);
    }
  }, [state.draft?.id]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const editable = !state.enabled || state.phase === "paused";
  const tasks = snapshot?.tasks.filter((t) => !t.archived) || [];
  const taskName = (id: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return "Tarefa não disponível";
    const project = snapshot?.projects.find((p) => p.id === task.projectId);
    return `${project?.name || "Sem projeto"} / ${task.title} · ${id.slice(0, 8)}`;
  };
  const audioActive = ["starting", "wake", "listening"].includes(state.phase);
  const ready =
    !!target &&
    !!state.capabilities?.recognizers.some(
      (r) => r.id === options.recognizerId,
    );
  return (
    <section
      className={`voice-panel ${audioActive ? "voice-active" : ""}`}
      aria-label="Controle por voz"
    >
      <div className="voice-toolbar">
        <button
          className="quiet compact"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {audioActive ? <Mic size={15} /> : <MicOff size={15} />}
          <span>Voz · {labels[state.phase]}</span>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {state.enabled && (
          <>
            <span className="voice-target" title={taskName(state.taskId || "")}>
              {taskName(state.taskId || "")}
            </span>
            {state.phase !== "paused" && (
              <button
                className="quiet compact"
                onClick={() => void run(() => api("voice.pause"))}
              >
                <Pause size={14} />
                Pausar microfone
              </button>
            )}
            <button
              className="quiet compact"
              onClick={() => void run(() => api("voice.stop"))}
            >
              Desligar voz
            </button>
          </>
        )}
      </div>
      {expanded && (
        <div className="voice-content">
          <p>
            Ative a voz, diga “{options.wakePhrase}”, espere aparecer “Ouvindo
            instrução” e fale. Revise o texto antes de enviá-lo à tarefa
            escolhida.
          </p>
          <p className="muted">
            Áudio reconhecido localmente pelo Vosk; avisos falados usam a voz do
            Windows. Sem gravação em arquivo. Enquanto a voz estiver ligada, o
            microfone aguarda a frase. Só o texto confirmado segue para o agente
            da tarefa. A voz começa desligada a cada abertura.
          </p>
          <div className="voice-fields">
            <label>
              Tarefa de destino
              <select
                aria-label="Tarefa de destino da voz"
                disabled={!editable || busy}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">Escolha uma tarefa explicitamente</option>
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {taskName(t.id)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Frase de ativação
              <input
                aria-label="Frase de ativação"
                disabled={!editable || busy}
                maxLength={80}
                value={options.wakePhrase}
                onChange={(e) =>
                  setOptions({ ...options, wakePhrase: e.target.value })
                }
              />
            </label>
            <label>
              Reconhecedor local
              <select
                aria-label="Reconhecedor local"
                disabled={!editable || busy}
                value={options.recognizerId}
                onChange={(e) =>
                  setOptions({ ...options, recognizerId: e.target.value })
                }
              >
                <option value="">Selecione um motor instalado</option>
                {state.capabilities?.recognizers.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.culture})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="voice-check">
            <input
              type="checkbox"
              checked={options.announcements}
              disabled={!editable || busy}
              onChange={(e) =>
                setOptions({ ...options, announcements: e.target.checked })
              }
            />
            Anunciar término, falha e pedidos de atenção da tarefa selecionada
          </label>
          {state.capabilities &&
            !state.capabilities.voices.some((v) => v.culture === "pt-BR") && (
              <p className="muted">
                Sem voz local de saída em português disponível. Os avisos
                aparecerão por escrito.
              </p>
            )}
          {state.capabilities?.reason && (
            <p role="status">{state.capabilities.reason}</p>
          )}
          <div className="voice-buttons">
            <button
              className="quiet compact"
              disabled={state.enabled || busy}
              onClick={() => void run(() => api("voice.probe"))}
            >
              Verificar motor sem abrir microfone
            </button>
            {editable && (
              <button
                className="compact"
                disabled={
                  busy || !ready || options.wakePhrase.trim().length < 3
                }
                onClick={() =>
                  void run(async () => {
                    await api("voice.configure", { taskId: target, options });
                    await api("voice.enable");
                  })
                }
              >
                {state.phase === "paused"
                  ? "Retomar voz"
                  : "Ativar microfone local"}
              </button>
            )}
          </div>
          {state.message && <p role="status">{state.message}</p>}
          {state.draft && (
            <div className="voice-review">
              <strong>
                Confirmar instrução para {taskName(state.draft.taskId)}
              </strong>
              <textarea
                aria-label="Instrução reconhecida"
                maxLength={8000}
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
              />
              <p className="muted">
                Se a tarefa estiver ocupada, a instrução entra na fila.
                Permissões e perguntas continuam sendo respondidas na conversa.
              </p>
              <div className="voice-buttons">
                <button
                  disabled={busy || !text.trim()}
                  onClick={() =>
                    void run(() =>
                      api("voice.confirm", { draftId: state.draft!.id, text }),
                    )
                  }
                >
                  Confirmar e enviar
                </button>
                <button
                  className="quiet"
                  disabled={busy}
                  onClick={() => void run(() => api("voice.discard"))}
                >
                  Descartar e voltar à escuta
                </button>
              </div>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
      {state.notice && (
        <div className="voice-notice" role="status">
          <span>{state.notice.text}</span>
          <button
            className="quiet compact"
            onClick={() => onOpen(state.notice!.taskId)}
          >
            Abrir conversa
          </button>
        </div>
      )}
    </section>
  );
}
