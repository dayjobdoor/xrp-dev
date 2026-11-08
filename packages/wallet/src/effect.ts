import { Effect } from "effect";
import { CodecError, lift, liftAsync } from "xrp-dev/effect";
import * as plain from "./index.js";
import { WalletError } from "./errors.js";

// The Effect API of the wallet: the plain functions of `./index.js`, failing with the same errors. `Wallet` wraps a plain
// wallet, so the key handling (zeroed copies, `destroy`) is the one implementation.

export { WalletError } from "./errors.js";
export { signingRefusal } from "./index.js";
export type { Algorithm } from "./index.js";

type Algorithm = plain.Algorithm;
type SignOptions = Parameters<plain.Wallet["sign"]>[1];
type EntropyOptions = { algorithm?: Algorithm };

const fails = /* @__PURE__ */ lift(WalletError);
const failsAsync = /* @__PURE__ */ liftAsync(WalletError);

export const toSecretNumbers = /* @__PURE__ */ fails(plain.toSecretNumbers);
export const entropyToSeed = /* @__PURE__ */ fails(plain.entropyToSeed);
/** WebAuthn PRF output (32 bytes) → HKDF-SHA256 → 16 bytes of entropy. */
export const entropyFromPrf = /* @__PURE__ */ failsAsync(plain.entropyFromPrf);

export class Wallet {
  readonly #wallet: plain.Wallet;

  private constructor(wallet: plain.Wallet) {
    this.#wallet = wallet;
  }

  get address(): string {
    return this.#wallet.address;
  }

  get publicKey(): string {
    return this.#wallet.publicKey;
  }

  get algorithm(): Algorithm {
    return this.#wallet.algorithm;
  }

  static fromEntropy(entropy: Uint8Array, opts?: EntropyOptions): Effect.Effect<Wallet, WalletError> {
    return Effect.map(fails((e: Uint8Array, o?: EntropyOptions) => plain.Wallet.fromEntropy(e, o))(entropy, opts), (w) => new Wallet(w));
  }

  static fromSeed(seed: string): Effect.Effect<Wallet, WalletError> {
    return Effect.map(fails(plain.Wallet.fromSeed)(seed), (w) => new Wallet(w));
  }

  static fromSecretNumbers(input: string | readonly string[], opts?: EntropyOptions): Effect.Effect<Wallet, WalletError> {
    return Effect.map(fails((i: string | readonly string[], o?: EntropyOptions) => plain.Wallet.fromSecretNumbers(i, o))(input, opts), (w) => new Wallet(w));
  }

  /** WebAuthn PRF output (32 bytes) → HKDF-SHA256 (`salt` and `info` default to "xrp-dev/prf/v1") → 16 bytes of entropy. */
  static fromPrf(prf: Uint8Array, opts?: { salt?: Uint8Array; info?: Uint8Array; algorithm?: Algorithm }): Effect.Effect<Wallet, WalletError> {
    return Effect.map(failsAsync((p: Uint8Array, o?: { salt?: Uint8Array; info?: Uint8Array; algorithm?: Algorithm }) => plain.Wallet.fromPrf(p, o))(prf, opts), (w) => new Wallet(w));
  }

  /** Signs a transaction. Multisign adds this wallet's entry to `Signers` instead of `TxnSignature`. */
  sign(tx: Parameters<plain.Wallet["sign"]>[0], opts?: SignOptions): Effect.Effect<{ tx_blob: string; hash: string }, WalletError | CodecError> {
    return lift(WalletError, CodecError)((t: typeof tx, o?: SignOptions) => this.#wallet.sign(t, o))(tx, opts);
  }

  /** Signs arbitrary bytes (hex signature), byte-compatible with ripple-keypairs. Refuses bytes that start with an XRPL hash prefix. */
  signMessage(message: Uint8Array): Effect.Effect<string, WalletError> {
    return fails((m: Uint8Array) => this.#wallet.signMessage(m))(message);
  }

  /** Zeroes the private key; every later sign fails with `destroyed`. */
  destroy(): void {
    this.#wallet.destroy();
  }

  toJSON(): { address: string; publicKey: string } {
    return this.#wallet.toJSON();
  }

  toString(): string {
    return this.#wallet.toString();
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}
