import { BrowserWindow, session, type WebContents } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PatreonDriver } from "./social";
const home = "https://www.patreon.com";
// Who can see a post, by the labels of the editor (English or Portuguese).
const audiences: Record<string, string[]> = {
  public: ["^public$", "^público$", "^everyone$"],
  members: ["^all members$", "^todos os membros$", "^members$", "^membros$"],
  paid: [
    "^paid members( only)?$",
    "^(somente |apenas )?membros pagantes$",
    "^paid only$",
  ],
};
const publishLabels = ["^publish( now)?$", "^publicar( agora)?$", "^post now$"];
const imageLabels = [
  "^(add )?images?$",
  "^(adicionar )?imagem",
  "^(add )?photos?$",
  "^fotos?$",
  "^upload",
];
const audienceMenus = [
  "who can see",
  "^audience",
  "quem pode ver",
  "^público-alvo",
  "^access",
  "^acesso",
];
const tierMenus = [
  "select tiers",
  "specific tiers",
  "selecionar níveis",
  "níveis específicos",
];
// Helpers that run in the Patreon page: they find fields by what the page
// shows (placeholders, labels, button text), not by its internal classes.
const pageHelpers = `(() => {
  if (window.__codebit) return;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const attrs = (el) => ["placeholder", "aria-label", "data-tag", "name", "id"]
    .map((a) => el.getAttribute(a) || "").join(" ");
  const center = (el) => {
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };
  const isTitle = (el) => /title|título/i.test(attrs(el));
  const titleField = () => [...document.querySelectorAll("textarea, input, [contenteditable=true]")]
    .filter(visible).find(isTitle);
  const bodyField = () => [...document.querySelectorAll("[contenteditable=true]")]
    .filter((el) => visible(el) && !isTitle(el))
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  const clickable = (patterns) => {
    const res = patterns.map((p) => new RegExp(p, "i"));
    return [...document.querySelectorAll("button, [role=button], [role=radio], [role=option], [role=menuitemradio], [role=checkbox], label, a")]
      .filter(visible)
      .find((el) => res.some((re) => re.test((el.getAttribute("aria-label") || el.textContent || "").trim())));
  };
  window.__codebit = {
    title: () => { const el = titleField(); return el ? center(el) : null; },
    titleText: () => { const el = titleField(); return el ? (el.value ?? el.textContent ?? "") : ""; },
    body: () => { const el = bodyField(); return el ? center(el) : null; },
    bodyText: () => bodyField()?.innerText ?? "",
    bodyImages: () => bodyField()?.querySelectorAll("img").length ?? 0,
    find: (patterns) => { const el = clickable(patterns); return el ? center(el) : null; },
    checked: (patterns) => {
      const el = clickable(patterns);
      if (!el) return false;
      const on = (e) => e && (["aria-checked", "aria-selected", "aria-pressed"].some((a) => e.getAttribute(a) === "true") || e.checked === true);
      return on(el) || on(el.querySelector("input")) || on(el.closest("[aria-checked], [aria-selected]"))
        || (el.htmlFor && on(document.getElementById(el.htmlFor)));
    },
    diagnose: () => ({
      url: location.href,
      title: document.title,
      fields: [...document.querySelectorAll("input, textarea, [contenteditable=true]")].map((e) => ({
        tag: e.tagName, type: e.getAttribute("type"), attrs: attrs(e).trim(), visible: visible(e),
      })),
      buttons: [...document.querySelectorAll("button, [role=button], [role=radio], [role=option], label")]
        .filter(visible).map((e) => (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 80))
        .filter(Boolean).slice(0, 200),
    }),
  };
})()`;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export class Patreon implements PatreonDriver {
  constructor(
    private parent: () => BrowserWindow | undefined,
    private folder: string,
  ) {}
  private session(projectId: string) {
    return session.fromPartition(`persist:patreon-${projectId}`);
  }
  private window(projectId: string, title: string) {
    const win = new BrowserWindow({
      parent: this.parent(),
      width: 1180,
      height: 880,
      title,
      autoHideMenuBar: true,
      webPreferences: {
        session: this.session(projectId),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Links that open new windows go to the same one.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(home)) void win.loadURL(url);
      return { action: "deny" };
    });
    return win;
  }
  async status(projectId: string) {
    const ses = this.session(projectId);
    const cookies = await ses.cookies
      .get({ domain: "patreon.com" })
      .catch(() => []);
    const loggedIn = cookies.some((c) => c.name === "session_id");
    let name: string | undefined;
    if (loggedIn)
      try {
        const r = await ses.fetch(
          `${home}/api/current_user?fields%5Buser%5D=full_name`,
          { signal: AbortSignal.timeout(15_000) },
        );
        if (r.ok) name = ((await r.json()) as any)?.data?.attributes?.full_name;
      } catch {}
    return { loggedIn, name };
  }
  // The user logs in on Patreon's own page; the window closes once the
  // session cookie arrives. Codebit never sees the password.
  login(projectId: string) {
    const win = this.window(projectId, "Entrar no Patreon");
    void win.loadURL(`${home}/login`);
    return new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        void this.status(projectId).then((s) => {
          const url = win.isDestroyed() ? "" : win.webContents.getURL();
          if (s.loggedIn && url && !/\/login/.test(url)) win.close();
        });
      }, 2000);
      win.on("closed", () => {
        clearInterval(timer);
        resolve();
      });
    });
  }
  async logout(projectId: string) {
    await this.session(projectId).clearStorageData();
  }
  async publish(
    projectId: string,
    post: { title: string; text: string; images: string[]; audience: string },
    options: { dryRun?: boolean } = {},
  ) {
    const win = this.window(projectId, "Publicando no Patreon");
    const wc = win.webContents;
    let step = "abrir o editor";
    const debug = wc.debugger;
    debug.attach("1.3");
    const send = (method: string, params: object = {}) =>
      debug.sendCommand(method, params) as Promise<any>;
    const page = <T>(code: string) =>
      wc.executeJavaScript(`${pageHelpers};${code}`, true) as Promise<T>;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const until = async <T>(
      check: () => Promise<T>,
      ms: number,
      what: string,
    ) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const value = await check().catch(() => undefined);
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`${what} não apareceu`);
        await sleep(500);
      }
    };
    // Trusted clicks and typing, as if made by the user.
    const click = async (at: { x: number; y: number }) => {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", {
          type,
          ...at,
          button: "left",
          clickCount: 1,
        });
    };
    const enter = async () => {
      const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        ...key,
        text: "\r",
      });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    };
    const find = (patterns: string[]) =>
      page<{ x: number; y: number } | null>(
        `window.__codebit.find(${JSON.stringify(patterns)})`,
      );
    try {
      await wc.loadURL(`${home}/posts/new`);
      if (/\/login/.test(wc.getURL()))
        throw new Error(
          "a sessão do Patreon expirou; entre de novo em Configurações → Redes sociais",
        );
      step = "preencher o título";
      await click(
        await until(
          () => page<any>("window.__codebit.title()"),
          45_000,
          "o campo de título",
        ),
      );
      await send("Input.insertText", { text: post.title });
      if (
        !(await page<string>("window.__codebit.titleText()")).includes(
          post.title.slice(0, 20),
        )
      )
        throw new Error("o título não ficou no campo");
      step = "escrever o texto";
      await click(
        await until(
          () => page<any>("window.__codebit.body()"),
          15_000,
          "o campo do texto",
        ),
      );
      const paragraphs = post.text.split(/\n\s*\n/);
      for (const [i, paragraph] of paragraphs.entries()) {
        if (i) await enter();
        await send("Input.insertText", { text: paragraph.trim() });
      }
      const body = await page<string>("window.__codebit.bodyText()");
      if (!body.includes(paragraphs[0].trim().slice(0, 30)))
        throw new Error("o texto não ficou no editor");
      if (post.images.length) {
        step = "enviar as imagens";
        const before = await page<number>("window.__codebit.bodyImages()");
        await send("DOM.enable");
        await send("Page.enable");
        const { root } = await send("DOM.getDocument", {
          depth: -1,
          pierce: true,
        });
        const { nodeIds } = await send("DOM.querySelectorAll", {
          nodeId: root.nodeId,
          selector: "input[type=file]",
        });
        let input: number | undefined;
        for (const nodeId of nodeIds) {
          const { attributes } = await send("DOM.getAttributes", { nodeId });
          const accept = attributes[attributes.indexOf("accept") + 1] ?? "";
          if (!attributes.includes("accept") || /image/.test(accept))
            input = nodeId;
        }
        if (input)
          await send("DOM.setFileInputFiles", {
            nodeId: input,
            files: post.images,
          });
        else {
          // No file field yet: the image button opens one, caught here
          // instead of the Windows file dialog.
          await send("Page.setInterceptFileChooserDialog", { enabled: true });
          const chooser = new Promise<number>((resolve) => {
            const listener = (_: unknown, method: string, params: any) => {
              if (method !== "Page.fileChooserOpened") return;
              debug.off("message", listener);
              resolve(params.backendNodeId);
            };
            debug.on("message", listener);
          });
          const button = await find(imageLabels);
          if (!button) throw new Error("o botão de imagem não foi encontrado");
          await click(button);
          const backendNodeId = await Promise.race([
            chooser,
            sleep(10_000).then(() => {
              throw new Error("o seletor de arquivos não abriu");
            }),
          ]);
          await send("DOM.setFileInputFiles", {
            backendNodeId,
            files: post.images,
          });
        }
        await until(
          async () =>
            (await page<number>("window.__codebit.bodyImages()")) >=
            before + post.images.length,
          120_000,
          "a confirmação do envio das imagens",
        );
      }
      step = "escolher quem pode ver";
      const key = post.audience.trim().toLowerCase();
      const patterns = audiences[key] ?? [`^${escape(post.audience.trim())}$`];
      if (!(await find(patterns))) {
        const menu = await find(audienceMenus);
        if (menu) await click(menu);
        await sleep(800);
        if (!audiences[key] && !(await find(patterns))) {
          const tiers = await find(tierMenus);
          if (tiers) await click(tiers);
          await sleep(800);
        }
      }
      const option = await find(patterns);
      if (!option)
        throw new Error(`a opção de público "${post.audience}" não apareceu`);
      await click(option);
      await sleep(500);
      // Never publish to the wrong audience: without a confirmed choice the
      // draft stays open for the user.
      if (
        !(await page<boolean>(
          `window.__codebit.checked(${JSON.stringify(patterns)})`,
        ))
      )
        throw new Error(
          `não deu para confirmar o público "${post.audience}" na página`,
        );
      // The test from Settings stops here, with everything filled in.
      if (options.dryRun) return { url: wc.getURL() };
      step = "publicar";
      const publish = await find(publishLabels);
      if (!publish) throw new Error("o botão de publicar não foi encontrado");
      await click(publish);
      await sleep(1500);
      // Some flows ask to confirm in a dialog.
      if (!/\/posts\/(?!new)[^/?#]+/.test(wc.getURL())) {
        const again = await find(publishLabels);
        if (again) await click(again);
      }
      const url = await until(
        async () => {
          const current = wc.getURL();
          return /\/posts\/(?!new)[^/?#]+/.test(current) &&
            !/\/edit/.test(current)
            ? current.split("?")[0]
            : "";
        },
        60_000,
        "a página do post publicado",
      );
      win.close();
      return { url };
    } catch (e) {
      const saved = await this.diagnose(wc, step).catch(() => "");
      throw new Error(
        `O Codebit não conseguiu ${step} no Patreon: ${(e as Error).message}. ` +
          (step === "publicar"
            ? "Confira na janela se o post saiu antes de tentar de novo. "
            : "O rascunho ficou aberto na janela para você conferir e publicar por lá. ") +
          (saved ? `Diagnóstico salvo em ${saved}.` : ""),
      );
    } finally {
      if (!wc.isDestroyed() && debug.isAttached()) debug.detach();
    }
  }
  // What the page showed when a step failed, to adjust the steps above.
  private async diagnose(wc: WebContents, step: string) {
    await mkdir(this.folder, { recursive: true });
    const base = join(this.folder, "patreon-diagnostico");
    const info = await wc
      .executeJavaScript(`${pageHelpers};window.__codebit.diagnose()`, true)
      .catch((e) => ({ error: (e as Error).message }));
    await writeFile(
      base + ".json",
      JSON.stringify({ step, at: new Date().toISOString(), ...info }, null, 2),
    );
    const image = await wc.capturePage().catch(() => undefined);
    if (image) await writeFile(base + ".png", image.toPNG());
    return base + ".json";
  }
}
