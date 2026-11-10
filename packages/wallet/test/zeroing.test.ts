import { createHash, hkdfSync } from "node:crypto";
import * as keypairs from "ripple-keypairs";
import { describe, expect, it } from "vite-plus/test";
import { secp256k1 } from "xrp-dev/crypto";
import { Wallet, toSecretNumbers } from "../src/index.js";
import { copiesOf, recordAllocations } from "./allocations.js";

// The README and docs/layering.md say the key, the entropy and the PRF output are wiped as soon as they are used. These tests look
// for what a heap dump would: a live copy of a secret in any array the call allocated. Secrets come from oracles that share no code
// with the package (node:crypto, ripple-keypairs). `Wallet.fromSeed` is not here on purpose: `decodeSeed` in xrp-dev/address keeps
// the bytes it decoded, which the README says.

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => 0x31 + i * 7);
const ORACLE_ALGORITHM = { secp256k1: "ecdsa-secp256k1", ed25519: "ed25519" } as const;

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const sha512Half = (...parts: Uint8Array[]) => new Uint8Array(createHash("sha512").update(Buffer.concat(parts)).digest().subarray(0, 32));

/** Every buffer a derivation passes through, from the entropy to the private key. */
const derivationSecrets = (entropy: Uint8Array, algorithm: keyof typeof ORACLE_ALGORITHM): Record<string, Uint8Array> => {
  const privateKey = Buffer.from(keypairs.deriveKeypair(keypairs.generateSeed({ entropy, algorithm: ORACLE_ALGORITHM[algorithm] })).privateKey.slice(2), "hex");
  if (algorithm === "ed25519") return { entropy, privateKey };
  const root = sha512Half(entropy, u32(0));
  const tweak = sha512Half(secp256k1.getPublicKey(root), u32(0), u32(0));
  return { entropy, root, tweak, privateKey };
};

const expectNoCopies = (arrays: Uint8Array[], secrets: Record<string, Uint8Array>) => {
  for (const [name, secret] of Object.entries(secrets)) expect({ name, copies: copiesOf(arrays, secret) }).toEqual({ name, copies: 0 });
};

describe("key material does not outlive its use", () => {
  it.each(["secp256k1", "ed25519"] as const)("%s: after destroy() no copy of the entropy, an intermediate or the key is left", async (algorithm) => {
    const { arrays, error } = await recordAllocations(() => Wallet.fromEntropy(ENTROPY, { algorithm }).destroy());
    expect(error).toBeUndefined();
    expectNoCopies(arrays, derivationSecrets(ENTROPY, algorithm));
  });

  it.each(["secp256k1", "ed25519"] as const)("%s: Secret Numbers leave no copy of the entropy or the key", async (algorithm) => {
    const numbers = toSecretNumbers(ENTROPY);
    const { arrays, error } = await recordAllocations(() => Wallet.fromSecretNumbers(numbers, { algorithm }).destroy());
    expect(error).toBeUndefined();
    expectNoCopies(arrays, derivationSecrets(ENTROPY, algorithm));
  });

  it("a group that fails its checksum leaves none of the entropy decoded before it", async () => {
    const groups = toSecretNumbers(ENTROPY);
    const bad = [...groups.slice(0, 7), `${groups[7]!.slice(0, 5)}${(Number(groups[7]![5]) + 1) % 9}`];
    const { arrays, error } = await recordAllocations(() => Wallet.fromSecretNumbers(bad));
    expect(error).toMatchObject({ reason: "bad_checksum", position: 8 });
    expect(copiesOf(arrays, ENTROPY.slice(0, 8))).toBe(0);
  });

  // ed25519 only: noble's secp256k1 nonce generator keeps key-derived buffers while it signs, which no caller can wipe (README).
  it("a signature leaves no copy of the key (ed25519)", async () => {
    const { arrays, error } = await recordAllocations(() => {
      const wallet = Wallet.fromEntropy(ENTROPY, { algorithm: "ed25519" });
      wallet.sign({ TransactionType: "Payment", Account: wallet.address, Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", Amount: "1", Fee: "10", Sequence: 1 });
      wallet.signMessage(Uint8Array.of(1, 2, 3));
      wallet.destroy();
    });
    expect(error).toBeUndefined();
    expectNoCopies(arrays, derivationSecrets(ENTROPY, "ed25519"));
  });

  it("a wallet that is not destroyed holds exactly one copy of its key (so the checks above can fail)", async () => {
    const { arrays } = await recordAllocations(() => Wallet.fromEntropy(ENTROPY, { algorithm: "ed25519" }));
    expect(copiesOf(arrays, derivationSecrets(ENTROPY, "ed25519").privateKey!)).toBe(1);
  });

  it("fromPrf leaves no copy of the PRF output, the entropy or the key", async () => {
    const prf = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1);
    const entropy = new Uint8Array(hkdfSync("sha256", prf, "xrp-dev/prf/v1", "xrp-dev/prf/v1", 16));
    const { arrays, error } = await recordAllocations(async () => (await Wallet.fromPrf(prf)).destroy());
    expect(error).toBeUndefined();
    expectNoCopies(arrays, { prf, ...derivationSecrets(entropy, "secp256k1") });
  });
});
