// Preloaded by every bunfig.toml (Bun reads only the bunfig.toml of the directory it runs in, so each package has one).
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { jest } from "bun:test";

// The per-test timeout CI passes (`bun test --timeout 60000`), so a plain `bun test` behaves the same. bunfig.toml has no timeout key.
jest.setTimeout(60_000);

// Tests and snippets reach `xrp-dev/*` through packages/core/dist. Missing pieces make a run fail for a reason that is not the
// change (`Cannot find module xrp-dev/wallet`); an old dist makes it test old code. The root `bun run build` makes all four.
const root = resolve(import.meta.dir, "..");
const dist = join(root, "packages/core/dist");
const parts: [name: string, dist: string][] = [["core", "index.js"], ["wallet", "wallet/index.js"], ["mcp", "mcp/index.js"], ["x402", "x402/index.js"]];

const newest = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((m, e) => Math.max(m, e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs), 0);

const missing = parts.filter(([, file]) => !existsSync(join(dist, file))).map(([name]) => name);
if (missing.length > 0) throw new Error(`packages/core/dist has no build of: ${missing.join(", ")}. Run \`bun run build\` at the repo root.`);

const stale = parts.filter(([name, file]) => newest(join(root, "packages", name, "src")) > statSync(join(dist, file)).mtimeMs).map(([name]) => name);
if (stale.length > 0) console.warn(`warning: packages/core/dist is older than the source of: ${stale.join(", ")}. Tests that import xrp-dev/* see the old build; \`bun run build\` at the repo root refreshes it.`);
