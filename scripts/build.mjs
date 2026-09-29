import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
// Two builds must not write dist at once: the app running from the project
// folder builds on its own when src changes, and agents run npm run build.
const lock = "dist/.build-lock";
mkdirSync("dist", { recursive: true });
for (let tries = 0; ; tries++) {
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });
    break;
  } catch {
    const owner = Number(readFileSync(lock, "utf8"));
    let alive = false;
    try {
      process.kill(owner, 0);
      alive = true;
    } catch {}
    if (!alive || tries > 600) rmSync(lock, { force: true });
    else await new Promise((r) => setTimeout(r, 500));
  }
}
try {
  await build({
    entryPoints: ["src/main/index.ts", "src/main/image-mcp.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outdir: "dist/main",
    outExtension: { ".js": ".cjs" },
    external: ["electron", "node-pty"],
    sourcemap: true,
  });
  await build({
    entryPoints: ["src/preload/index.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: "dist/preload/index.cjs",
    external: ["electron"],
  });
  await viteBuild();
  copyFileSync("build/icon.png", "dist/icon.png");
  // Written last: the app running from the project folder compares these
  // hashes to know whether the interface or the app core changed.
  const hash = (...files) =>
    createHash("sha256")
      .update(Buffer.concat(files.map((f) => readFileSync(f))))
      .digest("hex");
  writeFileSync(
    "dist/build.json",
    JSON.stringify({
      version: JSON.parse(readFileSync("package.json", "utf8")).version,
      builtAt: new Date().toISOString(),
      core: hash(
        "dist/main/index.cjs",
        "dist/main/image-mcp.cjs",
        "dist/preload/index.cjs",
      ),
      interface: hash("dist/renderer/index.html"),
    }),
  );
} finally {
  rmSync(lock, { force: true });
}
