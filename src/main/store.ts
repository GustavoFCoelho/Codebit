import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Artifact,
  Entry,
  Project,
  SavedPrompt,
  Settings,
  Task,
} from "../shared/types";
import { defaultGuidelines } from "../shared/types";
export class Store {
  db: DatabaseSync;
  constructor(public root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(join(root, "codebit.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL, PRIMARY KEY(kind,id)); PRAGMA user_version=1;" +
        // Chat reads run on every streamed update; look entries up by task.
        "CREATE INDEX IF NOT EXISTS records_task ON records(kind, json_extract(data, '$.taskId'));",
    );
    for (const t of this.all<Task>("task"))
      // Background work ended with the app, like any running turn.
      if (["running", "waiting", "queued"].includes(t.status) || t.background) {
        t.status = "interrupted";
        delete t.background;
        this.put("task", t);
      }
  }
  all<T>(kind: string): T[] {
    return (
      this.db
        .prepare("SELECT data FROM records WHERE kind=? ORDER BY rowid")
        .all(kind) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  get<T>(kind: string, id: string): T {
    const row = this.db
      .prepare("SELECT data FROM records WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    if (!row) throw new Error("Registro não encontrado.");
    return JSON.parse(row.data);
  }
  put<T extends { id: string }>(kind: string, value: T): T {
    this.db
      .prepare(
        "INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, value.id, JSON.stringify(value));
    return value;
  }
  delete(kind: string, id: string) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  private byTask<T>(kind: string, taskId: string): T[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM records WHERE kind=? AND json_extract(data, '$.taskId')=? ORDER BY rowid",
        )
        .all(kind, taskId) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  entries(taskId: string): Entry[] {
    return this.byTask("entry", taskId);
  }
  artifacts(taskId: string): Artifact[] {
    return this.byTask("artifact", taskId);
  }
  settings(): Settings {
    const defaults: Settings = {
      cliPaths: {},
      comfyUrl: "http://127.0.0.1:8188",
      defaultModels: { codex: "", claude: "", devin: "" },
      mcp: [],
      workflows: [],
      guidelines: defaultGuidelines,
    };
    try {
      const saved = this.get<Settings>("settings", "main");
      return {
        ...saved,
        defaultModels: { ...defaults.defaultModels, ...saved.defaultModels },
        // Settings saved before guidelines existed get the default ones.
        guidelines: saved.guidelines ?? defaults.guidelines,
      };
    } catch {
      return defaults;
    }
  }
  saveSettings(value: Settings) {
    const { hasOpenAIKey, ...safe } = value;
    this.put("settings", { ...safe, id: "main" });
  }
  secret(name: string): string | undefined {
    try {
      return this.get<{ data: string }>("secret", name).data;
    } catch {
      return undefined;
    }
  }
  setSecret(name: string, data: string) {
    this.put("secret", { id: name, data });
  }
  snapshot() {
    return {
      projects: this.all<Project>("project"),
      tasks: this.all<Task>("task").sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
      prompts: this.all<SavedPrompt>("prompt").sort((a, b) =>
        a.name.localeCompare(b.name, "pt-BR"),
      ),
    };
  }
  close() {
    this.db.close();
  }
}
