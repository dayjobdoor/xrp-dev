import { decodeSeed, deriveAccountId, encodeAccountId, encodeSeed, type Algorithm } from "xrp-dev/address";
import { decode, encode, encodeForMultisigning, encodeForSigning, hashTransaction, type Definitions, type TxJson } from "xrp-dev/codec";
import { bytesToHex, concatBytes, ed25519, secp256k1, sha512Half } from "xrp-dev/crypto";
import type { CodecError } from "xrp-dev";
import { Effect } from "effect";
import { WalletError } from "./errors.js";
import { fromSecretNumbers } from "./secretNumbers.js";
import { prfSalt } from "./prf.js";

export { WalletError } from "./errors.js";
export { toSecretNumbers } from "./secretNumbers.js";
export type { Algorithm };

const ED_PREFIX = 0xed;

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

/** ripple-keypairs' scalar search: sha512Half(bytes ‖ [discrim] ‖ i) until 0 < k < n. */
const deriveScalar = (bytes: Uint8Array, discrim?: number) =>
  Effect.gen(function* () {
    for (let i = 0; i <= 0xffffffff; i++) {
      const input = concatBytes(bytes, ...(discrim === undefined ? [] : [u32(discrim)]), u32(i));
      const k = yield* sha512Half(input).pipe(Effect.ensuring(Effect.sync(() => input.fill(0))));
      if (secp256k1.isValidPrivateKey(k)) return k;
    }
    return yield* Effect.die("no valid scalar");
  });

const keyError = (e: { message: string }) => new WalletError({ reason: "bad_key", message: e.message });

const deriveKeys = (entropy: Uint8Array, algorithm: Algorithm) =>
  Effect.gen(function* () {
    if (algorithm === "ed25519") {
      const privateKey = yield* sha512Half(entropy);
      const publicKey = concatBytes(Uint8Array.of(ED_PREFIX), yield* ed25519.getPublicKey(privateKey).pipe(Effect.mapError(keyError)));
      return { privateKey, publicKey };
    }
    const root = yield* deriveScalar(entropy);
    return yield* Effect.gen(function* () {
      const rootPublic = yield* secp256k1.getPublicKey(root).pipe(Effect.mapError(keyError));
      const tweak = yield* deriveScalar(rootPublic, 0);
      const privateKey = secp256k1.addScalars(root, tweak);
      tweak.fill(0);
      return { privateKey, publicKey: yield* secp256k1.getPublicKey(privateKey).pipe(Effect.mapError(keyError)) };
    }).pipe(Effect.ensuring(Effect.sync(() => root.fill(0))));
  });

/** Signs the bytes XRPL expects: secp256k1 over sha512Half(data), ed25519 over data itself. */
const signBytes = (data: Uint8Array, privateKey: Uint8Array, algorithm: Algorithm) =>
  (algorithm === "ed25519" ? ed25519.sign(data, privateKey) : Effect.flatMap(sha512Half(data), (h) => secp256k1.sign(h, privateKey))).pipe(
    Effect.mapError(keyError),
  );

// rippled hash prefixes (STX\0, SMT\0, CLM\0, TXN\0, …) are three upper-case letters and a zero byte.
const hasHashPrefix = (m: Uint8Array) => m.length >= 4 && m[3] === 0 && [0, 1, 2].every((i) => m[i]! >= 0x41 && m[i]! <= 0x5a);

/**
 * WebAuthn PRF output (32 bytes) → HKDF-SHA256 → 16 bytes of entropy. `salt` and `info` default to "xrp-dev/prf/v1";
 * pass both to reproduce another app's frozen derivation (e.g. salt = SHA-256(rpId), info = a per-algorithm label).
 * Exposed so an app can show the Secret Numbers backup for a passkey-derived account.
 */
export const entropyFromPrf = (prf: Uint8Array, opts: { salt?: Uint8Array; info?: Uint8Array } = {}): Effect.Effect<Uint8Array, WalletError> =>
  prf.length < 32
    ? Effect.fail(new WalletError({ reason: "bad_prf", message: "PRF output must be at least 32 bytes" }))
    : Effect.promise(async () => {
        const copy = new Uint8Array(prf);
        try {
          const key = await crypto.subtle.importKey("raw", copy, "HKDF", false, ["deriveBits"]);
          const params = { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(opts.salt ?? prfSalt()), info: new Uint8Array(opts.info ?? prfSalt()) };
          return new Uint8Array(await crypto.subtle.deriveBits(params, key, 128));
        } finally {
          copy.fill(0);
        }
      });

/** Wipes entropy the package itself produced (seed decode, Secret Numbers, HKDF). Never used on a caller's `fromEntropy` buffer. */
const fromOwnedEntropy = (entropy: Uint8Array, opts: { algorithm?: Algorithm }) =>
  Wallet.fromEntropy(entropy, opts).pipe(Effect.ensuring(Effect.sync(() => entropy.fill(0))));

