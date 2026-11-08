import { AddressError, decodeSeed, deriveAccountId, encodeAccountId, encodeSeed, type Algorithm } from "xrp-dev/address";
import { decode, encode, encodeForMultisigning, encodeForSigning, hashTransaction, type Definitions, type TxJson } from "xrp-dev/codec";
import { bytesToHex, concatBytes, CryptoError, ed25519, secp256k1, sha512Half } from "xrp-dev/crypto";
import { WalletError } from "./errors.js";
import { fromSecretNumbers } from "./secretNumbers.js";
import { prfSalt } from "./prf.js";

// Plain functions: values come back, failures throw `WalletError` (`sign` also `CodecError`). Every copy of key material
// this file makes is zeroed in a `finally`, however the call ends. `xrp-dev/effect/wallet` is the same code as Effects.

export { WalletError } from "./errors.js";
export { toSecretNumbers } from "./secretNumbers.js";
export type { Algorithm };

const ED_PREFIX = 0xed;

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

// A failure inside the crypto or address code is a bad key to the caller; anything else is a bug and propagates.
const keyed = <T>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    if (e instanceof CryptoError || e instanceof AddressError) throw new WalletError({ reason: "bad_key", message: e.message, cause: e });
    throw e;
  }
};

/** ripple-keypairs' scalar search: sha512Half(bytes ‖ [discrim] ‖ i) until 0 < k < n. */
const deriveScalar = (bytes: Uint8Array, discrim?: number): Uint8Array => {
  for (let i = 0; i <= 0xffffffff; i++) {
    const input = concatBytes(bytes, ...(discrim === undefined ? [] : [u32(discrim)]), u32(i));
    try {
      const k = sha512Half(input);
      if (secp256k1.isValidPrivateKey(k)) return k;
    } finally {
      input.fill(0);
    }
  }
  throw new Error("no valid scalar");
};

const deriveKeys = (entropy: Uint8Array, algorithm: Algorithm): { privateKey: Uint8Array; publicKey: Uint8Array } => {
  if (algorithm === "ed25519") {
    const privateKey = sha512Half(entropy);
    const publicKey = concatBytes(Uint8Array.of(ED_PREFIX), keyed(() => ed25519.getPublicKey(privateKey)));
    return { privateKey, publicKey };
  }
  const root = deriveScalar(entropy);
  try {
    const rootPublic = keyed(() => secp256k1.getPublicKey(root));
    const tweak = deriveScalar(rootPublic, 0);
    const privateKey = secp256k1.addScalars(root, tweak);
    tweak.fill(0);
    return { privateKey, publicKey: keyed(() => secp256k1.getPublicKey(privateKey)) };
  } finally {
    root.fill(0);
  }
};

/** Signs the bytes XRPL expects: secp256k1 over sha512Half(data), ed25519 over data itself. */
const signBytes = (data: Uint8Array, privateKey: Uint8Array, algorithm: Algorithm): Uint8Array =>
  keyed(() => (algorithm === "ed25519" ? ed25519.sign(data, privateKey) : secp256k1.sign(sha512Half(data), privateKey)));

// rippled hash prefixes (STX\0, SMT\0, CLM\0, TXN\0, …) are three upper-case letters and a zero byte.
const hasHashPrefix = (m: Uint8Array) => m.length >= 4 && m[3] === 0 && [0, 1, 2].every((i) => m[i]! >= 0x41 && m[i]! <= 0x5a);

/**
 * WebAuthn PRF output (32 bytes) → HKDF-SHA256 → 16 bytes of entropy. `salt` and `info` default to "xrp-dev/prf/v1";
 * pass both to reproduce another app's frozen derivation (e.g. salt = SHA-256(rpId), info = a per-algorithm label).
 * Exposed so an app can show the Secret Numbers backup for a passkey-derived account. Asynchronous: HKDF is WebCrypto.
 * Rejects with `WalletError` (`bad_prf`) for a shorter PRF output.
 */
export const entropyFromPrf = async (prf: Uint8Array, opts: { salt?: Uint8Array; info?: Uint8Array } = {}): Promise<Uint8Array> => {
  if (prf.length < 32) throw new WalletError({ reason: "bad_prf", message: "PRF output must be at least 32 bytes" });
  const copy = new Uint8Array(prf);
  try {
    const key = await crypto.subtle.importKey("raw", copy, "HKDF", false, ["deriveBits"]);
    const params = { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(opts.salt ?? prfSalt()), info: new Uint8Array(opts.info ?? prfSalt()) };
    return new Uint8Array(await crypto.subtle.deriveBits(params, key, 128));
  } finally {
    copy.fill(0);
  }
};

