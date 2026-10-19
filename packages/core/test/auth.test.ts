import { Effect } from "effect";
import { sign as keypairSign } from "ripple-keypairs";
import { describe, expect, it } from "vite-plus/test";
import { Wallet as XrplWallet } from "xrpl";
import {
  CHALLENGE_TTL_MS,
  createChallenge,
  isFreshChallenge,
  loginMessage,
  loginProofTx,
  verifyLogin,
  verifyMessage,
  verifyProofTx,
} from "../src/auth.js";

const run = Effect.runPromise;
const SECRET = "test-secret";
const APP = "TEST APP";
const hex = (text: string) => Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("");

describe("challenge", () => {
  const now = 1_700_000_000_000;

  it("a fresh challenge passes; 5 min + 1 ms later it does not", async () => {
    const c = await createChallenge(SECRET, { app: APP, now });
    expect(await isFreshChallenge(SECRET, c, { app: APP, now: now + CHALLENGE_TTL_MS })).toBe(true);
    expect(await isFreshChallenge(SECRET, c, { app: APP, now: now + CHALLENGE_TTL_MS + 1 })).toBe(false);
  });

  it("rejects a tampered MAC, another app, another secret, and a challenge from the future", async () => {
    const c = await createChallenge(SECRET, { app: APP, now });
    const [issuedAt, mac] = c.split(".");
    const flipped = `${issuedAt}.${mac!.slice(0, -1)}${mac!.endsWith("0") ? "1" : "0"}`;
    expect(await isFreshChallenge(SECRET, flipped, { app: APP, now })).toBe(false);
    expect(await isFreshChallenge(SECRET, c, { app: "OTHER APP", now })).toBe(false);
    expect(await isFreshChallenge("other-secret", c, { app: APP, now })).toBe(false);
    expect(await isFreshChallenge(SECRET, c, { app: APP, now: now - 1 })).toBe(false);
  });
});

describe("verifyMessage", () => {
  const seeds = { secp256k1: "snoPBrXtMeMyMHUVTgbuqAfg1SUTb", ed25519: "sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE" };

  for (const [algorithm, seed] of Object.entries(seeds)) {
    it(`${algorithm}: returns the address, and undefined for a flipped byte`, async () => {
      const wallet = XrplWallet.fromSeed(seed);
      const message = loginMessage(APP, "1.abc");
      const signature = keypairSign(hex(message), wallet.privateKey);
      expect(await run(verifyMessage({ message, signature, publicKey: wallet.publicKey }))).toBe(wallet.address);
      const flipped = `${signature.slice(0, 10)}${signature[10] === "0" ? "1" : "0"}${signature.slice(11)}`;
      expect(await run(verifyMessage({ message, signature: flipped, publicKey: wallet.publicKey }))).toBeUndefined();
      expect(await run(verifyMessage({ message: `${message}x`, signature, publicKey: wallet.publicKey }))).toBeUndefined();
    });
  }
});

describe("loginProofTx", () => {
  // xrpl-connect's XamanAdapter.sign() throws below 32570 and sends `multisign: true` for an empty SigningPubKey
  it("meets Xaman's sign() contract: absolute LastLedgerSequence, no empty SigningPubKey", () => {
    const tx = loginProofTx({ app: APP, challenge: "1.abc", account: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY" });
    expect(tx.LastLedgerSequence).toBeGreaterThanOrEqual(32570);
    expect(tx.LastLedgerSequence).toBeLessThanOrEqual(4294967295);
    expect(tx.SigningPubKey).not.toBe("");
  });
});

describe("verifyProofTx", () => {
  const wallet = XrplWallet.fromSeed("sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE");
  const proof = (challenge: string, over: Record<string, unknown> = {}) => ({ ...loginProofTx({ app: APP, challenge, account: wallet.address }), ...over });

  it("returns the address of a master-key signature over the proof", async () => {
    const { tx_blob } = wallet.sign(proof("1.abc") as never);
    expect(await run(verifyProofTx(tx_blob, { app: APP, challenge: "1.abc" }))).toBe(wallet.address);
  });

  it("refuses another challenge, another app, Sequence 1, and a nonzero Fee", async () => {
    const { tx_blob } = wallet.sign(proof("1.abc") as never);
    expect(await run(verifyProofTx(tx_blob, { app: APP, challenge: "1.xyz" }))).toBeUndefined();
    expect(await run(verifyProofTx(tx_blob, { app: "OTHER", challenge: "1.abc" }))).toBeUndefined();
    expect(await run(verifyProofTx(wallet.sign(proof("1.abc", { Sequence: 1 }) as never).tx_blob, { app: APP, challenge: "1.abc" }))).toBeUndefined();
    expect(await run(verifyProofTx(wallet.sign(proof("1.abc", { Fee: "10" }) as never).tx_blob, { app: APP, challenge: "1.abc" }))).toBeUndefined();
  });

  it("refuses a blob signed by a regular key", async () => {
    const regular = XrplWallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb");
    const { tx_blob } = new XrplWallet(regular.publicKey, regular.privateKey, { masterAddress: wallet.address }).sign(proof("1.abc") as never);
    expect(await run(verifyProofTx(tx_blob, { app: APP, challenge: "1.abc" }))).toBeUndefined();
  });

  it("refuses garbage", async () => {
    expect(await run(verifyProofTx("zz", { app: APP, challenge: "1.abc" }))).toBeUndefined();
  });
});

describe("verifyLogin", () => {
  const wallet = XrplWallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb");

  it("maps each failure to its code", async () => {
    const challenge = await createChallenge(SECRET, { app: APP });
    const signature = keypairSign(hex(loginMessage(APP, challenge)), wallet.privateKey);
    expect(await verifyLogin(SECRET, { app: APP, challenge, signature, publicKey: wallet.publicKey })).toEqual({ address: wallet.address });
    expect(await verifyLogin(SECRET, { app: APP, challenge })).toEqual({ code: "invalid_request" });
    expect(await verifyLogin(SECRET, { app: APP, challenge: "1.00", signature, publicKey: wallet.publicKey })).toEqual({ code: "challenge_invalid" });
    expect(await verifyLogin(SECRET, { app: APP, challenge, signature: "00", publicKey: wallet.publicKey })).toEqual({ code: "signature_invalid" });
  });

  it("accepts a proof transaction", async () => {
    const challenge = await createChallenge(SECRET, { app: APP });
    const { tx_blob } = wallet.sign(loginProofTx({ app: APP, challenge, account: wallet.address }) as never);
    expect(await verifyLogin(SECRET, { app: APP, challenge, proof: tx_blob })).toEqual({ address: wallet.address });
  });
});
