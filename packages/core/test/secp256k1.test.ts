import { secp256k1 as noble } from "@noble/curves/secp256k1.js";
import { Effect } from "effect";
import fc from "fast-check";
import { deriveKeypair, sign as rippleSign } from "ripple-keypairs";
import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { bytesToHex, hexToBytes, sha256, sha512Half } from "../src/crypto.js";
import { addScalars, getPublicKey, isValidPrivateKey, isValidPublicKey, n, sign, verify } from "../src/crypto/secp256k1.js";

const run = Effect.runPromise;
const hex = (s: string) => Effect.runSync(hexToBytes(s));
const big = (b: Uint8Array) => BigInt(`0x${bytesToHex(b) || "0"}`);
const to32 = (v: bigint) => hex(v.toString(16).padStart(64, "0"));
const failure = async <A>(e: Effect.Effect<A, { reason: string }>) => (await run(Effect.flip(e))).reason;

const priv = fc.uint8Array({ minLength: 32, maxLength: 32 }).filter(isValidPrivateKey);
const digest = fc.uint8Array({ minLength: 32, maxLength: 32 });
const RUNS = 1000;
const SLOW = 120_000; // generous ceiling for loaded CI machines

// Re-encode a DER signature with s replaced (used to build high-S variants).
const withS = (sig: Uint8Array, s: bigint) => {
  const rLen = sig[3]!;
  const r = sig.subarray(4, 4 + rLen);
  const sb = hex(s.toString(16).padStart(64, "0"));
  const sBody = sb[0]! & 0x80 ? new Uint8Array([0, ...sb]) : sb;
  return new Uint8Array([0x30, 2 + rLen + 2 + sBody.length, 2, rLen, ...r, 2, sBody.length, ...sBody]);
};
const sOf = (sig: Uint8Array) => big(sig.subarray(6 + sig[3]!));

describe("W-E03 known answers", () => {
  // Widely published RFC 6979 vector for secp256k1 (key 1, message "Satoshi Nakamoto"); its s is already low.
  const SATOSHI_DER = "3045022100934b1ea10a4b3c1757e2b0c017d0b6143ce3c9a7e6a4a49860d7a6ab210ee3d802202442ce9d2b916064108014783e923ec36b49743e2ffa1c4496f01a512aafd9e5";
  const G_COMPRESSED = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

  it("key 1 gives the generator and the pinned signature", async () => {
    const k = to32(1n);
    const d = await run(sha256(new TextEncoder().encode("Satoshi Nakamoto")));
    const pub = await run(getPublicKey(k));
    expect(bytesToHex(pub).toLowerCase()).toBe(G_COMPRESSED);
    const sig = await run(sign(d, k));
    expect(bytesToHex(sig).toLowerCase()).toBe(SATOSHI_DER);
    expect(await run(verify(sig, d, pub))).toBe(true);
  });

  it("addScalars wraps mod n", () => {
    expect(addScalars(to32(n - 1n), to32(1n))).toEqual(to32(0n));
    expect(addScalars(to32(n - 1n), to32(n - 1n))).toEqual(to32(n - 2n));
    expect(addScalars(to32(2n), to32(3n))).toEqual(to32(5n));
  });

  it("addScalars is (a+b) mod n", () => {
    fc.assert(
      fc.property(priv, priv, (a, b) => {
        expect(big(addScalars(a, b))).toBe((big(a) + big(b)) % n);
      }),
      { numRuns: RUNS },
    );
  });
});