/** Wipes entropy the package itself produced (seed decode, Secret Numbers, HKDF). Never used on a caller's `fromEntropy` buffer. */
const fromOwnedEntropy = (entropy: Uint8Array, opts: { algorithm?: Algorithm }): Wallet => {
  try {
    return Wallet.fromEntropy(entropy, opts);
  } finally {
    entropy.fill(0);
  }
};

/** Encodes and decodes `tx` so the check sees what the signature will cover: the codec accepts numeric TransactionType codes, and decoding yields canonical names. */
const refuseDangerous = (tx: TxJson, defs?: Definitions): TxJson => {
  const decoded = decode(encode(tx, defs), defs);
  const refusal = signingRefusal(decoded);
  if (refusal) throw new WalletError({ reason: "refused", message: refusal });
  return decoded;
};

export class Wallet {
  readonly address: string;
  readonly publicKey: string;
  readonly algorithm: Algorithm;
  #privateKey: Uint8Array;
  #destroyed = false;

  private constructor(address: string, publicKey: Uint8Array, privateKey: Uint8Array, algorithm: Algorithm) {
    this.address = address;
    this.publicKey = bytesToHex(publicKey);
    this.algorithm = algorithm;
    this.#privateKey = privateKey;
  }

  /** 16 bytes of entropy. The buffer is the caller's and is not wiped. */
  static fromEntropy(entropy: Uint8Array, opts: { algorithm?: Algorithm } = {}): Wallet {
    const algorithm = opts.algorithm ?? "secp256k1";
    if (entropy.length !== 16) throw new WalletError({ reason: "bad_entropy", message: "entropy must be 16 bytes" });
    const { privateKey, publicKey } = deriveKeys(entropy, algorithm);
    const address = keyed(() => encodeAccountId(deriveAccountId(publicKey)));
    return new Wallet(address, publicKey, privateKey, algorithm);
  }

  static fromSeed(seed: string): Wallet {
    let decoded: { entropy: Uint8Array; algorithm: Algorithm };
    try {
      decoded = decodeSeed(seed);
    } catch (e) {
      if (e instanceof AddressError) throw new WalletError({ reason: "bad_seed", message: "not a valid XRPL seed", cause: e });
      throw e;
    }
    return fromOwnedEntropy(decoded.entropy, { algorithm: decoded.algorithm });
  }

  static fromSecretNumbers(input: string | readonly string[], opts: { algorithm?: Algorithm } = {}): Wallet {
    return fromOwnedEntropy(fromSecretNumbers(input), opts);
  }

  /** WebAuthn PRF output (32 bytes) → HKDF-SHA256 (`salt` and `info` default to "xrp-dev/prf/v1") → 16 bytes of entropy → wallet. Asynchronous: HKDF is WebCrypto. */
  static async fromPrf(prf: Uint8Array, opts: { salt?: Uint8Array; info?: Uint8Array; algorithm?: Algorithm } = {}): Promise<Wallet> {
    return fromOwnedEntropy(await entropyFromPrf(prf, opts), opts.algorithm ? { algorithm: opts.algorithm } : {});
  }

  /** A copy of the key, zeroed after `use`, so `destroy()` during an in-flight sign cannot swap in a zeroed key. */
  #withKey<A>(use: (key: Uint8Array) => A): A {
    if (this.#destroyed) throw new WalletError({ reason: "destroyed", message: "wallet was destroyed" });
    const key = this.#privateKey.slice();
    try {
      return use(key);
    } finally {
      key.fill(0);
    }
  }

