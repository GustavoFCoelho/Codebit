import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
export interface CaptureOptions {
  maxOutputBytes?: number;
  truncate?: boolean;
}
export interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
export function childEnv(extra: Record<string, string> = {}) {
  return {
    ...process.env,
    USERPROFILE: process.env.USERPROFILE || homedir(),
    ...extra,
  };
}
export function launch(
  command: string,
  args: string[],
  cwd: string,
  extra: Record<string, string> = {},
): ChildProcessWithoutNullStreams {
  return spawn(command, args, {
    cwd,
    env: childEnv(extra),
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
export function capture(
  command: string,
  args: string[],
  cwd = process.cwd(),
  timeout = 8000,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const child = launch(command, args, cwd);
    const limit = options.maxOutputBytes ?? 8_000_000;
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      stop(new Error("O processo não respondeu a tempo."));
    }, timeout);
    function finish(error?: Error, code = -1, truncated = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else {
        const bytes = Buffer.concat(chunks, size);
        resolve({
          code,
          truncated,
          stderr: stderr.toString("utf8"),
          stdout: truncated
            ? new StringDecoder("utf8").write(bytes)
            : bytes.toString("utf8"),
        });
      }
      chunks.length = 0;
      size = 0;
      stderr = Buffer.alloc(0);
    }
    function stop(error?: Error, truncated = false) {
      if (settled) return;
      // Stop collecting before killing: buffered output may arrive after kill().
      finish(error, -1, truncated);
      try {
        child.kill();
      } catch {
        /* The process may already have exited. */
      }
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
    }
    child.stdout.on("data", (c) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(c) ? c : Buffer.from(c);
      const remaining = limit - size;
      if (bytes.length > remaining) {
        if (options.truncate) {
          if (remaining > 0) {
            chunks.push(Buffer.from(bytes.subarray(0, remaining)));
            size += remaining;
          }
          stop(undefined, true);
        } else stop(new Error("Resposta do processo excedeu o limite."));
        return;
      }
      chunks.push(bytes);
      size += bytes.length;
    });
    child.stderr.on("data", (c) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(c) ? c : Buffer.from(c);
      const tail = bytes.subarray(-32_000);
      const retained = Math.min(stderr.length, 32_000 - tail.length);
      stderr = Buffer.concat([stderr.subarray(stderr.length - retained), tail]);
    });
    child.stdout.on("error", stop);
    child.stderr.on("error", stop);
    child.stdin.on("error", stop);
    child.on("error", stop);
    child.on("close", (code) => finish(undefined, code ?? -1));
  });
}
