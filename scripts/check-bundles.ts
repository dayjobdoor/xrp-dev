// Bundles each built entry the way a browser app would (`bun build --target=browser --minify`) and fails when one is
// larger than its budget in scripts/bundle-budgets.json, or when `client` carries the curves again. A size that moves on
// purpose: `bun scripts/check-bundles.ts --update`, then record the new numbers in CHANGELOG.md. Run after `bun run build`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "packages/core/dist");
const BUDGETS = join(import.meta.dir, "bundle-budgets.json");
const SLACK = 1.03; // a budget is the measured size plus 3 %, so noise passes and a real addition does not

const ENTRIES = [
  "crypto", "address", "codec", "auth", "name", "name-server", "xahau", "client", "index",
  "effect/index", "effect/crypto", "effect/address", "effect/codec", "effect/client",
  "wallet/index", "wallet/effect", "wallet/passkey", "mcp/index", "x402/index",
];
// secp256k1's group order: the curve is in a bundle exactly when this constant is.
const SECP256K1_ORDER = /fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141/i;
// Entries that must stay curve-free: the clients only need `encode` and `decode` of the codec; `name` and the x402 gate never sign.
const CURVE_FREE = ["client", "effect/client", "name", "x402/index"];

if (!existsSync(DIST)) throw new Error("packages/core/dist is missing: run `bun run build` first");

const bundle = async (entry: string, minify: boolean): Promise<string> =>
  $`bun build --target=browser --format=esm ${minify ? ["--minify"] : []} ${join(DIST, `${entry}.js`)}`.quiet().text();

const update = process.argv.includes("--update");
const budgets: Record<string, number> = existsSync(BUDGETS) ? await Bun.file(BUDGETS).json() : {};
const next: Record<string, number> = {};
const failures: string[] = [];

for (const entry of ENTRIES) {
  const size = Buffer.byteLength(await bundle(entry, true));
  next[entry] = Math.ceil(size * SLACK);
  const budget = budgets[entry];
  const note = budget === undefined ? "no budget" : size <= budget ? "ok" : `OVER by ${size - budget} B`;
  const gzip = Bun.gzipSync(Buffer.from(await bundle(entry, true))).length;
  console.log(`${entry.padEnd(16)} ${String(size).padStart(7)} B  gzip ${String(gzip).padStart(6)} B  budget ${String(budget ?? "-").padStart(7)}  ${note}`);
  if (!update && (budget === undefined || size > budget)) failures.push(`${entry}: ${size} B, budget ${budget ?? "none"}`);
}

for (const entry of CURVE_FREE) {
  if (SECP256K1_ORDER.test(await bundle(entry, false))) failures.push(`${entry} bundles the secp256k1 curve (it must not: something it imports reads the curve at module level)`);
}

if (update) {
  await Bun.write(BUDGETS, JSON.stringify(next, null, 2) + "\n");
  console.log(`wrote ${BUDGETS}`);
} else if (failures.length) {
  console.error(`\nbundle check failed:\n- ${failures.join("\n- ")}\nIf the growth is intended: bun scripts/check-bundles.ts --update, and put the new sizes in CHANGELOG.md.`);
  process.exit(1);
}
