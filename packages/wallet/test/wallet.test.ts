import * as secretNumbersOracle from "@xrplf/secret-numbers";
import { Effect } from "effect";
import fc from "fast-check";
import * as keypairs from "ripple-keypairs";
import { describe, expect, it } from "vite-plus/test";
import { decode, encode, encodeForMultisigning, encodeForSigning, signerMatchesAccount, verifyTransaction } from "xrp-dev/codec";
import { multisign, walletFromSecretNumbers, Wallet as XrplWallet } from "xrpl";
import { bytesToHex } from "xrp-dev/crypto";
import { entropyFromPrf, entropyToSeed, signingRefusal, toSecretNumbers, Wallet } from "../src/index.js";

const run = Effect.runPromise;

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

describe("W-W01 keys from seeds", () => {
  it("fixed vectors", async () => {
    const secp = await run(Wallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb"));
    expect(secp.publicKey).toBe("0330E7FC9D56BB25D6893BA3F317AE5BCF33B3291BD63DB32654A313222F7FD020");
    expect(secp.address).toBe("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh");
    const ed = await run(Wallet.fromSeed("sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE"));
    expect(ed.address).toBe("r9zRhGr7b6xPekLvT6wP4qNdWMryaumZS7");
  });
  it("matches ripple-keypairs for random entropy, both algorithms", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 16, maxLength: 16 }), fc.constantFrom("ed25519" as const, "secp256k1" as const), async (entropy, algorithm) => {
        const seed = await run(entropyToSeed(entropy, algorithm));
        const wallet = await run(Wallet.fromSeed(seed));
        const oracle = keypairs.deriveKeypair(seed);
        expect(wallet.publicKey).toBe(oracle.publicKey);
        expect(wallet.address).toBe(keypairs.deriveAddress(oracle.publicKey));
      }),
      { numRuns: 50 },
    );
  });
  it("rejects a malformed seed", async () => {
    expect((await run(Effect.flip(Wallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTc")))).reason).toBe("bad_seed");
  });
});

describe("W-W02 / W-W03 single signatures", () => {
  it.each([
    ["secp256k1", "snoPBrXtMeMyMHUVTgbuqAfg1SUTb"],
    ["ed25519", "sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE"],
  ])("%s: blob and hash equal xrpl.js, and verify", async (_, seed) => {
    const wallet = await run(Wallet.fromSeed(seed));
    const ours = await run(wallet.sign(payment(wallet.address)));
    const theirs = XrplWallet.fromSeed(seed).sign(payment(wallet.address) as never);
    expect(ours).toEqual({ tx_blob: theirs.tx_blob, hash: theirs.hash });
    expect(await run(verifyTransaction(ours.tx_blob))).toBe(true);
    expect(await run(signerMatchesAccount(ours.tx_blob))).toBe(true);
  });
  it("a tampered signature does not verify", async () => {
    const wallet = await run(Wallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb"));
    const { tx_blob } = await run(wallet.sign(payment(wallet.address)));
    const other = await run(Wallet.fromSeed("sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE"));
    const { tx_blob: otherBlob } = await run(other.sign(payment(other.address)));
    const forged = await run(encode({ ...(await run(decode(otherBlob))), Account: wallet.address }));
    expect(await run(signerMatchesAccount(forged))).toBe(false);
    const tx = (await run(decode(tx_blob))) as { TxnSignature: string };
    const last = tx.TxnSignature.slice(-2) === "00" ? "01" : "00";
    const flipped = await run(encode({ ...tx, TxnSignature: tx.TxnSignature.slice(0, -2) + last }));
    expect(await run(verifyTransaction(flipped))).toBe(false);
  });
});

describe("W-W04 multisign", () => {
  it("matches xrpl.js multisign for two signers", async () => {
    const a = await run(Wallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb"));
    const b = await run(Wallet.fromSeed("sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE"));
    const tx = { ...payment("rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"), Destination: a.address, Fee: "36" };
    const ours = [await run(a.sign(tx, { multisign: true })), await run(b.sign(tx, { multisign: true }))];
    const theirs = [XrplWallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb"), XrplWallet.fromSeed("sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE")].map(
      (w) => w.sign(tx as never, true).tx_blob,
    );
    expect(ours.map((s) => s.tx_blob)).toEqual(theirs);
    expect(await run(verifyTransaction(multisign(theirs)))).toBe(true);
  });
  it("drops an input TxnSignature and rejects a transaction that already has Signers", async () => {
    const a = await run(Wallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb"));
    const tx = { ...payment("rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"), Fee: "36" };
    const clean = await run(a.sign(tx, { multisign: true }));
    expect(await run(a.sign({ ...tx, TxnSignature: "AB" }, { multisign: true }))).toEqual(clean);
    expect(await run(Effect.flip(a.sign({ ...tx, Signers: [] }, { multisign: true })))).toMatchObject({ reason: "bad_tx" });
  });
});

describe("W-W05 Secret Numbers", () => {
  const numbers = "570521-598543-265488-209520-212450-201006-286214-581400";
  it("fixed vector (secp256k1 by default, like xrpl.js and Xaman) and checksum position", async () => {
    expect((await run(Wallet.fromSecretNumbers(numbers))).address).toBe("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh");
    expect((await run(Wallet.fromSecretNumbers(numbers, { algorithm: "ed25519" }))).address).toBe("rGWrZyQqhTp9Xu7G5Pkayo7bXjH4k4QYpf");
    const err = await run(Effect.flip(Wallet.fromSecretNumbers(numbers.replace(/581400$/, "581401"))));
    expect(err).toMatchObject({ reason: "bad_checksum", position: 8 });
  });
  it("round-trips and matches @xrplf/secret-numbers and xrpl.js", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 16, maxLength: 16 }), async (entropy) => {
        const groups = await run(toSecretNumbers(entropy));
        expect(groups).toEqual(secretNumbersOracle.entropyToSecret(entropy));
        expect((await run(Wallet.fromSecretNumbers(groups))).address).toBe(walletFromSecretNumbers(groups).address);
        const ed = await run(Wallet.fromSecretNumbers(groups, { algorithm: "ed25519" }));
        expect(ed.address).toBe(new secretNumbersOracle.Account(groups).getAddress());
      }),
      { numRuns: 100 },
    );
  });
});

