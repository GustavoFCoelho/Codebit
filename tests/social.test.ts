import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/main/store";
import { Runtime } from "../src/main/runtime";
import { SocialService, type PatreonDriver } from "../src/main/social";
import { Instagram } from "../src/main/instagram";
import { hostFiles } from "../src/main/tunnel";
import { ImageBridge } from "../src/main/bridge";
import type { Entry, Project } from "../src/shared/types";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function temp() {
  const path = await mkdtemp(join(resolve(tmpdir()), "codebit-social-"));
  cleanups.push(() =>
    rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  );
  return path;
}
// A small Instagram: checks the token, downloads each image_url like the
// real one does, and remembers what was published.
async function fakeInstagram(accountType = "MEDIA_CREATOR") {
  const state = {
    token: "token-1",
    containers: [] as Record<string, string>[],
    downloads: [] as Buffer[],
    published: [] as string[],
    deleted: [] as string[],
    refreshes: 0,
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    let body = "";
    for await (const part of req) body += part;
    const params = Object.fromEntries(
      new URLSearchParams(req.method === "POST" ? body : url.search),
    );
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (params.access_token !== state.token)
      return json({ error: { code: 190, message: "Invalid token" } }, 400);
    const path = url.pathname;
    if (path === "/v23.0/me")
      return json({
        user_id: "17841",
        username: "forja",
        account_type: accountType,
      });
    if (path === "/refresh_access_token") {
      state.refreshes++;
      state.token = `token-${state.refreshes + 1}`;
      return json({ access_token: state.token, expires_in: 5184000 });
    }
    if (path === "/v23.0/17841/content_publishing_limit")
      return json({ data: [{ quota_usage: 3, config: { quota_total: 100 } }] });
    if (path === "/v23.0/17841/media") {
      if (params.image_url) {
        const image = await fetch(params.image_url);
        if (!image.ok)
          return json(
            { error: { code: 9004, message: "Media download has failed" } },
            400,
          );
        state.downloads.push(Buffer.from(await image.arrayBuffer()));
      }
      state.containers.push(params);
      return json({ id: `c${state.containers.length}` });
    }
    if (path === "/v23.0/17841/media_publish") {
      state.published.push(params.creation_id);
      return json({ id: "m1" });
    }
    if (/^[/]v23[.]0[/]c[0-9]+$/.test(path))
      return json({ status_code: "FINISHED" });
    if (path === "/v23.0/m1" && req.method === "DELETE") {
      state.deleted.push("m1");
      return json({ success: true });
    }
    if (path === "/v23.0/m1")
      return json({ permalink: "https://www.instagram.com/p/forja/" });
    json({ error: { message: "rota desconhecida " + path } }, 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return { state, base: `http://127.0.0.1:${(server.address() as any).port}` };
}
async function setup(accountType?: string) {
  const root = await temp();
  const store = new Store(join(root, "data"));
  cleanups.push(() => store.close());
  const ig = await fakeInstagram(accountType);
  const patreonPosts: any[] = [];
  const patreon: PatreonDriver = {
    status: async () => ({ loggedIn: true, name: "Forja no Patreon" }),
    login: async () => {},
    logout: async () => {},
    publish: async (_projectId, post) => {
      patreonPosts.push(post);
      return { url: "https://www.patreon.com/posts/forja-123" };
    },
  };
  let now = Date.parse("2026-09-28T12:00:00Z");
  const social = new SocialService({
    store,
    encrypt: (v) => "cifrado:" + v,
    decrypt: (v) => v.replace(/^cifrado:/, ""),
    // The app converts with Electron; here the file is only copied.
    prepareImage: async (src, _kind, out) => copyFile(src, out),
    host: (files) => hostFiles(files, undefined),
    patreon,
    instagram: new Instagram(ig.base, async () => {}),
    now: () => now,
  });
  const project = store.put<Project>("project", {
    id: "project-1",
    name: "Forja",
    path: root,
    git: false,
    trusted: true,
  });
  await writeFile(join(root, "arte.png"), "imagem-1");
  await writeFile(join(root, "arte2.jpg"), "imagem-2");
  return {
    root,
    store,
    social,
    ig,
    project,
    patreonPosts,
    advance: (days: number) => (now += days * 24 * 3600 * 1000),
  };
}
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condição não atendida");
    await new Promise((r) => setTimeout(r, 20));
  }
}
describe("redes sociais", () => {
  it("conecta o Instagram, guarda o token cifrado e renova antes de vencer", async () => {
    const s = await setup();
    const account = await s.social.connectInstagram("project-1", " token-1 ");
    expect(account).toMatchObject({
      name: "@forja",
      userId: "17841",
      accountType: "MEDIA_CREATOR",
      expiresAt: "2026-11-27T12:00:00.000Z",
    });
    // The token was renewed at once and only its encrypted form is saved.
    expect(s.store.secret(`social:${account.id}`)).toBe("cifrado:token-2");
    expect(await s.social.renewDue()).toBe(false);
    s.advance(8);
    expect(await s.social.renewDue()).toBe(true);
    expect(s.ig.state.refreshes).toBe(2);
    expect(s.store.secret(`social:${account.id}`)).toBe("cifrado:token-3");
    // A token that stopped working is reported in Settings.
    s.ig.state.token = "outro";
    await expect(s.social.renew(account.id)).rejects.toThrow(
      "inválido ou expirou",
    );
    expect(s.social.account("project-1", "instagram")?.error).toContain(
      "inválido",
    );
  });
  it("recusa conta pessoal do Instagram", async () => {
    const s = await setup("PERSONAL");
    await expect(
      s.social.connectInstagram("project-1", "token-1"),
    ).rejects.toThrow("contas profissionais");
    expect(s.social.accounts()).toEqual([]);
  });
  it("publica um carrossel só depois da aprovação, pelo endereço servido", async () => {
    const s = await setup();
    await s.social.connectInstagram("project-1", "token-1");
    const rt = new Runtime(
      s.store,
      () => {},
      () => undefined,
    );
    cleanups.push(() => rt.close());
    rt.social = s.social;
    const task = await rt.createTask({
      title: "Divulgar",
      agent: "codex",
      projectId: "project-1",
    });
    const accounts = JSON.parse(
      (await rt.socialTool(task.id, { tool: "social_accounts", args: {} }))
        .content[0].text,
    );
    expect(accounts).toEqual([
      expect.objectContaining({ network: "instagram", account: "@forja" }),
    ]);
    const call = rt.socialTool(task.id, {
      tool: "instagram_publish",
      args: {
        images: ["arte.png", join(s.root, "arte2.jpg")],
        caption: "Nova arte da forja #pixelart",
        ai_generated: true,
      },
    });
    await eventually(() =>
      s.store.entries(task.id).some((e) => e.kind === "request"),
    );
    // Nothing goes out before the user answers.
    expect(s.ig.state.containers).toHaveLength(0);
    expect(rt.task(task.id).status).toBe("waiting");
    const request = s.store
      .entries(task.id)
      .find((e) => e.kind === "request") as Entry;
    expect(request.request?.social).toMatchObject({
      network: "instagram",
      account: "@forja",
      text: "Nova arte da forja #pixelart",
      kind: "Carrossel",
    });
    expect(request.request?.social?.images).toHaveLength(2);
    rt.respond(task.id, request.id, { decision: "accept" });
    const result = JSON.parse((await call).content[0].text);
    expect(result).toEqual({
      published: true,
      url: "https://www.instagram.com/p/forja/",
      mediaId: "m1",
    });
    // Instagram downloaded the prepared files through the served addresses.
    expect(s.ig.state.downloads.map(String)).toEqual(["imagem-1", "imagem-2"]);
    expect(s.ig.state.containers.map((c) => c.is_carousel_item)).toEqual([
      "true",
      "true",
      undefined,
    ]);
    expect(s.ig.state.containers[2]).toMatchObject({
      media_type: "CAROUSEL",
      children: "c1,c2",
      caption: "Nova arte da forja #pixelart",
    });
    expect(s.ig.state.containers[0].is_ai_generated).toBe("true");
    expect(s.ig.state.published).toEqual(["c3"]);
    const [post] = s.social.posts("project-1");
    expect(post).toMatchObject({
      network: "instagram",
      url: "https://www.instagram.com/p/forja/",
      taskId: task.id,
    });
    expect(
      s.store
        .entries(task.id)
        .some((e) => e.text.includes("Instagram · publicado")),
    ).toBe(true);
    await s.social.deletePost(post.id);
    expect(s.ig.state.deleted).toEqual(["m1"]);
    expect(s.social.posts("project-1")[0].deletedAt).toBeTruthy();
  });
  it("recusada, a publicação não sai; no modo Planejar, nem é pedida", async () => {
    const s = await setup();
    await s.social.connectInstagram("project-1", "token-1");
    const rt = new Runtime(
      s.store,
      () => {},
      () => undefined,
    );
    cleanups.push(() => rt.close());
    rt.social = s.social;
    const task = await rt.createTask({
      title: "Divulgar",
      agent: "codex",
      projectId: "project-1",
    });
    const call = rt.socialTool(task.id, {
      tool: "instagram_publish",
      args: { images: ["arte.png"], caption: "Oi" },
    });
    await eventually(() =>
      s.store.entries(task.id).some((e) => e.kind === "request"),
    );
    const request = s.store.entries(task.id).find((e) => e.kind === "request")!;
    rt.respond(task.id, request.id, { decision: "decline" });
    expect((await call).content[0].text).toContain("recusou a publicação");
    expect(s.ig.state.containers).toHaveLength(0);
    // Formats and limits are checked before asking.
    await expect(
      rt.socialTool(task.id, {
        tool: "instagram_publish",
        args: { images: ["nada.png"] },
      }),
    ).rejects.toThrow("Imagem não encontrada");
    await expect(
      rt.socialTool(task.id, {
        tool: "instagram_publish",
        args: { images: ["arte.png", "arte2.jpg"], kind: "story" },
      }),
    ).rejects.toThrow("exatamente uma imagem");
    rt.updateTask(task.id, { mode: "plan" });
    await expect(
      rt.socialTool(task.id, {
        tool: "instagram_publish",
        args: { images: ["arte.png"] },
      }),
    ).rejects.toThrow("modo Planejar");
  });
  it("Patreon: pede o público, mostra a prévia e publica pelo editor", async () => {
    const s = await setup();
    await s.social.connectPatreon("project-1");
    const rt = new Runtime(
      s.store,
      () => {},
      () => undefined,
    );
    cleanups.push(() => rt.close());
    rt.social = s.social;
    const task = await rt.createTask({
      title: "Post",
      agent: "claude",
      projectId: "project-1",
    });
    await expect(
      rt.socialTool(task.id, {
        tool: "patreon_publish",
        args: { title: "Novo capítulo", text: "Texto" },
      }),
    ).rejects.toThrow("audience");
    await expect(
      rt.socialTool(task.id, {
        tool: "instagram_publish",
        args: { images: ["arte.png"] },
      }),
    ).rejects.toThrow("Conecte uma conta do Instagram");
    const call = rt.socialTool(task.id, {
      tool: "patreon_publish",
      args: {
        title: "Novo capítulo",
        text: "Parágrafo um.\n\nParágrafo dois.",
        images: ["arte.png"],
        audience: "paid",
      },
    });
    await eventually(() =>
      s.store.entries(task.id).some((e) => e.kind === "request"),
    );
    const request = s.store.entries(task.id).find((e) => e.kind === "request")!;
    expect(request.request?.social).toMatchObject({
      network: "patreon",
      account: "Forja no Patreon",
      title: "Novo capítulo",
      audience: "Só membros pagantes",
    });
    expect(s.patreonPosts).toHaveLength(0);
    rt.respond(task.id, request.id, { decision: "accept" });
    expect(JSON.parse((await call).content[0].text).url).toBe(
      "https://www.patreon.com/posts/forja-123",
    );
    expect(s.patreonPosts).toEqual([
      {
        title: "Novo capítulo",
        text: "Parágrafo um.\n\nParágrafo dois.",
        images: [join(s.root, "arte.png")],
        audience: "paid",
      },
    ]);
  });
  it("interromper a tarefa cancela a publicação que esperava aprovação", async () => {
    const s = await setup();
    await s.social.connectInstagram("project-1", "token-1");
    const rt = new Runtime(
      s.store,
      () => {},
      () => undefined,
    );
    cleanups.push(() => rt.close());
    rt.social = s.social;
    const task = await rt.createTask({
      title: "Divulgar",
      agent: "codex",
      projectId: "project-1",
    });
    rt.updateTask(task.id, { status: "running" });
    const call = rt.socialTool(task.id, {
      tool: "instagram_publish",
      args: { images: ["arte.png"] },
    });
    await eventually(() => rt.task(task.id).status === "waiting");
    await rt.interrupt(task.id);
    expect((await call).content[0].text).toContain("recusou");
    expect(s.ig.state.containers).toHaveLength(0);
  });
  it("o agente só recebe codebit_social em tarefas de projeto com conta conectada", async () => {
    const s = await setup();
    const rt = new Runtime(
      s.store,
      () => {},
      () => undefined,
    );
    cleanups.push(() => rt.close());
    rt.social = s.social;
    const installation = {
      agent: "codex" as const,
      path: process.execPath,
      command: process.execPath,
      args: [resolve("tests/fixtures/agent.mjs"), "codex"],
      version: "test",
    };
    rt.agents = [
      {
        id: "codex",
        name: "codex",
        auth: "ready",
        models: [],
        installations: [installation],
        selected: installation,
      },
    ];
    const servers: string[][] = [];
    const create = (rt as any).createSession.bind(rt);
    (rt as any).createSession = (...args: any[]) => {
      servers.push(Object.keys(args[2]));
      return create(...args);
    };
    const turn = async (id: string) => {
      await rt.send(id, "Oi");
      await eventually(() => rt.task(id).status === "idle");
      return servers.at(-1);
    };
    const inProject = await rt.createTask({
      title: "Com projeto",
      agent: "codex",
      projectId: "project-1",
    });
    expect(await turn(inProject.id)).not.toContain("codebit_social");
    await s.social.connectInstagram("project-1", "token-1");
    expect(await turn(inProject.id)).toContain("codebit_social");
    const free = await rt.createTask({ title: "Livre", agent: "codex" });
    expect(await turn(free.id)).not.toContain("codebit_social");
  });
  it("a ponte só aceita as ferramentas sociais com parâmetros válidos", async () => {
    const calls: any[] = [];
    const runtime = {
      socialTool: async (id: string, args: unknown) => {
        calls.push({ id, args });
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as Runtime;
    const bridge = new ImageBridge(runtime, process.execPath, "image-mcp.cjs");
    await bridge.start();
    try {
      const { env } = bridge.config("task-a", "social");
      expect(env.CODEBIT_TOOLS).toBe("social");
      const send = (body: unknown) =>
        fetch(env.CODEBIT_TOOL_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.CODEBIT_TOOL_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }).then((r) => r.status);
      expect(await send({ tool: "apagar_tudo", args: {} })).toBe(400);
      expect(
        await send({
          tool: "instagram_publish",
          args: { images: [], caption: "x".repeat(2201) },
        }),
      ).toBe(400);
      expect(
        await send({ tool: "instagram_publish", args: { images: ["a.png"] } }),
      ).toBe(200);
      expect(calls).toEqual([
        {
          id: "task-a",
          args: { tool: "instagram_publish", args: { images: ["a.png"] } },
        },
      ]);
    } finally {
      bridge.close();
    }
  });
  it("o servidor das imagens entrega só os arquivos do post", async () => {
    const root = await temp();
    await writeFile(join(root, "a.jpg"), "jpeg");
    const hosted = await hostFiles([join(root, "a.jpg")], undefined);
    try {
      const ok = await fetch(hosted.urls[0]);
      expect(ok.headers.get("content-type")).toBe("image/jpeg");
      expect(await ok.text()).toBe("jpeg");
      const other = hosted.urls[0].replace(/[0-9]+[.]jpg$/, "1.jpg");
      expect((await fetch(other)).status).toBe(404);
      const guess = hosted.urls[0].replace(/[/][0-9a-f]+[/]/, "/abc/");
      expect((await fetch(guess)).status).toBe(404);
    } finally {
      await hosted.close();
    }
    expect(await readFile(join(root, "a.jpg"), "utf8")).toBe("jpeg");
  });
});
