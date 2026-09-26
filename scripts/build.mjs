import { build } from "esbuild";
import { build as viteBuild } from "vite";
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