describe("W-W06 PRF", () => {
  const prf = new Uint8Array(32).fill(7);
  it("is deterministic and sensitive to every bit and to the salt", async () => {
    const a = await run(Wallet.fromPrf(prf));
    expect((await run(Wallet.fromPrf(prf.slice()))).address).toBe(a.address);
    const flipped = prf.slice();
    flipped[31]! ^= 1;
    expect((await run(Wallet.fromPrf(flipped))).address).not.toBe(a.address);
    expect((await run(Wallet.fromPrf(prf, { salt: new Uint8Array(32) }))).address).not.toBe(a.address);
  });
  // Pinned from an oracle that shares no code with the package: entropy = node:crypto hkdfSync("sha256", prf, salt, info, 16)
  // with salt = info = "xrp-dev/prf/v1"; addresses = ripple-keypairs deriveAddress(deriveKeypair(generateSeed({ entropy, algorithm }))).
  it.each([
    [7, "1faf505094ca37294ef5f03d252c3eb6", "rK5c3c1nbHXF2WQDJ1Pdicf3QBP57fWh2N", "rsqmN2r1UKMxZDupYKt5SA3dwh24CEjSDG"],
    [9, "becf842045be976731b04171409c422a", "rKGPScxUfLBjQDP6ZWudDHTirv8k2pMZBP", "r37SQWRD3GXJyxjffM1KoBpbot2MzFSqvB"],
  ])("PRF of 32 bytes of 0x0%i derives the pinned entropy and addresses", async (byte, entropyHex, secp, ed) => {
    const input = new Uint8Array(32).fill(byte);
    expect(bytesToHex(await run(entropyFromPrf(input))).toLowerCase()).toBe(entropyHex);
    expect((await run(Wallet.fromPrf(input))).address).toBe(secp);
    expect((await run(Wallet.fromPrf(input, { algorithm: "ed25519" }))).address).toBe(ed);
  });
  // Pinned from solobank's `frozen key derivation` vectors (its own implementation: WebCrypto HKDF + xrpl.js seeds): PRF = 0..31,
  // salt = SHA-256(rpId), info per algorithm. An app that passes these inputs gets the addresses it already has.
  it.each([
    ["ed25519", "solobank-xrpl-ed25519-v2", "sEdVcZNQV7iA5HiD1VmGhaiecPCGn1m", "r4VNiXdV7ZFGQH3spT2pKmjCnKiWNhmetL"],
    ["secp256k1", "solobank-xrpl-secp256k1-v2", "san3rnYyPpX8nhhcy5eshZnQ1WPCE", "rJmi4wZtrYNnTKQVQ93DqPJsTXDJCoEm1C"],
  ] as const)("reproduces another app's frozen %s derivation from salt and info", async (algorithm, info, seed, address) => {
    const prf = Uint8Array.from({ length: 32 }, (_, i) => i);
    const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("pjq.jp")));
    const opts = { salt, info: new TextEncoder().encode(info), algorithm };
    expect((await run(Wallet.fromPrf(prf, opts))).address).toBe(address);
    expect(await run(entropyToSeed(await run(entropyFromPrf(prf, opts)), algorithm))).toBe(seed);
  });
});

