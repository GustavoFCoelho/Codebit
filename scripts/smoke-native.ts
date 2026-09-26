import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discover, checkAuth } from "../src/main/discovery";
import { CodexSession } from "../src/main/agents/codex";
import { ClaudeSession } from "../src/main/agents/claude";
import { defaultImages, type AgentEvent, type Task } from "../src/shared/types";
async function main() {
  const cwd = resolve(".codebit-test", "native-smoke");
  await mkdir(cwd, { recursive: true });
  const agents = await discover({
    cliPaths: {},
    comfyUrl: "http://127.0.0.1:8188",
    defaultModels: { codex: "", claude: "" },
    mcp: [],
    workflows: [],
  });
  const results: any[] = [];
  for (const found of agents) {
    const agent = await checkAuth(found);
    console.log(
      JSON.stringify({
        agent: agent.id,
        version: agent.selected?.version,
        auth: agent.auth,
        message: agent.authMessage,
      }),
    );
    if (!agent.selected || agent.auth !== "ready") {
      results.push({
        agent: agent.id,
        status: "not-ready",
        message: agent.authMessage,
      });
      continue;
    }
    const task: Task = {
      id: "smoke-" + agent.id,
      projectId: "smoke",
      title: "Codebit native smoke",
      agent: agent.id,
      model: "",
      cwd,
      worktree: false,
      mode: "plan",
      status: "idle",
      archived: false,
      createdAt: "",
      updatedAt: "",
      images: defaultImages,
    };
    let nativeId = "";
    let answer = "";
    let failure = "";
    let finish: () => void = () => {};
    const done = new Promise<void>((r) => {
      finish = r;
    });
    const Session = agent.id === "codex" ? CodexSession : ClaudeSession;
    const session = new Session(
      agent.selected,
      task,
      {},
      (event: AgentEvent) => {
        if (event.type === "native") nativeId = event.id;
        if (event.type === "text") answer += event.text;
        if (event.type === "error") {
          failure = event.text;
          finish();
        }
        if (event.type === "done") finish();
        if (event.type === "request")
          session.respond(event.request.id, { decision: "decline" });
      },
    );
    const timer = setTimeout(() => {
      failure = "Tempo esgotado após 150s";
      finish();
    }, 150000);
    try {
      await session.send(
        "Responda somente CODEBIT_OK. Não use ferramentas, não leia arquivos e não altere nada.",
        [],
      );
      await done;
      const models = await session.models().catch(() => []);
      results.push({
        agent: agent.id,
        version: agent.selected.version,
        status: failure
          ? "failed"
          : answer.includes("CODEBIT_OK")
            ? "passed"
            : "unexpected-answer",
        nativeId,
        answer,
        error: failure,
        models: models.map((m) => m.id),
      });
      console.log(JSON.stringify(results.at(-1)));
    } catch (e) {
      const result = {
        agent: agent.id,
        status: "failed",
        error: (e as Error).message,
      };
      results.push(result);
      console.log(JSON.stringify(result));
    } finally {
      clearTimeout(timer);
      session.close();
    }
  }
  const imageReadiness = {
    openaiKeyPresent: !!process.env.OPENAI_API_KEY,
    comfyuiReachable: false,
  };
  try {
    imageReadiness.comfyuiReachable = (
      await fetch("http://127.0.0.1:8188/system_stats", {
        signal: AbortSignal.timeout(2500),
      })
    ).ok;
  } catch {}
  await writeFile(
    resolve(".codebit-test", "native-smoke-results.json"),
    JSON.stringify({ agents: results, images: imageReadiness }, null, 2),
  );
  console.log(JSON.stringify({ images: imageReadiness }));
  if (results.some((r) => r.status === "failed")) process.exitCode = 1;
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
