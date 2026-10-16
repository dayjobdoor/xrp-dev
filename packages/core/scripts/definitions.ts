// Regenerates src/codec/definitions.json from a live rippled `server_definitions`.
// Usage: bun scripts/definitions.ts [rpc-url]   (default: https://s1.ripple.com:51234/)
// Same shape ripple-binary-codec ships: only the five tables the codec reads.
// After a real change, set XRPL_PROTOCOL.capturedOn in src/protocol.ts to today's date.
// This file is run with `bun`, outside the package tsconfig, so the two globals are named here.
declare const process: { argv: string[] };
declare const Bun: { write(path: URL, data: string): Promise<number> };

const KEYS = ["TYPES", "LEDGER_ENTRY_TYPES", "FIELDS", "TRANSACTION_RESULTS", "TRANSACTION_TYPES"] as const;

const url = process.argv[2] ?? "https://s1.ripple.com:51234/";
const res = await fetch(url, { method: "POST", body: JSON.stringify({ method: "server_definitions" }) });
if (!res.ok) throw new Error(`server_definitions: HTTP ${res.status}`);
const { result } = (await res.json()) as { result: Record<string, unknown> & { status?: string } };
if (result.status !== "success") throw new Error(`server_definitions: ${JSON.stringify(result)}`);

const out = Object.fromEntries(KEYS.map((k) => [k, result[k]]));
const missing = KEYS.filter((k) => out[k] === undefined);
if (missing.length) throw new Error(`server_definitions lacks ${missing.join(", ")}`);

const path = new URL("../src/codec/definitions.json", import.meta.url);
await Bun.write(path, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${path.pathname} (server hash ${String(result.hash)})`);