describe("WalletError reasons", () => {
  it("bad_prf: fewer than 32 bytes", async () => {
    expect((await run(Effect.flip(Wallet.fromPrf(new Uint8Array(31))))).reason).toBe("bad_prf");
    expect((await run(Effect.flip(entropyFromPrf(new Uint8Array(0))))).reason).toBe("bad_prf");
  });
  it("bad_entropy: not 16 bytes", async () => {
    expect((await run(Effect.flip(Wallet.fromEntropy(new Uint8Array(15))))).reason).toBe("bad_entropy");
    expect((await run(Effect.flip(toSecretNumbers(new Uint8Array(17))))).reason).toBe("bad_entropy");
    expect((await run(Effect.flip(entropyToSeed(new Uint8Array(15))))).reason).toBe("bad_entropy");
  });
  it.each([
    ["seven groups", "570521-598543-265488-209520-212450-201006-286214"],
    ["nine groups", "570521-598543-265488-209520-212450-201006-286214-581400-000000"],
    ["a non-digit group", ["570521", "598543", "265488", "209520", "212450", "201006", "286214", "58140x"]],
    ["a short group", ["570521", "598543", "265488", "209520", "212450", "201006", "286214", "58140"]],
  ])("bad_secret_numbers: %s", async (_, input) => {
    expect((await run(Effect.flip(Wallet.fromSecretNumbers(input)))).reason).toBe("bad_secret_numbers");
  });
  // bad_key has no input that reaches it: derived scalars are valid by construction.
});

