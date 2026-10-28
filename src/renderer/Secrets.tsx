import { useState } from "react";
import { Eye, EyeOff, KeyRound, Pencil, Plus, Trash2, X } from "lucide-react";
import type { AgentId, Snapshot, UserSecret } from "../shared/types";
import { agentIds, agentNames, secretBlockedFor } from "../shared/types";
import { api } from "./api";
// Secrets: values such as API keys that every agent session receives as an
// environment variable. The value is write-only: it never comes back here.
type Draft = {
  id?: string;
  name: string;
  value: string;
  description: string;
};
// Typed names become variable names: "minha chave" → MINHA_CHAVE.
const asName = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_");
// The agents a secret does not reach, because it would change their login.
const blocked = (name: string): AgentId[] =>
  agentIds.filter((agent) => secretBlockedFor(name, agent));
export function SecretsSettings({
  snapshot,
  run,
}: {
  snapshot: Snapshot;
  run: <T>(work: () => Promise<T>) => Promise<T | undefined>;
}) {
  const secrets = snapshot.secrets ?? [];
  const [draft, setDraft] = useState<Draft>();
  const [visible, setVisible] = useState(false);
  const [confirm, setConfirm] = useState("");
  const edit = (secret?: UserSecret) => {
    setVisible(false);
    setDraft(
      secret
        ? {
            id: secret.id,
            name: secret.name,
            value: "",
            description: secret.description,
          }
        : { name: "", value: "", description: "" },
    );
  };
  const outside = draft ? blocked(draft.name) : [];
  return (
    <section className="settings-stack">
      <div className="section-heading">
        <div>
          <h3>Seus secrets</h3>
          <p className="help">
            Chaves de API e outros valores sensíveis que todas as sessões dos
            agentes recebem como variáveis de ambiente, inclusive sub-agentes,
            chat rápido e o terminal do painel. O agente
            conhece só o nome e a descrição; usa o valor pela variável, como{" "}
            <code>$env:NOME</code>.
          </p>
        </div>
        <button className="quiet" onClick={() => edit()}>
          <Plus size={16} />
          Adicionar secret
        </button>
      </div>
      {secrets.map((s) => (
        <div className="extension-row secret-row" key={s.id}>
          <KeyRound size={18} />
          <div>
            <strong className="secret-name">{s.name}</strong>
            <small>{s.description || "Sem descrição"}</small>
            {blocked(s.name).length > 0 && (
              <small className="amber-text">
                Não vai para{" "}
                {blocked(s.name)
                  .map((a) => agentNames[a])
                  .join(", ")}
                : mudaria o login dele.
              </small>
            )}
          </div>
          <span className="secret-value" aria-label="Valor oculto">
            ••••••••
          </span>
          <button
            className="icon"
            title="Editar secret"
            aria-label={`Editar ${s.name}`}
            onClick={() => edit(s)}
          >
            <Pencil size={15} />
          </button>
          {confirm === s.id ? (
            <button
              className="quiet compact danger"
              onClick={() =>
                void run(async () => {
                  await api("secrets.delete", { id: s.id });
                  setConfirm("");
                })
              }
            >
              Confirmar exclusão
            </button>
          ) : (
            <button
              className="icon"
              title="Excluir secret"
              aria-label={`Excluir ${s.name}`}
              onClick={() => setConfirm(s.id)}
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ))}
      {!secrets.length && (
        <p className="help">
          Nenhum secret ainda. Exemplo: <code>OPENAI_API_KEY</code>, com a
          descrição “chave da OpenAI do projeto de imagens”.
        </p>
      )}
      <p className="help">
        O valor fica cifrado com a chave do seu usuário do Windows e não volta
        para esta tela: para trocá-lo, edite e digite o novo. Se um agente
        imprimir um valor, o Codebit o mascara no histórico. Conexões MCP podem
        usar um secret com <code>{"${NOME}"}</code> no campo env, e um{" "}
        <code>OPENAI_API_KEY</code> daqui também serve para as imagens pela API
        OpenAI. Mudanças valem a partir da próxima mensagem de cada conversa.
      </p>
      {draft && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-header">
              <h2>{draft.id ? "Editar secret" : "Novo secret"}</h2>
              <button
                className="icon"
                aria-label="Fechar"
                onClick={() => setDraft(undefined)}
              >
                <X size={18} />
              </button>
            </div>
            <label>
              Nome
              <input
                aria-label="Nome do secret"
                placeholder="OPENAI_API_KEY"
                value={draft.name}
                autoFocus={!draft.id}
                spellCheck={false}
                onChange={(e) =>
                  setDraft({ ...draft, name: asName(e.target.value) })
                }
              />
            </label>
            <label>
              Valor
              <div className="secret-input">
                <input
                  aria-label="Valor do secret"
                  type={visible ? "text" : "password"}
                  autoComplete="new-password"
                  spellCheck={false}
                  autoFocus={!!draft.id}
                  placeholder={
                    draft.id
                      ? "Deixe vazio para manter o valor salvo"
                      : "O valor da chave"
                  }
                  value={draft.value}
                  onChange={(e) =>
                    setDraft({ ...draft, value: e.target.value })
                  }
                />
                <button
                  type="button"
                  className="icon"
                  title={
                    visible ? "Ocultar o que digitei" : "Mostrar o que digitei"
                  }
                  aria-label={visible ? "Ocultar valor" : "Mostrar valor"}
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </label>
            <label>
              Descrição
              <textarea
                aria-label="Descrição do secret"
                rows={3}
                placeholder="Para que serve, em que projeto se usa…"
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
              />
            </label>
            {outside.length > 0 && (
              <p className="secret-warning" role="note">
                Este nome é lido pelo próprio{" "}
                {outside.map((a) => agentNames[a]).join(", ")} para entrar na
                conta; por isso ele não recebe este secret (o Claude Code, por
                exemplo, trocaria a assinatura por cobrança na API). Para usar a
                chave em scripts desse agente, dê outro nome, como{" "}
                <code>{draft.name || "NOME"}_PROJETO</code>.
              </p>
            )}
            <div className="modal-actions">
              <button className="quiet" onClick={() => setDraft(undefined)}>
                Cancelar
              </button>
              <button
                className="primary"
                disabled={!draft.name || (!draft.id && !draft.value)}
                onClick={() =>
                  void run(async () => {
                    await api("secrets.save", {
                      id: draft.id,
                      name: draft.name,
                      value: draft.value || undefined,
                      description: draft.description,
                    });
                    setDraft(undefined);
                  })
                }
              >
                Salvar secret
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
