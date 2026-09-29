import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { capture, launch } from "./process";
// Instagram only takes images by a public address. Codebit serves the files
// of one post from this computer through a Cloudflare quick tunnel, open
// only while the post is being published, with no account needed.
export async function findCloudflared(): Promise<
  { path: string; version: string } | undefined
> {
  const candidates = [
    join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "cloudflared",
      "cloudflared.exe",
    ),
    join(
      process.env.ProgramFiles || "C:\\Program Files",
      "cloudflared",
      "cloudflared.exe",
    ),
    join(
      process.env.LOCALAPPDATA || "",
      "Microsoft",
      "WinGet",
      "Links",
      "cloudflared.exe",
    ),
  ].filter((p) => existsSync(p));
  const where = await capture("where.exe", ["cloudflared"]).catch(() => null);
  if (where?.code === 0)
    candidates.push(
      ...where.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    );
  for (const path of candidates) {
    const r = await capture(path, ["--version"]).catch(() => null);
    const version = /version ([\w.-]+)/.exec(r?.stdout || r?.stderr || "")?.[1];
    if (r?.code === 0 && version) return { path, version };
  }
  return undefined;
}
export interface Hosted {
  urls: string[];
  close(): Promise<void>;
}
// Serves the files at unguessable addresses, through the tunnel. Without
// cloudflared (tests), only on this computer.
export async function hostFiles(
  files: string[],
  cloudflared: string | undefined,
  { timeout = 60_000 } = {},
): Promise<Hosted> {
  const secret = randomBytes(24).toString("hex");
  const names = files.map((_, i) => `${i}.jpg`);
  const server = createServer(async (req, res) => {
    const i = names.findIndex((n) => req.url === `/${secret}/${n}`);
    if (i < 0 || !["GET", "HEAD"].includes(req.method || "")) {
      res.writeHead(404).end();
      return;
    }
    try {
      const data = await readFile(files[i]);
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": data.length,
      });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  if (!cloudflared)
    return {
      urls: names.map((n) => `http://127.0.0.1:${port}/${secret}/${n}`),
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  const child = launch(
    cloudflared,
    ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"],
    process.cwd(),
  );
  const close = async () => {
    child.kill();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  try {
    let log = "";
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `O túnel do cloudflared não abriu em ${timeout / 1000} s.${log ? ` Saída: ${log.slice(-400)}` : ""}`,
            ),
          ),
        timeout,
      );
      const read = (chunk: Buffer) => {
        log += chunk.toString();
        const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log)?.[0];
        if (url) {
          clearTimeout(timer);
          resolve(url);
        }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `O cloudflared fechou (código ${code}) antes de abrir o túnel. ${log.slice(-400)}`,
          ),
        );
      });
    });
    const urls = names.map((n) => `${base}/${secret}/${n}`);
    // The address answers only after the tunnel registers with Cloudflare.
    const deadline = Date.now() + timeout;
    for (;;) {
      const ok = await fetch(urls[0], {
        method: "HEAD",
        signal: AbortSignal.timeout(5000),
      })
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) break;
      if (Date.now() > deadline)
        throw new Error(
          "O túnel abriu, mas o endereço público não respondeu a tempo.",
        );
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { urls, close };
  } catch (e) {
    await close();
    throw e;
  }
}
