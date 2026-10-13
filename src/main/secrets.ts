import { randomUUID } from "node:crypto";
import type { Store } from "./store";
import type { AgentId, UserSecret } from "../shared/types";
import { secretBlockedFor, secretNamePattern } from "../shared/types";
// Variables the system and Codebit itself depend on: a secret with one of
// these names would break the agents' processes.
const reserved = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "USERPROFILE",
  "USERNAME",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "TEMP",
  "TMP",
  "NODE_OPTIONS",
]);
// Secrets the user keeps in Codebit (API keys and the like): the value is
// encrypted with the Windows user's key and never returns to the interface;
// every agent session gets it as an environment variable.
export class SecretVault {
  private cache?: Record<string, string>;
  constructor(
    private store: Store,
    private crypto: {
      encrypt: (value: string) => string;
      decrypt: (value: string) => string;
    },
  ) {}
  list() {
    return this.store
      .all<UserSecret>("user-secret")
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  save(input: {
    id?: string;
    name: string;
    value?: string;
    description?: string;
  }) {
    const name = input.name.trim().toUpperCase();
    if (!secretNamePattern.test(name))
      throw new Error(
        "Use no nome só letras sem acento, números e _, começando por letra ou _ (ex.: OPENAI_API_KEY).",
      );
    if (
      reserved.has(name) ||
      name.startsWith("CODEBIT_") ||
      name.startsWith("ELECTRON_")
    )
      throw new Error(`${name} é uma variável do sistema ou do Codebit.`);
    const current = input.id
      ? this.list().find((s) => s.id === input.id)
      : undefined;
    if (input.id && !current) throw new Error("Secret não encontrado.");
    if (this.list().some((s) => s.name === name && s.id !== input.id))
      throw new Error(`Já existe um secret chamado ${name}.`);
    const value = input.value ?? "";
    if (!current && !value) throw new Error("Informe o valor do secret.");
    const now = new Date().toISOString();
    const secret: UserSecret = {
      id: current?.id ?? randomUUID(),
      name,
      description: (input.description ?? "").trim(),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    // An empty value on edit keeps the saved one.
    if (value)
      this.store.setSecret(`user:${secret.id}`, this.crypto.encrypt(value));
    this.store.put("user-secret", secret);
    this.cache = undefined;
    return secret;
  }
  delete(id: string) {
    this.store.delete("user-secret", id);
    this.store.delete("secret", `user:${id}`);
    this.cache = undefined;
  }
  // Name to value, for the processes of an agent; names that would change
  // that agent's own login or settings stay out of it.
  env(agent?: AgentId): Record<string, string> {
    if (!this.cache) {
      const values: Record<string, string> = {};
      for (const s of this.list()) {
        const data = this.store.secret(`user:${s.id}`);
        if (!data) continue;
        try {
          values[s.name] = this.crypto.decrypt(data);
        } catch {}
      }
      this.cache = values;
    }
    return Object.fromEntries(
      Object.entries(this.cache).filter(
        ([name]) => !agent || !secretBlockedFor(name, agent),
      ),
    );
  }
  value(name: string) {
    return this.env()[name];
  }
  // What the agent is told: names and descriptions, never the values.
  notes(agent: AgentId) {
    const available = this.env(agent);
    const listed = this.list().filter((s) => s.name in available);
    if (!listed.length) return "";
    return (
      "Secrets do Codebit: estas variáveis de ambiente já estão definidas nesta sessão e nos comandos que você executa: " +
      listed
        .map((s) => (s.description ? `${s.name} (${s.description})` : s.name))
        .join("; ") +
      ". Use-as pela variável ($env:NOME no PowerShell, $NOME no bash, os.environ no Python, process.env no Node), sem copiar o valor. Nunca mostre, registre nem grave o valor de um secret em arquivos, commits, logs ou mensagens."
    );
  }
  // Values an agent printed by mistake are masked in what Codebit keeps and
  // shows. Short values would mask ordinary words, so they are left alone.
  redact(text: string) {
    if (!text) return text;
    for (const [name, value] of Object.entries(this.env()))
      if (value.length >= 6 && text.includes(value))
        text = text.split(value).join(`[secret ${name}]`);
    return text;
  }
}
