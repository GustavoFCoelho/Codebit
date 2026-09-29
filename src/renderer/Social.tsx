import { useEffect, useState } from "react";
import {
  Camera,
  ExternalLink,
  HeartHandshake,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type {
  SocialAccount,
  SocialPost,
  Snapshot,
  Task,
} from "../shared/types";
import { socialNetworkNames } from "../shared/types";
import { api } from "./api";
// Social accounts of each project, used by the agents through codebit_social.
const accountTypes: Record<string, string> = {
  business: "Empresa",
  media_creator: "Criador de conteúdo",
};
const date = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";
export function SocialSettings({
  snapshot,
  task,
  run,
}: {
  snapshot: Snapshot;
  task?: Task;
  run: <T>(work: () => Promise<T>) => Promise<T | undefined>;
}) {
  const projects = snapshot.projects;
  const [projectId, setProjectId] = useState(
    task?.projectId || projects[0]?.id || "",
  );
  const [state, setState] = useState<{
    accounts: SocialAccount[];
    posts: SocialPost[];
    cloudflared?: { path: string; version: string };
  }>();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState("");
  const [tested, setTested] = useState(false);
  const load = async () => {
    if (projectId) setState(await api("social.state", { projectId }));
  };
  useEffect(() => {
    setState(undefined);
    setConfirm("");
    void run(load);
  }, [projectId]);
  const act = (name: string, work: () => Promise<unknown>) =>
    run(async () => {
      setBusy(name);
      try {
        await work();
        await load();
      } finally {
        setBusy("");
        setConfirm("");
      }
    });
  if (!projects.length)
    return (
      <div className="empty-card">
        Adicione um projeto para conectar redes sociais a ele. Cada projeto tem
        as próprias contas.
      </div>
    );
  const instagram = state?.accounts.find((a) => a.network === "instagram");
  const patreon = state?.accounts.find((a) => a.network === "patreon");
  const soon =
    instagram?.expiresAt &&
    Date.parse(instagram.expiresAt) - Date.now() < 7 * 24 * 3600 * 1000;
  return (
    <section className="settings-stack social-settings">
      <div className="settings-card">
        <div className="setting-row">
          <div className="setting-text">
            <strong>Projeto</strong>
            <small>
              Os agentes só publicam nas contas do projeto da tarefa, e cada
              publicação espera a sua aprovação, com a prévia exata, mesmo em
              Bypass.
            </small>
          </div>
          <div className="setting-control">
            <select
              aria-label="Projeto das redes sociais"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div className="settings-card">
        <div className="card-title">
          <div className="provider-monogram instagram">
            <Camera size={24} />
          </div>
          <div>
            <h3>Instagram</h3>
            <p>
              Posts, carrosséis e stories pela API oficial, em conta
              profissional.
            </p>
          </div>
          <span className={`badge ${instagram ? "success" : ""}`}>
            {instagram ? "Conectado" : "Não conectado"}
          </span>
        </div>
        {instagram ? (
          <>
            <div className="property">
              <span>Conta</span>
              <strong>{instagram.name}</strong>
            </div>
            <div className="property">
              <span>Tipo</span>
              <strong>
                {accountTypes[instagram.accountType?.toLowerCase() ?? ""] ??
                  instagram.accountType}
              </strong>
            </div>
            <div className="property">
              <span>Acesso válido até</span>
              <strong className={soon ? "amber-text" : ""}>
                {date(instagram.expiresAt)}
              </strong>
            </div>
            <p className="help">
              O Codebit renova o acesso uma vez por semana, enquanto estiver
              aberto.
            </p>
            {instagram.error && (
              <p className="help amber-text">{instagram.error}</p>
            )}
            <div className="row-actions">
              <button
                className="quiet"
                disabled={!!busy}
                onClick={() =>
                  void act("renew", () =>
                    api("social.renew", { id: instagram.id }),
                  )
                }
              >
                <RefreshCw
                  size={14}
                  className={busy === "renew" ? "spin" : ""}
                />
                Renovar agora
              </button>
              <button
                className={`quiet ${confirm === instagram.id ? "danger" : ""}`}
                disabled={!!busy}
                onClick={() =>
                  confirm === instagram.id
                    ? void act("remove", () =>
                        api("social.remove", { id: instagram.id }),
                      )
                    : setConfirm(instagram.id)
                }
              >
                {confirm === instagram.id
                  ? "Confirmar: desconectar"
                  : "Desconectar"}
              </button>
            </div>
          </>
        ) : (
          <>
            <ol className="steps">
              <li>
                Em developers.facebook.com, crie um app e adicione o produto
                Instagram.
              </li>
              <li>
                Em “API com login do Instagram”, adicione sua conta profissional
                e use “Gerar token”.
              </li>
              <li>
                Cole o token aqui. Ele fica cifrado neste computador e é
                renovado antes dos 60 dias.
              </li>
            </ol>
            <label>
              Token de acesso
              <input
                type="password"
                autoComplete="off"
                aria-label="Token do Instagram"
                placeholder="Token gerado no painel da Meta"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <div className="row-actions">
              <button
                className="primary"
                disabled={!token.trim() || !!busy}
                onClick={() =>
                  void act("instagram", async () => {
                    await api("social.instagram", { projectId, token });
                    setToken("");
                  })
                }
              >
                {busy === "instagram" && (
                  <RefreshCw size={14} className="spin" />
                )}
                Conectar Instagram
              </button>
            </div>
          </>
        )}
      </div>
      <div className="settings-card">
        <div className="card-title">
          <div className="provider-monogram patreon">
            <HeartHandshake size={24} />
          </div>
          <div>
            <h3>Patreon</h3>
            <p>Posts escritos no editor do site, numa janela do Codebit.</p>
          </div>
          <span className={`badge ${patreon ? "success" : ""}`}>
            {patreon ? "Conectado" : "Não conectado"}
          </span>
        </div>
        {patreon && (
          <div className="property">
            <span>Conta</span>
            <strong>{patreon.name}</strong>
          </div>
        )}
        <p className="help">
          A API do Patreon não cria posts, então o Codebit preenche o editor do
          site numa janela logada nesta conta, com cliques e digitação reais. O
          login é feito na própria página do Patreon; o Codebit guarda só a
          sessão, separada por projeto.
        </p>
        {tested && (
          <p className="notice" role="status">
            Teste concluído: título, texto, imagem e público preenchidos, e nada
            foi publicado. Confira a janela do Patreon e descarte o rascunho.
          </p>
        )}
        <p className="help amber-text">
          O Patreon pode bloquear automação, e os termos dele proíbem abusos
          técnicos: publique com moderação. Se um passo falhar, o rascunho fica
          aberto na janela para você conferir e publicar.
        </p>
        <div className="row-actions">
          <button
            className={patreon ? "quiet" : "primary"}
            disabled={!!busy}
            onClick={() =>
              void act("patreon", () => api("social.patreon", { projectId }))
            }
          >
            {busy === "patreon" && <RefreshCw size={14} className="spin" />}
            {busy === "patreon"
              ? "Esperando o login na janela…"
              : patreon
                ? "Entrar de novo"
                : "Entrar no Patreon"}
          </button>
          {patreon && (
            <button
              className="quiet"
              disabled={!!busy}
              title="Preenche um post de teste no editor e para antes de publicar, com a janela aberta para você conferir."
              onClick={() =>
                void act("test", async () => {
                  await api("social.patreonTest", { projectId });
                  setTested(true);
                })
              }
            >
              {busy === "test" && <RefreshCw size={14} className="spin" />}
              Testar sem publicar
            </button>
          )}
          {patreon && (
            <button
              className={`quiet ${confirm === patreon.id ? "danger" : ""}`}
              disabled={!!busy}
              onClick={() =>
                confirm === patreon.id
                  ? void act("remove", () =>
                      api("social.remove", { id: patreon.id }),
                    )
                  : setConfirm(patreon.id)
              }
            >
              {confirm === patreon.id ? "Confirmar: sair" : "Sair"}
            </button>
          )}
        </div>
      </div>
      <div className="settings-card">
        <div className="setting-row">
          <div className="setting-text">
            <strong>Túnel das imagens (cloudflared)</strong>
            <small>
              O Instagram só busca imagens por um endereço público. Em cada
              publicação, o Codebit abre um túnel temporário do Cloudflare só
              para os arquivos daquele post e o fecha em seguida. Não precisa de
              conta.
            </small>
          </div>
          <div className="setting-control">
            {!state ? (
              <span className="muted">Verificando…</span>
            ) : state.cloudflared ? (
              <span className="badge success" title={state.cloudflared.path}>
                Instalado · {state.cloudflared.version}
              </span>
            ) : (
              <button
                className="quiet"
                disabled={!!busy}
                onClick={() =>
                  void act("tunnel", () => api("social.installTunnel"))
                }
              >
                {busy === "tunnel" && <RefreshCw size={14} className="spin" />}
                Instalar pelo winget
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="settings-card">
        <div className="card-head">
          <h3>Publicações</h3>
          <p className="help">
            O que os agentes publicaram por este projeto. Posts do Instagram
            podem ser apagados daqui; os do Patreon, pelo site.
          </p>
        </div>
        {!state?.posts.length ? (
          <p className="help">
            Nenhuma publicação ainda. Peça ao agente, por exemplo: “Publique no
            Instagram a imagem que você gerou, com uma legenda curta”.
          </p>
        ) : (
          <div className="social-posts" role="list" aria-label="Publicações">
            {state.posts.map((p) => (
              <div
                className={`social-post ${p.deletedAt ? "deleted" : ""}`}
                role="listitem"
                key={p.id}
              >
                <span className="badge">{socialNetworkNames[p.network]}</span>
                <div>
                  <strong className="truncate">
                    {p.title || p.text.split("\n")[0] || "Sem legenda"}
                  </strong>
                  <small>
                    {date(p.createdAt)}
                    {p.images.length ? ` · ${p.images.length} imagem(ns)` : ""}
                    {p.deletedAt ? ` · apagado em ${date(p.deletedAt)}` : ""}
                  </small>
                </div>
                {p.url && !p.deletedAt && (
                  <button
                    className="icon"
                    title="Abrir o post"
                    aria-label="Abrir o post"
                    onClick={() =>
                      void run(() => api("social.openPost", { id: p.id }))
                    }
                  >
                    <ExternalLink size={15} />
                  </button>
                )}
                {p.network === "instagram" && p.mediaId && !p.deletedAt && (
                  <button
                    className={`quiet compact ${confirm === p.id ? "danger" : ""}`}
                    disabled={!!busy}
                    onClick={() =>
                      confirm === p.id
                        ? void act("delete", () =>
                            api("social.deletePost", { id: p.id }),
                          )
                        : setConfirm(p.id)
                    }
                  >
                    <Trash2 size={13} />
                    {confirm === p.id ? "Confirmar" : "Apagar do Instagram"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
