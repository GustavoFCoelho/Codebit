import { StringDecoder } from "node:string_decoder";
import { launch } from "../process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Installation } from "../../shared/types";
export class JsonLines {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  constructor(
    private receive: (value: any) => void,
    private invalid: (error: Error) => void,
  ) {}
  push(chunk: Buffer | string) {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (this.buffer.length > 32_000_000) {
      this.buffer = "";
      this.invalid(new Error("Mensagem do CLI excedeu 32 MB."));
      return;
    }
    let pos;
    while ((pos = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, pos).trim();
      this.buffer = this.buffer.slice(pos + 1);
      if (!line) continue;
      try {
        this.receive(JSON.parse(line));
      } catch (error) {
        this.invalid(
          new Error(`Resposta inválida do CLI: ${(error as Error).message}`),
        );
      }
    }
  }
}
export class Channel {
  child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private sequence = 0;
  private closing = false;
  private stderr = "";
  constructor(
    i: Installation,
    args: string[],
    cwd: string,
    private dialect: "codex" | "claude" | "acp",
    receive: (v: any) => void,
    fail: (e: Error) => void,
  ) {
    this.child = launch(i.command, [...i.args, ...args], cwd);
    // Codex App Server and ACP are both JSON-RPC; ACP requires the version tag.
    const rpc = dialect !== "claude";
    const lines = new JsonLines((msg) => {
      const response = rpc
        ? !msg.method && ("result" in msg || "error" in msg)
          ? msg
          : null
        : msg.type === "control_response"
          ? msg.response
          : null;
      const id = response && (rpc ? response.id : response.request_id);
      if (id != null && this.pending.has(String(id))) {
        const p = this.pending.get(String(id))!;
        this.pending.delete(String(id));
        clearTimeout(p.timer);
        if (response.error || response.subtype === "error")
          p.reject(
            new Error(
              typeof response.error === "string"
                ? response.error
                : response.error?.message || "O CLI recusou a solicitação.",
            ),
          );
        else p.resolve(rpc ? response.result : response.response);
        return;
      }
      receive(msg);
    }, fail);
    this.child.stdout.on("data", (c) => lines.push(c));
    this.child.stdin.on("error", (e) => {
      this.rejectAll(e);
      if (!this.closing) fail(e);
    });
    this.child.stderr.on("data", (c) => {
      this.stderr = (this.stderr + c).slice(-2000);
    });
    this.child.on("error", (e) => {
      this.rejectAll(e);
      if (!this.closing) fail(e);
    });
    this.child.on("close", (code) => {
      const error = new Error(
        `CLI encerrado (${code ?? "interrompido"}). ${this.stderr.replace(/(?:sk-|Bearer\s+)\S+/g, "[segredo omitido]")}`,
      );
      this.rejectAll(error);
      if (!this.closing) fail(error);
    });
  }
  send(value: any) {
    if (
      this.child.stdin.destroyed ||
      this.child.stdin.writableEnded ||
      this.closing
    )
      throw new Error("Conexão com o CLI encerrada.");
    this.child.stdin.write(
      JSON.stringify(
        this.dialect === "acp" ? { jsonrpc: "2.0", ...value } : value,
      ) + "\n",
    );
  }
  request(method: string, params: any = {}, timeout = 60000): Promise<any> {
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tempo esgotado: ${method}.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(
          this.dialect !== "claude"
            ? { id, method, params }
            : {
                type: "control_request",
                request_id: id,
                request: { subtype: method, ...params },
              },
        );
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  private rejectAll(e: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
  close() {
    this.closing = true;
    this.rejectAll(new Error("Sessão encerrada."));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 2500);
    timer.unref();
    this.child.once("close", () => clearTimeout(timer));
  }
}