  /** Signs a transaction. Multisign adds this wallet's entry to `Signers` instead of `TxnSignature`. Throws `WalletError`, or `CodecError` for a transaction the codec cannot serialize. */
  sign(tx: TxJson, opts: { multisign?: boolean; definitions?: Definitions } = {}): { tx_blob: string; hash: string } {
    return this.#withKey((privateKey) => {
      // One read of `tx`: a getter must not show the refusal check one value and the signer another.
      const snapshot: TxJson = { ...tx };
      if (opts.multisign) {
        if ("Signers" in snapshot) throw new WalletError({ reason: "bad_tx", message: "transaction already has Signers; multisigned transactions cannot be signed again here" });
        const { TxnSignature: _drop, ...rest } = snapshot;
        const unsigned = { ...rest, SigningPubKey: "" };
        refuseDangerous(unsigned, opts.definitions);
        const signature = signBytes(encodeForMultisigning(unsigned, this.address, opts.definitions), privateKey, this.algorithm);
        const signer = { Signer: { Account: this.address, SigningPubKey: this.publicKey, TxnSignature: bytesToHex(signature) } };
        const tx_blob = encode({ ...unsigned, Signers: [signer] }, opts.definitions);
        return { tx_blob, hash: hashTransaction(tx_blob) };
      }
      const unsigned = { ...snapshot, SigningPubKey: this.publicKey };
      const { Account } = refuseDangerous(unsigned, opts.definitions);
      if (Account !== this.address) throw new WalletError({ reason: "bad_tx", message: "transaction Account is not this wallet's address" });
      const signature = signBytes(encodeForSigning(unsigned, opts.definitions), privateKey, this.algorithm);
      const tx_blob = encode({ ...unsigned, TxnSignature: bytesToHex(signature) }, opts.definitions);
      return { tx_blob, hash: hashTransaction(tx_blob) };
    });
  }

  /**
   * Signs arbitrary bytes, byte-compatible with ripple-keypairs' `sign`. Refuses bytes that start with an XRPL hash
   * prefix (`STX\0`, `SMT\0`, …): those are transaction signing data, and a signature over them is a valid transaction.
   */
  signMessage(message: Uint8Array): string {
    if (hasHashPrefix(message)) throw new WalletError({ reason: "bad_message", message: "message starts with an XRPL hash prefix; sign transactions with sign()" });
    return bytesToHex(this.#withKey((k) => signBytes(message, k, this.algorithm)));
  }

  /** Zeroes the private key; every later sign throws `destroyed`. */
  destroy(): void {
    this.#privateKey.fill(0);
    this.#destroyed = true;
  }

  toJSON(): { address: string; publicKey: string } {
    return { address: this.address, publicKey: this.publicKey };
  }

  toString(): string {
    return `Wallet(${this.address})`;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

// Xahau's Import syncs the account from the XPOP's inner XRPL transaction: SetRegularKey / SignerListSet carry keying over
// (an empty SetRegularKey without a signer list disables the master key). An inner AccountSet is left signable: it is the
// standard burn-to-mint transaction and only carries the account's own mainnet flags.
const IMPORT_KEEPS_AUTHORITY: Record<number, string> = { 5: "SetRegularKey", 12: "SignerListSet" }; // XRPL TransactionType codes

/**
 * Transaction type code of the XRPL transaction inside an XPOP (hex JSON with `transaction.blob`), `undefined` if
 * unreadable. A canonical transaction starts with its `TransactionType` (field header 0x12, then the UInt16 code), so
 * no full decode is needed.
 */
const importInnerTypeCode = (blob: unknown): number | undefined => {
  const isHex = (s: unknown): s is string => typeof s === "string" && s.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(s);
  try {
    if (!isHex(blob)) return undefined;
    const bytes = Uint8Array.from(blob.match(/../g) ?? [], (b) => parseInt(b, 16));
    const xpop: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const transaction = typeof xpop === "object" && xpop !== null && "transaction" in xpop ? xpop.transaction : undefined;
    const inner = typeof transaction === "object" && transaction !== null && "blob" in transaction ? transaction.blob : undefined;
    if (!isHex(inner) || inner.length < 6 || !/^12/i.test(inner)) return undefined;
    return parseInt(inner.slice(2, 6), 16);
  } catch {
    return undefined;
  }
};

/**
 * Reason a transaction must not be signed: it hands control of the account to another key (or hides inner
 * transactions), so every signer in this package refuses it. `undefined` means signable. Matches names only, so a
 * non-string `TransactionType` (the codec also accepts numeric codes) is refused rather than guessed at;
 * `Wallet.sign` runs it on the decoded transaction, where names are canonical.
 */
export const signingRefusal = (tx: Record<string, unknown>): string | undefined => {
  const type = tx.TransactionType;
  if (typeof type !== "string") return "TransactionType が文字列ではないため、署名しません。";
  if (type === "Batch") return "Batch は中の取引を個別に確認できないため、署名しません。";
  if (type === "Import") {
    const code = importInnerTypeCode(tx.Blob);
    if (code === undefined) return "Import の XPOP を読めず、中の取引を確認できないため、署名しません。";
    const inner = IMPORT_KEEPS_AUTHORITY[code];
    if (inner) return `Import の中の取引が ${inner} で、口座の管理権限を取り込むため、署名しません。`;
  }
  const disablesMaster = type === "AccountSet" && tx.SetFlag === 4; // asfDisableMaster
  return type === "SetRegularKey" || type === "SignerListSet" || type === "DelegateSet" || type === "SetHook" || disablesMaster
    ? `${type}${disablesMaster ? "（asfDisableMaster）" : ""} は口座の管理権限を変えるため、署名しません。`
    : undefined;
};

/** Seed for given entropy, for users who want the classic backup string. */
/** The family seed (`s…` / `sEd…`) for 16 bytes of entropy. Throws `WalletError` (`bad_entropy`). */
export const entropyToSeed = (entropy: Uint8Array, algorithm: Algorithm = "secp256k1"): string => {
  try {
    return encodeSeed(entropy, algorithm);
  } catch (e) {
    if (e instanceof AddressError) throw new WalletError({ reason: "bad_entropy", message: e.message, cause: e });
    throw e;
  }
};
