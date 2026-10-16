import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workerdBin: string = createRequire(import.meta.url)("workerd").default;

/** Runs `script` (an ESM Worker, no nodejs_compat) in workerd, POSTs `body`, returns the parsed JSON reply. */
export const runInWorkerd = async (script: string, body: unknown): Promise<unknown> => {
  const port = await new Promise<number>((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
  const dir = mkdtempSync(join(tmpdir(), "workerd-"));
  writeFileSync(join(dir, "runner.js"), script);
  writeFileSync(
    join(dir, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = (modules = [(name = "runner.js", esModule = embed "runner.js")], compatibilityDate = "2026-09-25"))],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]);`,
  );
  const proc = spawn(workerdBin, ["serve", join(dir, "config.capnp")], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  proc.stderr.on("data", (d) => (err += d));
  let exited = false;
  proc.on("exit", () => (exited = true));
  try {
    for (let i = 0; ; i++) {
      if (exited || i > 200) throw new Error(`workerd did not start: ${err}`);
      try {
        const res = await globalThis.fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: JSON.stringify(body) });
        return await res.json();
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
};
