import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runInWorkerd } from "../../core/test/workerd.js";
import * as keypairs from "ripple-keypairs";
import { describe, expect, it } from "vite-plus/test";
import { Wallet as XrplWallet } from "xrpl";

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** `bun build --target=browser` of one entry; the bundle as text. */
const bundle = (entry: string): string => {
  const r = spawnSync("bun", ["build", "--target=browser", "--format=esm", entry], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`bun build ${entry} failed: ${r.stderr}`);
  return r.stdout;
};

// P02: nothing Node-specific, and none of the test oracles, may end up in a bundle.
const ENTRIES = ["../src/index.ts", "../src/passkey.ts"];
const NODE_TRACES = [/node:/, /require\(/, /\bBuffer\b/, /process\./];
// "xrpl" alone also names the ledger in NETWORK_PRESETS; only an import of the xrpl.js package is an oracle leak.
const ORACLES = [/from\s*["']xrpl["']/, /ripple-/];

describe("P02 bundles carry no Node traces", () => {
  it.each(ENTRIES)("%s", (rel) => {
    // Effect's runtime probes for AsyncResource behind optional chaining; it is skipped where `process` is absent.
    const out = bundle(path(rel)).replaceAll('globalThis.process?.getBuiltinModule?.("node:async_hooks")', "");
    expect(out.length).toBeGreaterThan(1000);
    for (const re of [...NODE_TRACES, ...ORACLES]) expect(out, String(re)).not.toMatch(re);
  });
});

// P04: the same code, bundled and run in workerd (no nodejs_compat), against xrpl.js-derived expectations.
const payment = (account: string) => ({
  TransactionType: "Payment",
  Account: account,
  Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  Amount: "1000000",
  Fee: "12",
  Sequence: 7,
  LastLedgerSequence: 1000,
  Flags: 0,
});

describe("P04 workerd", () => {
  it("runner Worker reports no failures", async () => {
    const payments = ["snoPBrXtMeMyMHUVTgbuqAfg1SUTb", "sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE"].map((seed) => {
      const w = XrplWallet.fromSeed(seed);
      const tx = payment(w.address);
      return { seed, tx, ...w.sign(tx as never) };
    });
    const zero = keypairs.generateSeed({ entropy: new Uint8Array(16), algorithm: "ed25519" });

    const body = (await runInWorkerd(bundle(path("./portability/runner.ts")), {
      ed25519Zero: keypairs.deriveAddress(keypairs.deriveKeypair(zero).publicKey),
      payments,
    })) as { failures: string[]; ran: number };
    expect(body.failures).toEqual([]);
    expect(body.ran).toBeGreaterThan(0);
  });
});