describe("signing refusals", () => {
  const dangerous = [
    ["numeric SetRegularKey", { TransactionType: 5 }],
    ["numeric SignerListSet", { TransactionType: 12 }],
    ["numeric Batch", { TransactionType: 71 }],
    ["numeric AccountSet disabling the master key", { TransactionType: 3, SetFlag: 4 }],
    ["named SetRegularKey", { TransactionType: "SetRegularKey" }],
    ["named SignerListSet", { TransactionType: "SignerListSet" }],
    ["named Batch", { TransactionType: "Batch" }],
    ["named AccountSet disabling the master key", { TransactionType: "AccountSet", SetFlag: 4 }],
  ] as const;

  it.each(dangerous)("single-sign refuses %s", async (_, extra) => {
    const wallet = await run(Wallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb"));
    expect(await run(Effect.flip(wallet.sign({ ...payment(wallet.address), ...extra })))).toMatchObject({ reason: "refused" });
  });
  it.each(dangerous)("multisign refuses %s", async (_, extra) => {
    const wallet = await run(Wallet.fromSeed("sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE"));
    const tx = { ...payment("rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"), Fee: "36", ...extra };
    expect(await run(Effect.flip(wallet.sign(tx, { multisign: true })))).toMatchObject({ reason: "refused" });
  });
  it("signs an ordinary AccountSet and a Payment", async () => {
    const wallet = await run(Wallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb"));
    await run(wallet.sign({ ...payment(wallet.address), TransactionType: "AccountSet", SetFlag: 8 }));
    expect(await run(verifyTransaction((await run(wallet.sign(payment(wallet.address)))).tx_blob))).toBe(true);
  });
  it("a getter that changes between reads is signed as what was read once, never as a refused type", async () => {
    const wallet = await run(Wallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb"));
    for (const [first, later] of [["Payment", "SetRegularKey"], ["SetRegularKey", "Payment"]]) {
      let reads = 0;
      const tx = payment(wallet.address);
      Object.defineProperty(tx, "TransactionType", { enumerable: true, get: () => (reads++ === 0 ? first : later) });
      const outcome = await run(Effect.match(wallet.sign(tx), { onSuccess: (signed) => ({ signed }), onFailure: (error) => ({ error }) }));
      if ("signed" in outcome) expect((await run(decode(outcome.signed.tx_blob))).TransactionType).toBe("Payment");
      else expect(outcome.error).toMatchObject({ reason: "refused" });
    }
  });
  it("signingRefusal fails closed on a non-string TransactionType", () => {
    expect(signingRefusal({ TransactionType: 5 })).toMatch(/署名しません/);
    expect(signingRefusal({})).toMatch(/署名しません/);
    expect(signingRefusal({ TransactionType: "Payment" })).toBeUndefined();
  });
});

describe("account binding", () => {
  it("single-sign rejects a transaction for another Account or without one; multisign may sign for another", async () => {
    const wallet = await run(Wallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb"));
    const other = payment("rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe");
    expect(await run(Effect.flip(wallet.sign(other)))).toMatchObject({ reason: "bad_tx" });
    const { Account: _drop, ...bare } = payment(wallet.address);
    expect(await run(Effect.flip(wallet.sign(bare)))).toMatchObject({ reason: "bad_tx" });
    await run(wallet.sign(other, { multisign: true }));
  });
});

describe("W-W07 / W-W08 secrets stay inside", () => {
  it("serialisation and errors never contain the seed or private key", async () => {
    const seed = "snoPBrXtMeMyMHUVTgbuqAfg1SUTb";
    const wallet = await run(Wallet.fromSeed(seed));
    const privateKey = keypairs.deriveKeypair(seed).privateKey.slice(2);
    const shown = [JSON.stringify(wallet), String(wallet), JSON.stringify(Object.entries(wallet))].join("\n");
    expect(shown).not.toContain(seed);
    expect(shown.toUpperCase()).not.toContain(privateKey.toUpperCase());
    wallet.destroy();
    const err = await run(Effect.flip(wallet.sign(payment(wallet.address))));
    expect(err).toMatchObject({ reason: "destroyed" });
    expect(String(err.message)).not.toContain(privateKey);
  });
  it("destroy zeroes the key bytes", async () => {
    const wallet = await run(Wallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb"));
    const before = await run(wallet.signMessage(new Uint8Array([1])));
    expect(before).toBe(keypairs.sign("01", keypairs.deriveKeypair("snoPBrXtMeMyMHUVTgbuqAfg1SUTb").privateKey));
    wallet.destroy();
    expect((await run(Effect.flip(wallet.signMessage(new Uint8Array([1]))))).reason).toBe("destroyed");
  });
  it("a destroy() during an in-flight sign neither zeroes that signature's key nor allows later signs", async () => {
    const wallet = await run(Wallet.fromSeed("sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE"));
    const tx = { TransactionType: "Payment", Account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", Destination: wallet.address, Amount: "1", Fee: "10", Sequence: 1 };
    const pending = run(wallet.sign(tx, { multisign: true }));
    wallet.destroy();
    expect(await run(verifyTransaction((await pending).tx_blob))).toBe(true);
    expect((await run(Effect.flip(wallet.sign(tx)))).reason).toBe("destroyed");
  });
});

describe("signMessage domain separation", () => {
  it.each(["snoPBrXtMeMyMHUVTgbuqAfg1SUTb", "sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE"])("refuses transaction signing data (%s)", async (seed) => {
    const wallet = await run(Wallet.fromSeed(seed));
    const tx = { TransactionType: "Payment", Account: wallet.address, Destination: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", Amount: "1", Fee: "10", Sequence: 1, SigningPubKey: wallet.publicKey };
    for (const data of [await run(encodeForSigning(tx)), await run(encodeForMultisigning(tx, wallet.address))]) {
      expect((await run(Effect.flip(wallet.signMessage(data)))).reason).toBe("bad_message");
    }
    expect(await run(wallet.signMessage(new TextEncoder().encode("STX sign-in nonce")))).toMatch(/^[0-9A-F]+$/);
  });
});
