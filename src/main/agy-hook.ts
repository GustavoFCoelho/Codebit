import { request } from "node:http";
// A file's whole content is not needed to decide; the command is.
function shorten(value: any, key = ""): any {
  if (typeof value === "string")
    return value.length > 20000 && key !== "CommandLine"
      ? value.slice(0, 20000) + "…"
      : value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => shorten(v));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, shorten(v, k)]),
    );
  return value;
}
// Antigravity CLI's PreToolUse hook: the tool call arrives on stdin and the
// decision goes to stdout. Codebit decides, asking the user when needed, so
// the request waits as long as the user takes; node:http has no deadline
// for the answer, unlike fetch. Anything that fails denies the tool, and
// nothing goes to stderr, which the CLI cannot read when it is not UTF-8.
export function answerHook(
  stdin: NodeJS.ReadableStream = process.stdin,
  write: (text: string) => void = (text) => process.stdout.write(text),
  env: NodeJS.ProcessEnv = process.env,
) {
  return new Promise<void>((done) => {
    let finished = false;
    const answer = (decision: any) => {
      if (finished) return;
      finished = true;
      write(JSON.stringify(decision));
      done();
    };
    const deny = (reason: string) =>
      answer({ decision: "deny", reason: `Codebit: ${reason}` });
    let body = "";
    stdin.setEncoding?.("utf8");
    stdin.on("data", (chunk) => (body += chunk));
    stdin.on("error", () => deny("a entrada do hook falhou."));
    stdin.on("end", () => {
      let url: URL;
      try {
        url = new URL(env.CODEBIT_HOOK_URL || "");
      } catch {
        return deny("o Codebit não está disponível para aprovar esta ação.");
      }
      const req = request(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.CODEBIT_HOOK_TOKEN}`,
          },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("error", () => deny("a resposta do Codebit falhou."));
          res.on("end", () => {
            try {
              const r = JSON.parse(data);
              if (
                res.statusCode === 200 &&
                ["allow", "deny"].includes(r.decision)
              )
                answer(
                  r.reason
                    ? { decision: r.decision, reason: String(r.reason) }
                    : { decision: r.decision },
                );
              else deny(r.error || "o Codebit recusou a verificação.");
            } catch {
              deny("resposta inválida do Codebit.");
            }
          });
        },
      );
      req.on("error", () => deny("o Codebit não respondeu."));
      let call: any;
      try {
        call = JSON.parse(body);
      } catch {
        return deny("chamada de ferramenta ilegível.");
      }
      req.end(JSON.stringify(shorten(call)));
    });
  });
}
