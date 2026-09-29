import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { Runtime } from "./runtime";
export type BridgeKind = "images" | "agents" | "social" | "tasks";
const socialTools = ["social_accounts", "instagram_publish", "patreon_publish"];
function validate(kind: BridgeKind, args: any) {
  if (kind === "tasks") {
    if (args?.tool === "list_tasks") return;
    const a = args?.args;
    if (
      args?.tool !== "add_tasks" ||
      (a?.requested_by_user !== undefined &&
        typeof a.requested_by_user !== "boolean") ||
      !Array.isArray(a?.tasks) ||
      !a.tasks.length ||
      a.tasks.length > 10 ||
      a.tasks.some(
        (t: any) =>
          typeof t?.title !== "string" ||
          !t.title.trim() ||
          t.title.length > 200 ||
          (t.description !== undefined &&
            (typeof t.description !== "string" || t.description.length > 8000)),
      )
    )
      throw new Error(
        "Adicione de 1 a 10 tarefas, cada uma com título de até 200 caracteres.",
      );
    return;
  }
  if (kind === "social") {
    const a = args?.args ?? {};
    const text = (v: unknown, max: number) =>
      v === undefined || (typeof v === "string" && v.length <= max);
    if (
      !socialTools.includes(args?.tool) ||
      typeof a !== "object" ||
      (a.images !== undefined &&
        (!Array.isArray(a.images) ||
          a.images.length > 10 ||
          a.images.some(
            (i: unknown) => typeof i !== "string" || i.length > 2000,
          ))) ||
      !text(a.caption, 2200) ||
      !text(a.alt_text, 1000) ||
      !text(a.title, 300) ||
      !text(a.text, 60000) ||
      !text(a.audience, 200) ||
      !text(a.kind, 20)
    )
      throw new Error("Parâmetros de publicação inválidos.");
    return;
  }
  if (kind === "images") {
    if (
      typeof args.prompt !== "string" ||
      args.prompt.length > 32000 ||
      (args.inputImage !== undefined && typeof args.inputImage !== "string")
    )
      throw new Error("Parâmetros de imagem inválidos.");
    return;
  }
  if (
    !Array.isArray(args.tasks) ||
    !args.tasks.length ||
    args.tasks.length > 20 ||
    args.tasks.some(
      (t: any) =>
        typeof t?.prompt !== "string" ||
        !t.prompt.trim() ||
        t.prompt.length > 32000 ||
        (t.title !== undefined &&
          (typeof t.title !== "string" || t.title.length > 200)),
    )
  )
    throw new Error(
      "Informe de 1 a 20 tarefas, cada uma com prompt de até 32.000 caracteres.",
    );
}
export class ImageBridge {
  private server: Server;
  private tokens = new Map<string, { taskId: string; kind: BridgeKind }>();
  private port = 0;
  constructor(
    private runtime: Runtime,
    private executable: string,
    private script: string,
  ) {
    this.server = createServer(async (req, res) => {
      const grant = this.tokens.get(
        (req.headers.authorization || "").replace(/^Bearer /, ""),
      );
      if (!grant || req.method !== "POST" || req.url !== "/" + grant.kind) {
        res.writeHead(403).end();
        return;
      }
      try {
        let body = "";
        for await (const part of req) {
          body += part;
          if (body.length > 700000)
            throw new Error("Solicitação muito grande.");
        }
        const args = JSON.parse(body);
        validate(grant.kind, args);
        const result =
          grant.kind === "images"
            ? await runtime.imageTool(grant.taskId, args)
            : grant.kind === "social"
              ? await runtime.socialTool(grant.taskId, args)
              : grant.kind === "tasks"
                ? runtime.tasksTool(grant.taskId, args)
                : await runtime.subagentTool(grant.taskId, args);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });
  }
  async start() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as any).port;
        resolve();
      });
    });
  }
  // env: extra variables for the helper, such as the role of a session.
  config(
    taskId: string,
    kind: BridgeKind = "images",
    env: Record<string, string> = {},
  ) {
    for (const [key, grant] of this.tokens)
      if (grant.taskId === taskId && grant.kind === kind)
        this.tokens.delete(key);
    const token = randomBytes(32).toString("hex");
    this.tokens.set(token, { taskId, kind });
    return {
      command: this.executable,
      // Devin CLI starts only one of several servers with identical commands.
      args: [this.script, kind],
      env: <Record<string, string>>{
        ELECTRON_RUN_AS_NODE: "1",
        CODEBIT_TOOLS: kind,
        CODEBIT_TOOL_URL: `http://127.0.0.1:${this.port}/${kind}`,
        CODEBIT_TOOL_TOKEN: token,
        ...env,
      },
    };
  }
  revoke(taskId: string) {
    for (const [key, grant] of this.tokens)
      if (grant.taskId === taskId) this.tokens.delete(key);
  }
  close() {
    this.tokens.clear();
    this.server.closeAllConnections();
    this.server.close();
  }
}
