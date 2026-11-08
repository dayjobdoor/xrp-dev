import { describe, expect, it } from "vite-plus/test";
import { decode, signerMatchesAccount, verifyTransaction, hashTransaction } from "xrp-dev/codec";
import { Wallet, WalletError, entropyFromPrf, entropyToSeed, toSecretNumbers } from "../src/index.js";

const SEED = "snoPBrXtMeMyMHUVTgbuqAfg1SUTb";
const GENESIS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const payment = (account: string) => ({ TransactionType: "Payment", Account: account, Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", Amount: "1", Fee: "10", Sequence: 1 });

const reasonOf = (f: () => unknown): unknown => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(WalletError);
    return (e as WalletError).reason;
  }
  throw new Error("did not throw");
};

describe("plain Wallet: synchronous, throws WalletError", () => {
  it("a seed gives the known address and a signed payment that verifies", () => {
    const wallet = Wallet.fromSeed(SEED);
    expect(wallet.address).toBe(GENESIS);
    const { tx_blob, hash } = wallet.sign(payment(wallet.address));
    expect(verifyTransaction(tx_blob)).toBe(true);
    expect(signerMatchesAccount(tx_blob)).toBe(true);
    expect(hashTransaction(tx_blob)).toBe(hash);
    expect(decode(tx_blob).SigningPubKey).toBe(wallet.publicKey);
  });

  it("entropy, seed and Secret Numbers lead to the same account", () => {
    const entropy = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    for (const algorithm of ["secp256k1", "ed25519"] as const) {
      const direct = Wallet.fromEntropy(entropy, { algorithm }).address;
      expect(Wallet.fromSeed(entropySeed(entropy, algorithm)).address).toBe(direct);
      expect(Wallet.fromSecretNumbers(toSecretNumbers(entropy), { algorithm }).address).toBe(direct);
    }
  });

  it("bad input throws WalletError with the reason", () => {
    expect(reasonOf(() => Wallet.fromSeed("not a seed"))).toBe("bad_seed");
    expect(reasonOf(() => Wallet.fromEntropy(new Uint8Array(15)))).toBe("bad_entropy");
    expect(reasonOf(() => Wallet.fromSecretNumbers("123456"))).toBe("bad_secret_numbers");
  });

  it("refuses to sign another account's transaction, a hash-prefixed message and, after destroy(), anything", () => {
    const wallet = Wallet.fromSeed(SEED);
    expect(reasonOf(() => wallet.sign(payment("rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe")))).toBe("bad_tx");
    expect(reasonOf(() => wallet.signMessage(new TextEncoder().encode("STX\0 and then data")))).toBe("bad_message");
    expect(wallet.signMessage(new TextEncoder().encode("hello"))).toMatch(/^[0-9A-F]+$/);
    wallet.destroy();
    expect(reasonOf(() => wallet.sign(payment(wallet.address)))).toBe("destroyed");
    expect(reasonOf(() => wallet.signMessage(new Uint8Array(1)))).toBe("destroyed");
  });

  it("refuses a transaction that would take the account away (SetRegularKey), with the reason `refused`", () => {
    const wallet = Wallet.fromSeed(SEED);
    expect(reasonOf(() => wallet.sign({ ...payment(wallet.address), TransactionType: "SetRegularKey" }))).toBe("refused");
    expect(reasonOf(() => wallet.sign({ ...payment(wallet.address), TransactionType: "AccountSet", SetFlag: 4 }))).toBe("refused");
  });

  it("multisign adds this wallet's entry to Signers, and a transaction that already has Signers is refused", () => {
    const wallet = Wallet.fromSeed(SEED);
    const { tx_blob } = wallet.sign({ ...payment("rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"), Fee: "20" }, { multisign: true });
    expect(verifyTransaction(tx_blob)).toBe(true);
    const signers = decode(tx_blob).Signers as { Signer: { Account: string } }[];
    expect(signers.map((s) => s.Signer.Account)).toEqual([wallet.address]);
    expect(reasonOf(() => wallet.sign(decode(tx_blob), { multisign: true }))).toBe("bad_tx");
  });

  it("does not show the key when logged or serialized", () => {
    const wallet = Wallet.fromSeed(SEED);
    expect(Object.keys(JSON.parse(JSON.stringify(wallet))).sort()).toEqual(["address", "publicKey"]);
    expect(String(wallet)).toBe(`Wallet(${GENESIS})`);
  });
});

describe("plain Wallet: the passkey path is the only asynchronous one", () => {
  const prf = Uint8Array.from({ length: 32 }, (_, i) => i * 7);

  it("fromPrf resolves to a wallet, and entropyFromPrf to the 16 bytes it was made from", async () => {
    const wallet = await Wallet.fromPrf(prf);
    const entropy = await entropyFromPrf(prf);
    expect(entropy).toHaveLength(16);
    expect(Wallet.fromEntropy(entropy).address).toBe(wallet.address);
    expect((await Wallet.fromPrf(prf, { algorithm: "ed25519" })).address).not.toBe(wallet.address);
  });

  it("a short PRF output rejects with bad_prf", async () => {
    const e = await Wallet.fromPrf(new Uint8Array(31)).then(() => undefined, (x: unknown) => x as WalletError);
    expect(e).toBeInstanceOf(WalletError);
    expect(e?.reason).toBe("bad_prf");
  });
});

const entropySeed = (entropy: Uint8Array, algorithm: "secp256k1" | "ed25519") => entropyToSeed(entropy, algorithm);
