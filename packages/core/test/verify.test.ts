import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { ECDSA, Wallet as XrplWallet, multisign } from "xrpl";
import { publicKeyToAddress } from "../src/address.js";
import { decode, encode, signerMatchesAccount, verifyTransaction, type TxJson } from "../src/codec.js";

const run = Effect.runPromise;
const tx = (account: string) => ({ TransactionType: "Payment", Account: account, Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", Amount: "1", Fee: "12", Sequence: 7, Flags: 0 });

describe("verifyTransaction / signerMatchesAccount", () => {
  const [a, b] = ["snoPBrXtMeMyMHUVTgbuqAfg1SUTb", "sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE"].map((s) => XrplWallet.fromSeed(s));

  it("single-signed blobs verify and match their account", async () => {
    const { tx_blob } = a!.sign(tx(a!.address) as never);
    expect(await run(verifyTransaction(tx_blob))).toBe(true);
    expect(await run(signerMatchesAccount(tx_blob))).toBe(true);
    expect(await run(signerMatchesAccount(b!.sign(tx(a!.address) as never).tx_blob))).toBe(false);
  });

  it("multisigned: ascending Signers verify; reversed or duplicated do not", async () => {
    const t = tx("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh");
    const blob = multisign([a!, b!].map((w) => w.sign(t as never, true).tx_blob));
    expect(await run(verifyTransaction(blob))).toBe(true);
    const json = (await run(decode(blob))) as TxJson & { Signers: unknown[] };
    const reversed = await run(encode({ ...json, Signers: [...json.Signers].reverse() }));
    const duplicated = await run(encode({ ...json, Signers: [json.Signers[0], json.Signers[0]] }));
    expect(await run(verifyTransaction(reversed))).toBe(false);
    expect(await run(verifyTransaction(duplicated))).toBe(false);
  });

  describe("is false once the blob is tampered with or malformed", () => {
    const single = async () => (await run(decode(a!.sign(tx(a!.address) as never).tx_blob))) as TxJson;
    const multi = async () => {
      const t = tx("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh");
      return (await run(decode(multisign([a!, b!].map((w) => w.sign(t as never, true).tx_blob))))) as TxJson & { Signers: { Signer: Record<string, unknown> }[] };
    };

    it.each<[string, (j: TxJson) => TxJson]>([
      ["Amount", (j) => ({ ...j, Amount: "2" })],
      ["Destination", (j) => ({ ...j, Destination: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" })],
      ["Fee", (j) => ({ ...j, Fee: "13" })],
      ["Sequence", (j) => ({ ...j, Sequence: 8 })],
      ["a Memo", (j) => ({ ...j, Memos: [{ Memo: { MemoData: "AB" } }] })],
      ["no signature at all", (j) => ({ ...j, SigningPubKey: "", TxnSignature: undefined })],
      ["an empty Signers list", (j) => ({ ...j, SigningPubKey: "", TxnSignature: undefined, Signers: [] })],
      ["SigningPubKey together with Signers", (j) => ({ ...j, Signers: [{ Signer: { Account: b!.address, SigningPubKey: b!.publicKey, TxnSignature: j.TxnSignature } }] })],
      ["an ed25519 key with a secp256k1 signature", (j) => ({ ...j, SigningPubKey: b!.publicKey })],
    ])("single-signed: %s", async (_, mutate) => {
      expect(await run(verifyTransaction(await run(encode(mutate(await single())))))).toBe(false);
    });

    it("multisigned: TxnSignature together with Signers", async () => {
      expect(await run(verifyTransaction(await run(encode({ ...(await multi()), TxnSignature: "AB" }))))).toBe(false);
    });

    it("multisigned: a signer key that is not 33 bytes", async () => {
      const j = await multi();
      j.Signers[0]!.Signer.SigningPubKey = String(j.Signers[0]!.Signer.SigningPubKey).slice(2);
      expect(await run(verifyTransaction(await run(encode(j))))).toBe(false);
    });
  });

  it("multisigned: 32 valid Signers verify, 33 do not (rippled's limit)", async () => {
    const t = tx("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh");
    const wallets = Array.from({ length: 33 }, (_, i) => XrplWallet.fromEntropy(new Uint8Array(16).fill(i + 1), { algorithm: ECDSA.ed25519 }));
    const blobs = wallets.map((w) => w.sign(t as never, true).tx_blob);
    expect(await run(verifyTransaction(multisign(blobs.slice(0, 32))))).toBe(true);
    expect(await run(verifyTransaction(multisign(blobs)))).toBe(false);
  });
});

describe("publicKeyToAddress", () => {
  it("derives addresses for valid keys", async () => {
    const [a, b] = ["snoPBrXtMeMyMHUVTgbuqAfg1SUTb", "sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE"].map((s) => XrplWallet.fromSeed(s));
    expect(await run(publicKeyToAddress(a!.publicKey))).toBe(a!.address);
    expect(await run(publicKeyToAddress(b!.publicKey))).toBe(b!.address);
  });

  it.each([`04${"11".repeat(32)}`, "00".repeat(33), "11".repeat(32), `02${"00".repeat(32)}`, "zz", `ED${"FF".repeat(32)}`])("rejects %s", async (key) => {
    await expect(run(publicKeyToAddress(key))).rejects.toBeDefined();
  });
});
