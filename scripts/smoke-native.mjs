import { build } from "esbuild";
import { spawn } from "node:child_process";
await build({
  entryPoints: ["scripts/smoke-native.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: ".codebit-test/smoke-native.cjs",
});
const child = spawn(process.execPath, [".codebit-test/smoke-native.cjs"], {
  stdio: "inherit",
  windowsHide: true,
});
child.on("exit", (code) => process.exit(code || 0));
