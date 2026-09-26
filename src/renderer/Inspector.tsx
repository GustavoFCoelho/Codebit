import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  ExternalLink,
  File,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  LoaderCircle,
  RefreshCw,
  Terminal as TerminalIcon,
} from "lucide-react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, artifactUrl, fileName, fileUrl } from "./api";
import type { Artifact, Task } from "../shared/types";
import { imageProviderNames } from "../shared/types";
(self as any).MonacoEnvironment = {
  getWorker: (_: string, label: string) =>
    label === "typescript" || label === "javascript"
      ? new TsWorker()
      : label === "json"
        ? new JsonWorker()
        : ["css", "scss", "less"].includes(label)
          ? new CssWorker()
          : ["html", "handlebars", "razor"].includes(label)
            ? new HtmlWorker()
            : new EditorWorker(),
};
loader.config({ monaco });
monaco.editor.defineTheme("codebit", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#14191d",
    "editor.foreground": "#d6dddf",
    "editorLineNumber.foreground": "#697780",
    "editor.lineHighlightBackground": "#1b2227",
    "editor.selectionBackground": "#294338",
  },
});
export function Inspector({
  task,
  artifacts,
  selectedArtifact,
  setSelectedArtifact,
  openedImage,
  setOpenedImage,
  tab,
  setTab,
  patch,
  run,
  setDraft,
  imageProgress,
}: {
  task: Task;
  artifacts: Artifact[];
  selectedArtifact?: string;
  setSelectedArtifact: (id: string) => void;
  // An image file mentioned in the chat, shown instead of the gallery.
  openedImage?: string;
  setOpenedImage: (path?: string) => void;
  tab: string;
  setTab: (tab: string) => void;
  patch: (p: Partial<Task>) => Promise<void>;
  run: any;
  setDraft: (s: string) => void;
  imageProgress: string;
}) {
  const [diff, setDiff] = useState({
    git: false,
    diff: "",
    status: "",
    truncated: false,
  });
  const [items, setItems] = useState<any[]>([]);
  const [folder, setFolder] = useState("");
  const [opened, setOpened] = useState<{ path: string; text: string }>();
  const [terminalUsed, setTerminalUsed] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [broken, setBroken] = useState(false);
  const image =
    artifacts.find((a) => a.id === selectedArtifact) || artifacts.at(-1);
  async function refreshFiles() {
    setItems(await api("workspace.files", { id: task.id, path: folder }));
  }
  async function refreshDiff() {
    setDiff(await api("workspace.changes", { id: task.id }));
  }
  useEffect(() => {
    setFolder("");
    setOpened(undefined);
    setTerminalUsed(false);
  }, [task.id]);
  useEffect(() => {
    if (tab === "Alterações") void run(refreshDiff);
    if (tab === "Arquivos") void run(refreshFiles);
    if (tab === "Terminal") setTerminalUsed(true);
  }, [tab, task.id, task.status, folder]);
  useEffect(() => {
    setPrompt(image?.prompt || "");
  }, [image?.id]);
  useEffect(() => setBroken(false), [openedImage]);
  return (
    <aside className="inspector">
      <div className="panel-tabs">
        {["Alterações", "Arquivos", "Terminal", "Imagens"].map((t) => (
          <button
            key={t}
            className={tab === t ? "selected" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "Alterações" && (
        <div className="diff-panel">
          <div className="panel-heading">
            <strong>Alterações no projeto</strong>
            <button
              className="icon"
              title="Atualizar alterações"
              onClick={() => void run(refreshDiff)}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          {diff.truncated && (
            <p className="notice" role="status">
              Prévia de alterações reduzida: o diff excede 512 KB ou a lista de
              arquivos excede 128 KB. Use o Git no terminal para consultar todas
              as alterações.
            </p>
          )}
          {!diff.git ? (
            <div className="panel-empty">
              <Folder size={28} />
              <p>Esta pasta não é um repositório Git.</p>
              <small>Explore os arquivos na aba ao lado.</small>
            </div>
          ) : !diff.status ? (
            <div className="panel-empty">
              <File size={28} />
              <p>Nenhuma alteração no momento.</p>
              <small>As mudanças do agente aparecerão aqui.</small>
            </div>
          ) : (
            <>
              <pre className="git-status">{diff.status}</pre>
              {diff.diff ? (
                <Editor
                  theme="codebit"
                  language="diff"
                  value={diff.diff}
                  options={{
                    readOnly: true,
                    automaticLayout: true,
                    minimap: { enabled: false },
                    fontSize: 12,
                    wordWrap: "on",
                    lineNumbers: "off",
                    scrollBeyondLastLine: false,
                    padding: { top: 12 },
                    renderLineHighlight: "none",
                  }}
                />
              ) : (
                <p className="help padded">
                  Arquivos novos aparecem na lista acima. Abra-os na aba
                  Arquivos para ver seu conteúdo.
                </p>
              )}
            </>
          )}
        </div>
      )}
      {tab === "Arquivos" && (
        <div className="file-panel">
          {opened ? (
            <>
              <div className="panel-heading">
                <button
                  className="icon"
                  title="Voltar aos arquivos"
                  onClick={() => setOpened(undefined)}
                >
                  <ArrowLeft size={16} />
                </button>
                <span className="truncate">{opened.path}</span>
              </div>
              <Editor
                theme="codebit"
                path={opened.path}
                value={opened.text}
                options={{
                  readOnly: true,
                  automaticLayout: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                }}
              />
            </>
          ) : (
            <>
              <div className="panel-heading">
                <span className="truncate">
                  {folder || "Arquivos do projeto"}
                </span>
                <button
                  className="icon"
                  title="Atualizar arquivos"
                  onClick={() => void run(refreshFiles)}
                >
                  <RefreshCw size={15} />
                </button>
              </div>
              {folder && (
                <button
                  className="file-row"
                  onClick={() =>
                    setFolder(folder.split(/[\\/]/).slice(0, -1).join("/"))
                  }
                >
                  <ArrowLeft size={15} />
                  Pasta anterior
                </button>
              )}
              {items.map((item) => (
                <button
                  className="file-row"
                  key={item.path}
                  onClick={() =>
                    void run(async () => {
                      if (item.directory) setFolder(item.path);
                      else
                        setOpened({
                          path: item.path,
                          text: await api("workspace.read", {
                            id: task.id,
                            path: item.path,
                          }),
                        });
                    })
                  }
                >
                  {item.directory ? <Folder size={16} /> : <File size={15} />}
                  <span>{item.name}</span>
                  {item.directory && <ChevronRight size={13} />}
                </button>
              ))}
              {!items.length && (
                <p className="help padded">Esta pasta está vazia.</p>
              )}
            </>
          )}
        </div>
      )}
      {terminalUsed && (
        <div
          className="terminal-panel"
          style={{ display: tab === "Terminal" ? "flex" : "none" }}
        >
          <div className="panel-heading">
            <TerminalIcon size={15} />
            <span>PowerShell</span>
            <button
              className="icon"
              title="Reiniciar terminal"
              onClick={() =>
                void run(async () => {
                  await api("terminal.close", { id: task.id });
                  setTerminalUsed(false);
                  setTimeout(() => setTerminalUsed(true), 100);
                })
              }
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <TerminalPane
            key={task.id}
            task={task}
            visible={tab === "Terminal"}
            run={run}
          />
        </div>
      )}
      {tab === "Imagens" && (
        <div className="images-panel">
          {openedImage ? (
            <>
              <div className="panel-heading">
                <button
                  className="icon"
                  title="Voltar às imagens da tarefa"
                  aria-label="Voltar às imagens da tarefa"
                  onClick={() => setOpenedImage(undefined)}
                >
                  <ArrowLeft size={16} />
                </button>
                <span className="truncate" title={openedImage}>
                  {fileName(openedImage)}
                </span>
              </div>
              {broken ? (
                <div className="panel-empty">
                  <ImageIcon size={28} />
                  <p>Não foi possível abrir esta imagem.</p>
                  <small>Confira se o arquivo ainda existe.</small>
                </div>
              ) : (
                <img
                  className="inspector-image"
                  src={fileUrl(task.id, openedImage)}
                  alt={fileName(openedImage)}
                  onError={() => setBroken(true)}
                />
              )}
              <code className="image-path">{openedImage}</code>
              <div className="row-actions image-actions">
                <button
                  className="quiet"
                  onClick={() =>
                    void run(() =>
                      api("file.open", { id: task.id, path: openedImage }),
                    )
                  }
                >
                  <ExternalLink size={14} />
                  Abrir no app padrão
                </button>
                <button
                  className="quiet"
                  onClick={() =>
                    void run(() =>
                      api("file.reveal", { id: task.id, path: openedImage }),
                    )
                  }
                >
                  <FolderOpen size={14} />
                  Mostrar na pasta
                </button>
              </div>
            </>
          ) : (
            <div className="panel-heading">
              <strong>Imagens da tarefa</strong>
              <span className="count">{artifacts.length}</span>
            </div>
          )}
          {openedImage ? null : artifacts.length ? (
            <>
              <div className="thumbnails">
                {artifacts.map((a) => (
                  <button
                    className={image?.id === a.id ? "selected" : ""}
                    key={a.id}
                    onClick={() => setSelectedArtifact(a.id)}
                  >
                    <img src={artifactUrl(a.id)} alt={a.prompt} />
                  </button>
                ))}
              </div>
              {image && (
                <img
                  className="inspector-image"
                  src={artifactUrl(image.id)}
                  alt={image.prompt}
                />
              )}
            </>
          ) : (
            <div className="panel-empty">
              <ImageIcon size={32} />
              <p>Da ideia à imagem.</p>
              <small>
                Escolha o modelo abaixo da conversa e descreva o que deseja
                criar.
              </small>
            </div>
          )}
          <div className="image-settings">
            <div className="property">
              <span>Provedor selecionado</span>
              <strong>{imageProviderNames[task.images.provider]}</strong>
            </div>
            <div className="property">
              <span>Modelo</span>
              <strong>{task.images.model || "Não selecionado"}</strong>
            </div>
            <div className="property">
              <span>Formato</span>
              <strong>PNG</strong>
            </div>
            <label>
              Dimensões
              <select
                value={task.images.size}
                onChange={(e) =>
                  void run(() =>
                    patch({ images: { ...task.images, size: e.target.value } }),
                  )
                }
              >
                <option value="1024x1024">1024 × 1024 · Quadrado</option>
                <option value="1536x1024">1536 × 1024 · Paisagem</option>
                <option value="1024x1536">1024 × 1536 · Retrato</option>
                {task.images.provider !== "comfyui" && (
                  <option value="auto">Automático</option>
                )}
              </select>
            </label>
            {task.images.provider === "openai" && (
              <label>
                Qualidade
                <select
                  value={task.images.quality}
                  onChange={(e) =>
                    void run(() =>
                      patch({
                        images: {
                          ...task.images,
                          quality: e.target.value as any,
                        },
                      }),
                    )
                  }
                >
                  {[
                    ["auto", "Automática"],
                    ["low", "Baixa"],
                    ["medium", "Média"],
                    ["high", "Alta"],
                  ].map(([v, l]) => (
                    <option value={v} key={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {task.images.provider === "comfyui" && (
              <label>
                Seed (0 = aleatória)
                <input
                  type="number"
                  min="0"
                  max="4294967295"
                  value={task.images.seed}
                  onChange={(e) =>
                    void run(() =>
                      patch({
                        images: {
                          ...task.images,
                          seed: Number(e.target.value),
                        },
                      }),
                    )
                  }
                />
              </label>
            )}
            <label>
              Prompt
              <textarea
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Descreva a imagem…"
              />
            </label>
            <button
              className="primary"
              disabled={!prompt.trim() || !!imageProgress}
              onClick={() =>
                void run(async () => {
                  const result = await api<Artifact>("images.generate", {
                    id: task.id,
                    prompt,
                  });
                  setSelectedArtifact(result.id);
                })
              }
            >
              {imageProgress ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <RefreshCw size={15} />
              )}
              Gerar {image ? "variação" : "imagem"}
            </button>
            {image && (
              <button
                className="quiet full"
                onClick={() =>
                  void run(() => api("images.export", { id: image.id }))
                }
              >
                <Download size={15} />
                Exportar arquivo
              </button>
            )}
            <p className="help">
              O gerador usa a seleção de imagens da tarefa, independentemente do
              agente de código.
            </p>
            {task.images.inputImage && (
              <span className="badge">Edição com imagem de referência</span>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
function TerminalPane({
  task,
  visible,
  run,
}: {
  task: Task;
  visible: boolean;
  run: any;
}) {
  const container = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal>(null);
  const fitRef = useRef<FitAddon>(null);
  useEffect(() => {
    const term = new Terminal({
      fontFamily: "Cascadia Code, Consolas, monospace",
      fontSize: 12,
      cursorBlink: true,
      theme: {
        background: "#111619",
        foreground: "#d4dce0",
        cursor: "#62c68b",
      },
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current!);
    termRef.current = term;
    fitRef.current = fit;
    const unsub = window.codebit.onEvent((e) => {
      if (e.type === "terminal" && e.taskId === task.id) term.write(e.data);
    });
    const data = term.onData(
      (data) => void api("terminal.write", { id: task.id, data }),
    );
    void run(async () => {
      const result = await api("terminal.open", { id: task.id });
      if (result?.buffer) term.write(result.buffer);
      fit.fit();
      await api("terminal.resize", {
        id: task.id,
        cols: term.cols,
        rows: term.rows,
      });
    });
    const resize = new ResizeObserver(() => {
      if (container.current?.clientWidth) {
        fit.fit();
        void api("terminal.resize", {
          id: task.id,
          cols: term.cols,
          rows: term.rows,
        });
      }
    });
    resize.observe(container.current!);
    return () => {
      unsub();
      data.dispose();
      resize.disconnect();
      term.dispose();
    };
  }, [task.id]);
  useEffect(() => {
    if (visible) setTimeout(() => fitRef.current?.fit(), 30);
  }, [visible]);
  return <div ref={container} className="terminal-surface" />;
}