/** Encodes and decodes `tx` so the check sees what the signature will cover: the codec accepts numeric TransactionType codes, and decoding yields canonical names. */
const refuseDangerous = (tx: TxJson, defs?: Definitions) =>
  Effect.gen(function* () {
    const decoded = yield* decode(yield* encode(tx, defs), defs);
    const refusal = signingRefusal(decoded);
    if (refusal) return yield* new WalletError({ reason: "refused", message: refusal });
    return decoded;
  });

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

  static fromEntropy(entropy: Uint8Array, opts: { algorithm?: Algorithm } = {}): Effect.Effect<Wallet, WalletError> {
    const algorithm = opts.algorithm ?? "secp256k1";
    return Effect.gen(function* () {
      if (entropy.length !== 16) return yield* new WalletError({ reason: "bad_entropy", message: "entropy must be 16 bytes" });
      const { privateKey, publicKey } = yield* deriveKeys(entropy, algorithm);
      const address = yield* deriveAccountId(publicKey).pipe(Effect.flatMap(encodeAccountId), Effect.mapError(keyError));
      return new Wallet(address, publicKey, privateKey, algorithm);
    });
  }

  static fromSeed(seed: string): Effect.Effect<Wallet, WalletError> {
    return decodeSeed(seed).pipe(
      Effect.mapError(() => new WalletError({ reason: "bad_seed", message: "not a valid XRPL seed" })),
      Effect.flatMap(({ entropy, algorithm }) => fromOwnedEntropy(entropy, { algorithm })),
    );
  }

  static fromSecretNumbers(input: string | readonly string[], opts: { algorithm?: Algorithm } = {}): Effect.Effect<Wallet, WalletError> {
    return fromSecretNumbers(input).pipe(Effect.flatMap((entropy) => fromOwnedEntropy(entropy, opts)));
  }

  /** WebAuthn PRF output (32 bytes) → HKDF-SHA256 (`salt` and `info` default to "xrp-dev/prf/v1") → 16 bytes of entropy. */
  static fromPrf(prf: Uint8Array, opts: { salt?: Uint8Array; info?: Uint8Array; algorithm?: Algorithm } = {}): Effect.Effect<Wallet, WalletError> {
    return entropyFromPrf(prf, opts).pipe(Effect.flatMap((entropy) => fromOwnedEntropy(entropy, opts.algorithm ? { algorithm: opts.algorithm } : {})));
  }

  /** A copy of the key, zeroed after `use`, so `destroy()` during an in-flight sign cannot swap in a zeroed key. */
  #withKey<A, E>(use: (key: Uint8Array) => Effect.Effect<A, E>): Effect.Effect<A, E | WalletError> {
    return Effect.acquireUseRelease(
      Effect.suspend(() => (this.#destroyed ? Effect.fail(new WalletError({ reason: "destroyed", message: "wallet was destroyed" })) : Effect.succeed(this.#privateKey.slice()))),
      use,
      (key) => Effect.sync(() => key.fill(0)),
    );
  }

  /** Signs a transaction. Multisign adds this wallet's entry to `Signers` instead of `TxnSignature`. */
  sign(tx: TxJson, opts: { multisign?: boolean; definitions?: Definitions } = {}): Effect.Effect<{ tx_blob: string; hash: string }, WalletError | CodecError> {
    const self = this;
    return this.#withKey((privateKey) =>
      Effect.gen(function* () {
        // One read of `tx`: a getter must not show the refusal check one value and the signer another.
        const snapshot = { ...tx } as TxJson & { TxnSignature?: unknown };
        if (opts.multisign) {
          if ("Signers" in snapshot) return yield* new WalletError({ reason: "bad_tx", message: "transaction already has Signers; multisigned transactions cannot be signed again here" });
          const { TxnSignature: _drop, ...rest } = snapshot;
          const unsigned = { ...rest, SigningPubKey: "" };
          yield* refuseDangerous(unsigned, opts.definitions);
          const signature = yield* signBytes(yield* encodeForMultisigning(unsigned, self.address, opts.definitions), privateKey, self.algorithm);
          const signer = { Signer: { Account: self.address, SigningPubKey: self.publicKey, TxnSignature: bytesToHex(signature) } };
          const signed = { ...unsigned, Signers: [signer] };
          const tx_blob = yield* encode(signed, opts.definitions);
          return { tx_blob, hash: yield* hashTransaction(tx_blob) };
        }
        const unsigned = { ...snapshot, SigningPubKey: self.publicKey };
        const { Account } = yield* refuseDangerous(unsigned, opts.definitions);
        if (Account !== self.address) return yield* new WalletError({ reason: "bad_tx", message: "transaction Account is not this wallet's address" });
        const signature = yield* signBytes(yield* encodeForSigning(unsigned, opts.definitions), privateKey, self.algorithm);
        const tx_blob = yield* encode({ ...unsigned, TxnSignature: bytesToHex(signature) }, opts.definitions);
        return { tx_blob, hash: yield* hashTransaction(tx_blob) };
      }),
    );
  }

  /**
   * Signs arbitrary bytes, byte-compatible with ripple-keypairs' `sign`. Refuses bytes that start with an XRPL hash
   * prefix (`STX\0`, `SMT\0`, …): those are transaction signing data, and a signature over them is a valid transaction.
   */
  signMessage(message: Uint8Array): Effect.Effect<string, WalletError> {
    if (hasHashPrefix(message)) {
      return Effect.fail(new WalletError({ reason: "bad_message", message: "message starts with an XRPL hash prefix; sign transactions with sign()" }));
    }
    return this.#withKey((k) => signBytes(message, k, this.algorithm)).pipe(Effect.map(bytesToHex));
  }

  /** Zeroes the private key; every later sign fails with `destroyed`. */
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
  const disablesMaster = type === "AccountSet" && tx.SetFlag === 4; // asfDisableMaster
  return type === "SetRegularKey" || type === "SignerListSet" || type === "DelegateSet" || disablesMaster
    ? `${type}${disablesMaster ? "（asfDisableMaster）" : ""} は口座の管理権限を変えるため、署名しません。`
    : undefined;
};

/** Seed for given entropy, for users who want the classic backup string. */
export const entropyToSeed = (entropy: Uint8Array, algorithm: Algorithm = "secp256k1") =>
  encodeSeed(entropy, algorithm).pipe(Effect.mapError((e) => new WalletError({ reason: "bad_entropy", message: e.message })));