// rippled ecdsaCanonicality: strict DER, r and s in 1..n-1, plus the full-canonical (low-S) rule.
describe("W-E03 rippled canonicality mutations", () => {
  const k = to32(0xc0ffeen);
  const d = new Uint8Array(32).fill(0x42);
  const mutate = async (f: (sig: Uint8Array) => Uint8Array | number[]) => {
    const pub = await run(getPublicKey(k));
    const sig = await run(sign(d, k));
    return run(verify(Uint8Array.from(f(sig)), d, pub));
  };
  const der = (r: number[], s: number[]) => [0x30, r.length + s.length + 4, 2, r.length, ...r, 2, s.length, ...s];
  const bytes = (v: bigint) => [...to32(v)];
  const one = [1];

  it("the unmodified signature verifies", async () => {
    expect(await mutate((s) => s)).toBe(true);
  });

  it.each([
    ["wrong sequence tag", (s: Uint8Array) => [0x31, ...s.subarray(1)]],
    ["sequence length too long", (s: Uint8Array) => [s[0]!, s[1]! + 1, ...s.subarray(2)]],
    ["sequence length too short", (s: Uint8Array) => [s[0]!, s[1]! - 1, ...s.subarray(2)]],
    ["long-form sequence length", (s: Uint8Array) => [0x30, 0x81, s[1]!, ...s.subarray(2)]],
    ["r tag not INTEGER", (s: Uint8Array) => [...s.subarray(0, 2), 3, ...s.subarray(3)]],
    ["s tag not INTEGER", (s: Uint8Array) => [...s.subarray(0, 4 + s[3]!), 3, ...s.subarray(5 + s[3]!)]],
    ["trailing byte", (s: Uint8Array) => [...s, 0]],
    ["trailing byte with fixed outer length", (s: Uint8Array) => [s[0]!, s[1]! + 1, ...s.subarray(2), 0]],
    ["empty r", () => der([], one)],
    ["empty s", () => der(one, [])],
    ["negative r", () => der([0x80, ...bytes(5n).slice(1)], one)],
    ["negative s", () => der(one, [0x80, ...bytes(5n).slice(1)])],
    ["padded r", () => der([0, 1], one)],
    ["padded s", () => der(one, [0, 1])],
    ["r = 0", () => der([0], one)],
    ["s = 0", () => der(one, [0])],
    ["r = n", () => der([0, ...bytes(n)], one)],
    ["s = n", () => der(one, [0, ...bytes(n)])],
    ["r = n+1", () => der([0, ...bytes(n + 1n)], one)],
    ["r over 33 bytes", () => der([0, 0x7f, ...bytes(1n)], one)],
  ])("%s verifies false", async (_, f) => {
    expect(await mutate(f)).toBe(false);
  });

  it("DER length outside 8..72 verifies false", async () => {
    expect(await mutate((s) => s.subarray(0, 7))).toBe(false);
    expect(await mutate(() => [])).toBe(false);
    expect(await mutate((s) => [...s, ...new Uint8Array(73 - s.length)])).toBe(false);
    expect(await mutate((s) => [...s, ...new Uint8Array(80 - s.length)])).toBe(false);
    expect(await mutate((s) => [...s, ...new Uint8Array(200 - s.length)])).toBe(false);
  });

  it("a maximum-size 72-byte DER is within bounds but is a high-S signature, so false", async () => {
    const sig = der([0, ...bytes(n - 1n)], [0, ...bytes(n - 1n)]);
    expect(sig.length).toBe(72);
    expect(await mutate(() => sig)).toBe(false);
  });
});

