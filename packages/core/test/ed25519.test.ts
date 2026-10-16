import { Effect, Exit } from "effect";
import fc from "fast-check";
import { deriveKeypair, sign as rkSign } from "ripple-keypairs";
import { describe, expect, it } from "vite-plus/test";
import { bytesToHex, unsafeHexToBytes } from "../src/crypto/hex.js";
import { getPublicKey, isValidPublicKey, sign, verify } from "../src/crypto/ed25519.js";
import rfc from "./vectors/rfc8032-ed25519.json";
import wycheproof from "./vectors/wycheproof/ed25519_test.json";

const run = Effect.runPromise;
const h = unsafeHexToBytes;
const lower = (b: Uint8Array) => bytesToHex(b).toLowerCase();

describe("W-E01 RFC 8032 vectors", () => {
  for (const [name, v] of Object.entries(rfc as Record<string, Record<string, string>>)) {
    it(name, async () => {
      const sk = h(v["SECRET KEY"]!), msg = h(v["MESSAGE"]!), pk = h(v["PUBLIC KEY"]!);
      expect(lower(await run(getPublicKey(sk)))).toBe(v["PUBLIC KEY"]);
      const sig = await run(sign(msg, sk));
      expect(lower(sig)).toBe(v["SIGNATURE"]);
      expect(await run(verify(sig, msg, pk))).toBe(true);
    });
  }
});

describe("W-E02 Wycheproof", { timeout: 120_000 }, () => {
  it("valid/invalid match", async () => {
    let n = 0;
    for (const g of wycheproof.testGroups)
      for (const t of g.tests) {
        const ok = await run(verify(h(t.sig), h(t.msg), h(g.publicKey.pk)));
        expect(ok, `tcId ${t.tcId}`).toBe(t.result === "valid");
        n++;
      }
    expect(n).toBe(wycheproof.numberOfTests);
  });
});

describe("W-E03 strict verification", () => {
  const identity = h("01" + "00".repeat(31));
  const sk = new Uint8Array(32).fill(7), msg = new Uint8Array([1, 2, 3]);
  // L, little-endian: the group order. S >= L is the malleability rippled's ed25519Canonical rejects.
  const L_LE = h("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010");

  it("small-order public key (the identity) is false for any signature", async () => {
    expect(await run(verify(new Uint8Array(64), msg, identity))).toBe(false);
    // R = identity, S = 0 satisfies [S]B = R + [k]A for A = identity under any equation without the small-order guard.
    expect(await run(verify(new Uint8Array([...identity, ...new Uint8Array(32)]), msg, identity))).toBe(false);
    expect(await run(verify(new Uint8Array(64).fill(0xff), msg, identity))).toBe(false);
  });

  it("isValidPublicKey: canonical points pass (even small-order), non-canonical and wrong-length fail", async () => {
    expect(isValidPublicKey(await run(getPublicKey(sk)))).toBe(true);
    expect(isValidPublicKey(identity)).toBe(true); // only verify() rejects small order
    expect(isValidPublicKey(h("ed" + "ff".repeat(30) + "7f"))).toBe(false); // y = p
    expect(isValidPublicKey(h("01" + "00".repeat(30) + "80"))).toBe(false); // y = 1 (x = 0) with sign bit set
    expect(isValidPublicKey(new Uint8Array(31))).toBe(false);
    expect(isValidPublicKey(new Uint8Array(33))).toBe(false);
  });

  it("S >= L is false even when S - L would verify", async () => {
    const pk = await run(getPublicKey(sk)), sig = await run(sign(msg, sk));
    let s = 0n;
    for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i]!);
    let l = 0n;
    for (let i = 31; i >= 0; i--) l = (l << 8n) | BigInt(L_LE[i]!);
    const bumped = sig.slice();
    for (let i = 0, v = s + l; i < 32; i++, v >>= 8n) bumped[32 + i] = Number(v & 0xffn);
    expect(await run(verify(sig, msg, pk))).toBe(true);
    expect(await run(verify(bumped, msg, pk))).toBe(false);
  });

  it("signatures of 1000 random keys and messages verify, and one flipped bit does not", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.uint8Array({ maxLength: 200 }), fc.nat(63), async (k, m, i) => {
        const pk = await run(getPublicKey(k));
        const sig = await run(sign(m, k));
        expect(await run(verify(sig, m, pk))).toBe(true);
        const bad = sig.slice();
        bad[i] ^= 1;
        expect(await run(verify(bad, m, pk))).toBe(false);
      }),
      { numRuns: 1000 },
    );
  }, 300_000);
});

describe("W-E05 errors and tampering", () => {
  it("wrong-length key -> bad_key", async () => {
    for (const k of [new Uint8Array(31), new Uint8Array(33)]) {
      for (const e of [getPublicKey(k), sign(new Uint8Array(1), k)]) {
        const r = await run(Effect.exit(e));
        expect(Exit.isFailure(r) && JSON.stringify(r.cause)).toContain("bad_key");
      }
    }
  });
  it("tampered signature/message/lengths -> false", async () => {
    const sk = new Uint8Array(32).fill(7), msg = new Uint8Array([1, 2, 3]);
    const pk = await run(getPublicKey(sk)), sig = await run(sign(msg, sk));
    expect(await run(verify(sig, new Uint8Array([1, 2, 4]), pk))).toBe(false);
    const bad = sig.slice(); bad[10] ^= 1;
    expect(await run(verify(bad, msg, pk))).toBe(false);
    expect(await run(verify(sig.slice(0, 63), msg, pk))).toBe(false);
    expect(await run(verify(sig, msg, pk.slice(0, 31)))).toBe(false);
  });
});

describe("XRPL ed25519 keypair", () => {
  it("matches ripple-keypairs", async () => {
    const kp = deriveKeypair("sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE");
    expect(kp.privateKey.startsWith("ED")).toBe(true);
    const sk = h(kp.privateKey.slice(2));
    expect("ED" + bytesToHex(await run(getPublicKey(sk)))).toBe(kp.publicKey.toUpperCase());
    const msg = "DEADBEEF0102";
    expect(bytesToHex(await run(sign(h(msg), sk)))).toBe(rkSign(msg, kp.privateKey).toUpperCase());
  });
});
