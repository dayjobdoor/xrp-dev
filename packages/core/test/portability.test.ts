import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInWorkerd } from "./workerd.js";
import { describe, expect, it } from "vite-plus/test";
import { Wallet as XrplWallet } from "xrpl";
import { Effect } from "effect";
import { encode, type TxJson } from "../src/codec.js";

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** `bun build --target=browser` of one entry; the bundle as text. */
const bundle = (entry: string): string => {
  const r = spawnSync("bun", ["build", "--target=browser", "--format=esm", entry], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`bun build ${entry} failed: ${r.stderr}`);
  return r.stdout;
};

// P02: nothing Node-specific, and none of the test oracles, may end up in a bundle.
const ENTRIES = ["crypto", "address", "codec", "client"]
  .map((n) => `../src/${n}.ts`)
  .concat("../src/index.ts");
const NODE_TRACES = [/node:/, /require\(/, /\bBuffer\b/, /process\./];
// Not a bare /xrpl/: the public testnet URL (xrpl-labs.com) legitimately contains it.
const ORACLES = [/node_modules\/xrpl\b|from "xrpl"/, /ripple-/];

describe("P02 bundles carry no Node traces", () => {
  it.each(ENTRIES)("%s", (rel) => {
    // Effect's runtime probes for AsyncResource behind optional chaining; it is skipped where `process` is absent.
    const out = bundle(path(rel)).replaceAll('globalThis.process?.getBuiltinModule?.("node:async_hooks")', "");
    expect(out.length).toBeGreaterThan(1000);
    for (const re of [...NODE_TRACES, ...ORACLES]) expect(out, String(re)).not.toMatch(re);
  });
});

// P04: the same code, bundled and run in workerd (no nodejs_compat), against xrpl.js-derived expectations.
const payment = (account: string): TxJson => ({
  TransactionType: "Payment",
  Account: account,
  Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  Amount: "1000000",
  Fee: "12",
  Sequence: 7,
  LastLedgerSequence: 1000,
  Flags: 0,
});

// Fixtures the codec encodes byte-for-byte, first 10 of each kind.
const supported = async (fixtures: { binary: string; json: TxJson }[]) => {
  const ok: typeof fixtures = [];
  for (const f of fixtures) {
    if (ok.length < 10 && (await Effect.runPromise(encode(f.json).pipe(Effect.orElseSucceed(() => "")))) === f.binary) ok.push(f);
  }
  return ok;
};

describe("P04 workerd", () => {
  it("runner Worker reports no failures", async () => {
    const seeds = ["snoPBrXtMeMyMHUVTgbuqAfg1SUTb", "sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE"];
    const payments = seeds.map((seed) => {
      const w = XrplWallet.fromSeed(seed);
      const tx = payment(w.address);
      return { seed, tx_blob: w.sign(tx as never).tx_blob };
    });
    const fixtures = JSON.parse(readFileSync(path("./vectors/codec-fixtures.json"), "utf8")) as Record<string, { binary: string; json: TxJson }[]>;
    const codec = [...(await supported(fixtures.transactions!)), ...(await supported(fixtures.accountState!))];
    expect(codec.length).toBeGreaterThan(0);

    const body = (await runInWorkerd(bundle(path("./portability/runner.ts")), { payments, codec })) as { failures: string[]; ran: number };
    expect(body.failures).toEqual([]);
    expect(body.ran).toBeGreaterThan(0);
  });
});