describe("W-E04 determinism and low-S", { timeout: SLOW }, () => {
  it("same key and digest give the same low-S signature that verifies", async () => {
    await fc.assert(
      fc.asyncProperty(priv, digest, async (k, d) => {
        const a = await run(sign(d, k));
        expect(await run(sign(d, k))).toEqual(a);
        expect(sOf(a) <= n / 2n).toBe(true);
        expect(await run(verify(a, d, await run(getPublicKey(k))))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("a high-S variant of a valid signature verifies false", async () => {
    await fc.assert(
      fc.asyncProperty(priv, digest, async (k, d) => {
        const pub = await run(getPublicKey(k));
        const sig = await run(sign(d, k));
        const high = withS(sig, n - sOf(sig));
        // Control: the mutation is a mathematically valid signature; only our high-S rule rejects it.
        expect(noble.verify(high, d, pub, { prehash: false, lowS: false, format: "der" })).toBe(true);
        expect(await run(verify(high, d, pub))).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("accepts uncompressed public keys; rejects non-DER and wrong digest length", async () => {
    const k = to32(12345n);
    const d = await run(sha512Half(new Uint8Array([1, 2, 3])));
    const sig = await run(sign(d, k));
    expect(await run(verify(sig, d, noble.getPublicKey(k, false)))).toBe(true);
    const pub = await run(getPublicKey(k));
    expect(await run(verify(new Uint8Array([...sig, 0]), d, pub))).toBe(false); // trailing byte
    expect(await run(verify(sig.subarray(0, sig.length - 1), d, pub))).toBe(false);
    expect(await run(verify(sig, d.subarray(0, 31), pub))).toBe(false);
    expect(await failure(sign(d.subarray(0, 31), k))).toBe("bad_length");
  });
});

describe("W-E05 invalid keys", () => {
  it.each([
    ["zero", new Uint8Array(32)],
    ["n", to32(n)],
    ["n+1", to32(n + 1n)],
    ["31 bytes", new Uint8Array(31).fill(1)],
    ["33 bytes", new Uint8Array(33).fill(1)],
  ])("private key %s is bad_key", async (_, k) => {
    expect(isValidPrivateKey(k)).toBe(false);
    expect(await failure(getPublicKey(k))).toBe("bad_key");
    expect(await failure(sign(new Uint8Array(32), k))).toBe("bad_key");
  });

  it("n-1 is a valid private key", async () => {
    expect(isValidPrivateKey(to32(n - 1n))).toBe(true);
    // (n-1)·G = -G: same x as G, odd y.
    expect(bytesToHex(await run(getPublicKey(to32(n - 1n)))).toLowerCase()).toBe("0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
  });

  it("off-curve and malformed public keys: verify false, isValidPublicKey false", async () => {
    const k = to32(7n);
    const d = new Uint8Array(32).fill(9);
    const sig = await run(sign(d, k));
    const good = await run(getPublicKey(k));
    const offCurve = new Uint8Array(65);
    offCurve[0] = 4;
    offCurve.set(to32(5n), 1);
    offCurve.set(to32(5n), 33);
    const xNotOnCurve = hex(`02${"00".repeat(31)}05`); // 5³+7 = 132 is a non-residue mod p
    const bad = [offCurve, xNotOnCurve, new Uint8Array(33), good.subarray(0, 32), hex(`04${bytesToHex(good.subarray(1))}`), new Uint8Array(0)];
    expect(isValidPublicKey(good)).toBe(true);
    for (const pk of bad) {
      expect(isValidPublicKey(pk)).toBe(false);
      expect(await run(verify(sig, d, pk))).toBe(false);
    }
  });
});

interface WycheproofTest { tcId: number; comment: string; msg: string; sig: string; result: "valid" | "invalid" | "acceptable" }
interface WycheproofGroup { publicKey: { uncompressed: string }; tests: WycheproofTest[] }

describe("W-E02 Wycheproof ecdsa_secp256k1_sha256", { timeout: SLOW }, () => {
  const file = JSON.parse(readFileSync(new URL("./vectors/wycheproof/ecdsa_secp256k1_sha256_test.json", import.meta.url), "utf8")) as { testGroups: WycheproofGroup[] };

  it("matches every vector (valid high-S expected false; acceptable either way)", async () => {
    const seen = { valid: 0, invalid: 0, acceptable: 0, highS: 0 };
    for (const g of file.testGroups) {
      const pub = hex(g.publicKey.uncompressed);
      for (const t of g.tests) {
        const sig = hex(t.sig);
        const got = await run(verify(sig, await run(sha256(hex(t.msg))), pub));
        seen[t.result]++;
        if (t.result === "acceptable") continue;
        // Wycheproof accepts high-S; we reject it by design. "valid" vectors are strict DER, so s sits after r.
        let highS = false;
        if (t.result === "valid") {
          highS = sOf(sig) > n / 2n;
          if (highS) seen.highS++;
        }
        expect(got, `tcId ${t.tcId}: ${t.comment}`).toBe(t.result === "valid" && !highS);
      }
    }
    console.log("wycheproof", seen);
    expect(seen.valid + seen.invalid + seen.acceptable).toBeGreaterThan(400);
  });
});

describe("ripple-keypairs agreement", { timeout: SLOW }, () => {
  const kp = deriveKeypair("snoPBrXtMeMyMHUVTgbuqAfg1SUTb");
  const k = hex(kp.privateKey.slice(2)); // strip the 00 prefix

  it("public key matches", async () => {
    expect(bytesToHex(await run(getPublicKey(k)))).toBe(kp.publicKey);
  });

  it("signatures equal ripple-keypairs sign over random messages", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 200 }), async (msg) => {
        const ours = bytesToHex(await run(sign(await run(sha512Half(msg)), k)));
        expect(ours).toBe(rippleSign(bytesToHex(msg), kp.privateKey));
      }),
      { numRuns: 200 },
    );
  });
});
