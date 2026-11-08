import { sign as keypairSign } from "ripple-keypairs";
import { describe, expect, it } from "vite-plus/test";
import { Wallet as XrplWallet } from "xrpl";
import { deriveAccountId, encodeAccountId } from "../src/address.js";
import {
  CHALLENGE_TTL_MS,
  createChallenge,
  isFreshChallenge,
  login,
  loginMessage,
  loginProofTx,
  verifyLogin,
  verifyMessage,
  verifyProofTx,
} from "../src/auth.js";
import { encode, encodeForMultisigning } from "../src/codec.js";
import { sha512Half } from "../src/crypto/hash.js";
import { bytesToHex } from "../src/crypto/hex.js";
import * as secp256k1 from "../src/crypto/secp256k1.js";

const SECRET = "test-secret";
const APP = "TEST APP";
const ORIGIN = "https://app.example";
const hex = (text: string) => Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("");
const scope = (challenge: string, name?: string) => ({ app: APP, origin: ORIGIN, challenge, ...(name !== undefined && { name }) });

describe("challenge", () => {
  const now = 1_700_000_000_000;
  const opts = { app: APP, origin: ORIGIN, now };

  it("a fresh challenge passes; 5 min + 1 ms later it does not", async () => {
    const c = await createChallenge(SECRET, opts);
    expect(await isFreshChallenge(SECRET, c, { ...opts, now: now + CHALLENGE_TTL_MS })).toBe(true);
    expect(await isFreshChallenge(SECRET, c, { ...opts, now: now + CHALLENGE_TTL_MS + 1 })).toBe(false);
  });

  it("rejects a tampered MAC, nonce or time, another app, origin or secret, and a challenge from the future", async () => {
    const c = await createChallenge(SECRET, opts);
    const [issuedAt, nonce, mac] = c.split(".") as [string, string, string];
    const flip = (h: string) => `${h.slice(0, -1)}${h.endsWith("0") ? "1" : "0"}`;
    expect(await isFreshChallenge(SECRET, `${issuedAt}.${nonce}.${flip(mac)}`, opts)).toBe(false);
    expect(await isFreshChallenge(SECRET, `${issuedAt}.${flip(nonce)}.${mac}`, opts)).toBe(false);
    expect(await isFreshChallenge(SECRET, `${Number(issuedAt) + 1}.${nonce}.${mac}`, opts)).toBe(false);
    expect(await isFreshChallenge(SECRET, c, { ...opts, app: "OTHER APP" })).toBe(false);
    expect(await isFreshChallenge(SECRET, c, { ...opts, origin: "https://evil.example" })).toBe(false);
    expect(await isFreshChallenge("other-secret", c, opts)).toBe(false);
    expect(await isFreshChallenge(SECRET, c, { ...opts, now: now - 1 })).toBe(false);
  });

  it("two challenges issued in the same millisecond differ, and carry a 128-bit nonce", async () => {
    const [a, b] = [await createChallenge(SECRET, opts), await createChallenge(SECRET, opts)];
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).toMatch(/^[0-9A-F]{32}$/);
  });

  it("refuses the previous `<unix ms>.<mac>` format", async () => {
    const old = `${now}.${"ab".repeat(32)}`;
    expect(await isFreshChallenge(SECRET, old, opts)).toBe(false);
  });

  it("needs an origin", async () => {
    await expect(createChallenge(SECRET, { app: APP } as never)).rejects.toThrow(TypeError);
    await expect(createChallenge(SECRET, { app: APP, origin: "" })).rejects.toThrow(TypeError);
  });
});

describe("loginMessage", () => {
  it("names the app, the origin and, when given, the name", () => {
    expect(loginMessage(scope("c"))).toBe(`${APP} login\nOrigin: ${ORIGIN}\nChallenge: c`);
    expect(loginMessage(scope("c", "dave"))).toBe(`${APP} login\nOrigin: ${ORIGIN}\nName: dave\nChallenge: c`);
  });
});

describe("verifyMessage", () => {
  const seeds = { secp256k1: "snoPBrXtMeMyMHUVTgbuqAfg1SUTb", ed25519: "sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE" };

  for (const [algorithm, seed] of Object.entries(seeds)) {
    it(`${algorithm}: returns the address, and undefined for a flipped byte`, async () => {
      const wallet = XrplWallet.fromSeed(seed);
      const message = loginMessage(scope("1.abc"));
      const signature = keypairSign(hex(message), wallet.privateKey);
      expect(verifyMessage({ message, signature, publicKey: wallet.publicKey })).toBe(wallet.address);
      const flipped = `${signature.slice(0, 10)}${signature[10] === "0" ? "1" : "0"}${signature.slice(11)}`;
      expect(verifyMessage({ message, signature: flipped, publicKey: wallet.publicKey })).toBeUndefined();
      expect(verifyMessage({ message: `${message}x`, signature, publicKey: wallet.publicKey })).toBeUndefined();
    });
  }
});

describe("loginProofTx", () => {
  // xrpl-connect's XamanAdapter.sign() throws below 32570 and sends `multisign: true` for an empty SigningPubKey
  it("meets Xaman's sign() contract: absolute LastLedgerSequence, SigningPubKey left to the wallet", () => {
    const tx = loginProofTx({ ...scope("1.abc"), account: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY" });
    expect(tx.LastLedgerSequence).toBeGreaterThanOrEqual(32570);
    expect(tx.LastLedgerSequence).toBeLessThanOrEqual(4294967295);
    expect(tx).not.toHaveProperty("SigningPubKey");
  });
});

describe("verifyProofTx", () => {
  const wallet = XrplWallet.fromSeed("sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE");
  const proof = (challenge: string, over: Record<string, unknown> = {}, name?: string) => ({
    ...loginProofTx({ ...scope(challenge, name), account: wallet.address }),
    ...over,
  });

  it("returns the address of a master-key signature over the proof", async () => {
    const { tx_blob } = wallet.sign(proof("1.abc") as never);
    expect(verifyProofTx(tx_blob, scope("1.abc"))).toBe(wallet.address);
  });

  it("refuses another challenge, app, origin or name, Sequence 1, and a nonzero Fee", async () => {
    const { tx_blob } = wallet.sign(proof("1.abc") as never);
    expect(verifyProofTx(tx_blob, scope("1.xyz"))).toBeUndefined();
    expect(verifyProofTx(tx_blob, { ...scope("1.abc"), app: "OTHER" })).toBeUndefined();
    expect(verifyProofTx(tx_blob, { ...scope("1.abc"), origin: "https://evil.example" })).toBeUndefined();
    expect(verifyProofTx(tx_blob, scope("1.abc", "dave"))).toBeUndefined();
    expect(verifyProofTx(wallet.sign(proof("1.abc", {}, "dave") as never).tx_blob, scope("1.abc"))).toBeUndefined();
    expect(verifyProofTx(wallet.sign(proof("1.abc", { Sequence: 1 }) as never).tx_blob, scope("1.abc"))).toBeUndefined();
    expect(verifyProofTx(wallet.sign(proof("1.abc", { Fee: "10" }) as never).tx_blob, scope("1.abc"))).toBeUndefined();
  });

  it("refuses a blob signed by a regular key", async () => {
    const regular = XrplWallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb");
    const { tx_blob } = new XrplWallet(regular.publicKey, regular.privateKey, { masterAddress: wallet.address }).sign(proof("1.abc") as never);
    expect(verifyProofTx(tx_blob, scope("1.abc"))).toBeUndefined();
  });

  it("refuses garbage", async () => {
    expect(verifyProofTx("zz", scope("1.abc"))).toBeUndefined();
  });

  it("refuses a 32-signer multisigned blob without verifying its signatures", () => {
    const keys = Array.from({ length: 32 }, () => {
      const k = crypto.getRandomValues(new Uint8Array(32));
      const publicKey = secp256k1.getPublicKey(k);
      return { k, publicKey, id: deriveAccountId(publicKey) };
    }).sort((x, y) => (bytesToHex(x.id) < bytesToHex(y.id) ? -1 : 1));
    const base: Record<string, unknown> = { ...proof("1.abc"), Account: encodeAccountId(keys[0]!.id), SigningPubKey: "" };
    const Signers = keys.map(({ k, publicKey, id }) => {
      const account = encodeAccountId(id);
      const signature = secp256k1.sign(sha512Half(encodeForMultisigning(base, account)), k);
      return { Signer: { Account: account, SigningPubKey: bytesToHex(publicKey).toUpperCase(), TxnSignature: bytesToHex(signature).toUpperCase() } };
    });
    const blob = encode({ ...base, Signers } as never);
    const started = performance.now();
    for (let i = 0; i < 10; i++) expect(verifyProofTx(blob, scope("1.abc"))).toBeUndefined();
    // verifying all 32 signatures costs about 130 ms a call
    expect((performance.now() - started) / 10).toBeLessThan(25);
  });
});

describe("verifyLogin", () => {
  const wallet = XrplWallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb");
  const signed = async (name?: string) => {
    const challenge = await createChallenge(SECRET, { app: APP, origin: ORIGIN });
    const signature = keypairSign(hex(loginMessage(scope(challenge, name))), wallet.privateKey);
    return { app: APP, origin: ORIGIN, challenge, signature, publicKey: wallet.publicKey, ...(name !== undefined && { name }) };
  };

  it("maps each failure to its code", async () => {
    const good = await signed();
    expect(await verifyLogin(SECRET, good)).toEqual({ address: wallet.address });
    const { signature: _, ...unsigned } = good;
    expect(await verifyLogin(SECRET, unsigned)).toEqual({ code: "invalid_request" });
    expect(await verifyLogin(SECRET, { ...good, challenge: "1.00" })).toEqual({ code: "challenge_invalid" });
    expect(await verifyLogin(SECRET, { ...good, signature: "00" })).toEqual({ code: "signature_invalid" });
  });

  it("accepts a proof transaction", async () => {
    const { challenge } = await signed();
    const { tx_blob } = wallet.sign(loginProofTx({ ...scope(challenge), account: wallet.address }) as never);
    expect(await verifyLogin(SECRET, { app: APP, origin: ORIGIN, challenge, proof: tx_blob })).toEqual({ address: wallet.address });
  });

  it("fails with challenge_invalid for another origin or app, and with signature_invalid for another signed origin", async () => {
    const good = await signed();
    expect(await verifyLogin(SECRET, { ...good, origin: "https://evil.example" })).toEqual({ code: "challenge_invalid" });
    expect(await verifyLogin(SECRET, { ...good, app: "OTHER APP" })).toEqual({ code: "challenge_invalid" });
    const challenge = await createChallenge(SECRET, { app: APP, origin: ORIGIN });
    const signature = keypairSign(hex(loginMessage({ ...scope(challenge), origin: "https://evil.example" })), wallet.privateKey);
    expect(await verifyLogin(SECRET, { app: APP, origin: ORIGIN, challenge, signature, publicKey: wallet.publicKey })).toEqual({ code: "signature_invalid" });
  });

  it("refuses a challenge in the previous format", async () => {
    const good = await signed();
    expect(await verifyLogin(SECRET, { ...good, challenge: `${Date.now()}.${"ab".repeat(32)}` })).toEqual({ code: "challenge_invalid" });
  });

  it("binds the name: the signature of one name does not carry another", async () => {
    const good = await signed("dave");
    expect(await verifyLogin(SECRET, good)).toEqual({ address: wallet.address });
    expect(await verifyLogin(SECRET, { ...good, name: "mallory" })).toEqual({ code: "signature_invalid" });
    const { name: _, ...nameless } = good;
    expect(await verifyLogin(SECRET, nameless)).toEqual({ code: "signature_invalid" });
  });

  it("rejects oversized proof, signature, publicKey and name before any crypto", async () => {
    const good = await signed();
    const long = (n: number) => "0".repeat(n);
    expect(await verifyLogin(SECRET, { ...good, signature: long(161) })).toEqual({ code: "invalid_request" });
    expect(await verifyLogin(SECRET, { ...good, publicKey: long(67) })).toEqual({ code: "invalid_request" });
    expect(await verifyLogin(SECRET, { ...good, name: "a".repeat(129) })).toEqual({ code: "invalid_request" });
    expect(await verifyLogin(SECRET, { app: APP, origin: ORIGIN, challenge: good.challenge, proof: long(4097) })).toEqual({ code: "invalid_request" });
  });

  describe("consumeChallenge", () => {
    it("without the hook a signed login replays within the TTL", async () => {
      const good = await signed();
      expect(await verifyLogin(SECRET, good)).toEqual({ address: wallet.address });
      expect(await verifyLogin(SECRET, good)).toEqual({ address: wallet.address });
    });

    it("a second use answers challenge_used (sync or async hook), with the nonce and expiry", async () => {
      const good = await signed();
      const seen = new Map<string, number>();
      const consumeChallenge = async (nonce: string, expiresAtMs: number) => !seen.has(nonce) && (seen.set(nonce, expiresAtMs), true);
      expect(await verifyLogin(SECRET, { ...good, consumeChallenge })).toEqual({ address: wallet.address });
      expect(await verifyLogin(SECRET, { ...good, consumeChallenge })).toEqual({ code: "challenge_used" });
      const [nonce, expiresAt] = [...seen][0]!;
      expect(nonce).toBe(good.challenge.split(".")[1]);
      expect(expiresAt).toBeGreaterThan(Date.now());
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + CHALLENGE_TTL_MS);
      expect(await verifyLogin(SECRET, { ...(await signed()), consumeChallenge: () => false })).toEqual({ code: "challenge_used" });
    });

    it("is not asked about a bad challenge or a bad signature, so unsigned requests cannot spend a challenge", async () => {
      const good = await signed();
      const calls: string[] = [];
      const consumeChallenge = (nonce: string) => (calls.push(nonce), true);
      await verifyLogin(SECRET, { ...good, signature: "00", consumeChallenge });
      await verifyLogin(SECRET, { ...good, challenge: "1.00", consumeChallenge });
      await verifyLogin(SECRET, { ...good, origin: "https://evil.example", consumeChallenge });
      expect(calls).toEqual([]);
    });
  });
});

describe("login (browser)", () => {
  const wallet = XrplWallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb");
  const adapter = {
    capabilities: { signMessage: true },
    signMessage: async (message: string) => ({ signature: keypairSign(hex(message), wallet.privateKey), publicKey: wallet.publicKey }),
  };
  const server = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/auth/challenge")) return Response.json({ challenge: await createChallenge(SECRET, { app: APP, origin: ORIGIN }) });
    const body = JSON.parse(String(init?.body));
    const verified = await verifyLogin(SECRET, { app: APP, origin: ORIGIN, ...body });
    return "code" in verified ? Response.json({ code: verified.code, message: verified.code }, { status: 401 }) : Response.json(verified);
  };

  it("signs a message naming the origin and the name, which the server accepts", async () => {
    const signed: string[] = [];
    const spy = { ...adapter, signMessage: async (m: string) => (signed.push(m), adapter.signMessage(m)) };
    const result = await login(spy as never, { app: APP, origin: ORIGIN, name: "dave", fetch: server as never });
    expect(result).toEqual({ address: wallet.address });
    expect(signed[0]).toMatch(new RegExp(`^${APP} login\\nOrigin: ${ORIGIN}\\nName: dave\\nChallenge: `));
  });

  it("a page claiming another origin is refused", async () => {
    await expect(login(adapter as never, { app: APP, origin: "https://evil.example", fetch: server as never })).rejects.toMatchObject({ status: 401, code: "signature_invalid" });
  });
});
