import { entropyFromPrf, signingRefusal, toSecretNumbers, Wallet, type Algorithm } from "./index.js";
import { prfSalt, type PrfDerivation } from "./prf.js";
import { autofill, submit, type RpcClient } from "xrp-dev/client";
import { decode, type TxJson } from "xrp-dev/codec";
import { Effect } from "effect";
import type { SubmittableTransaction } from "xrpl";
import type { AccountInfo, ConnectOptions, NetworkInfo, ReconnectOptions, SignedMessage, SignedTransaction, SubmittedTransaction, WalletAdapter, WalletCapabilities } from "xrpl-connect";

/** The xrpl-connect types a consumer of this adapter needs. Type-only: no runtime dependency on xrpl-connect. */
export type { AccountInfo, ConnectOptions, NetworkInfo, SignedMessage, SignedTransaction, SubmittedTransaction, WalletAdapter, WalletCapabilities } from "xrpl-connect";
export type { SubmittableTransaction } from "xrpl";
export type { PrfDerivation } from "./prf.js";

/** What `serializeReconnectOptions` stores; `reconnect` marks a page-load restore. */
type StoredAccount = { reconnect?: boolean; address?: unknown; publicKey?: unknown; credentialId?: unknown; algorithm?: unknown };

export class PasskeyError extends Error {
  override name = "PasskeyError";
  /** Set when `signAndSubmit` signed but the submit failed: the transaction may still be applied, so look `hash` up with `tx` before signing again. */
  readonly hash?: string;
  readonly tx_blob?: string;
  constructor(message: string, options: ErrorOptions & { hash?: string; tx_blob?: string } = {}) {
    super(message, options);
    if (options.hash !== undefined) this.hash = options.hash;
    if (options.tx_blob !== undefined) this.tx_blob = options.tx_blob;
  }
}

export interface PasskeyAdapterOptions {
  network: NetworkInfo;
  /** Where `signAndSubmit` sends the signed blob (a public rippled node, straight from the browser). */
  client: RpcClient;
  rpId?: string;
  /** Restricts `connect` to one passkey. */
  credentialId?: Uint8Array;
  /** Defaults to `navigator.credentials`; injectable for tests. */
  credentials?: Pick<CredentialsContainer, "get" | "create">;
  /** Key type of the account. Defaults to "secp256k1"; an account restored after a reload must have been created with the same one. */
  algorithm?: Algorithm;
  /** Derivation inputs; the default is this package's v1 scheme. Set it to open an account another app derived. */
  derivation?: PrfDerivation;
}

const randomChallenge = () => crypto.getRandomValues(new Uint8Array(32));

/** xrpl.js allows `Flags` as an object of named flags. Converting them needs xrpl.js at runtime, which this adapter avoids. */
const requireNumericFlags = (tx: TxJson) => {
  if (typeof tx.Flags === "object" && tx.Flags !== null) throw new PasskeyError("Flags must be a number; convert named flags first (xrpl.js convertTxFlagsToNumber)");
};

const prfFirst = (credential: Credential | null): Uint8Array | undefined => {
  const results = (credential as PublicKeyCredential | null)?.getClientExtensionResults?.() as { prf?: { results?: { first?: BufferSource } } } | undefined;
  const first = results?.prf?.results?.first;
  return first ? new Uint8Array(first instanceof ArrayBuffer ? first : first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength)) : undefined;
};

type Credentials = Pick<CredentialsContainer, "get" | "create">;

const credentialsOf = (opts: { credentials?: Credentials }) =>
  opts.credentials ?? (typeof navigator === "undefined" ? undefined : navigator.credentials);

const prfExtension = (derivation?: PrfDerivation) =>
  ({ prf: { eval: { first: new Uint8Array(derivation?.prfInput ?? prfSalt()) } } }) as AuthenticationExtensionsClientInputs;

/** The HKDF half of a derivation plus the key type, as `Wallet.fromPrf` takes it. */
const walletOpts = (algorithm: Algorithm, derivation?: PrfDerivation) => ({
  algorithm,
  ...(derivation?.salt ? { salt: derivation.salt } : {}),
  ...(derivation?.info ? { info: derivation.info } : {}),
});

type PkcStatics = { getClientCapabilities?: () => Promise<Record<string, boolean>>; signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> };
const pkc = () => (globalThis as { PublicKeyCredential?: PkcStatics }).PublicKeyCredential;

/** False only when the browser says up front that it cannot evaluate PRF; browsers without `getClientCapabilities` get the benefit of the doubt. */
const prfSupported = async () => (await pkc()?.getClientCapabilities?.().catch(() => undefined))?.["extension:prf"] !== false;

const toBase64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** One user-verified passkey prompt for the PRF output. A dismissed prompt is the user's choice, so it reads as one. */
const ceremony = async (
  opts: { credentials?: Credentials; rpId?: string | undefined; derivation?: PrfDerivation | undefined },
  credentialId: Uint8Array | undefined,
): Promise<{ prf: Uint8Array; credentialId: Uint8Array }> => {
  const credentials = credentialsOf(opts);
  if (!credentials) throw new PasskeyError("WebAuthn is not available");
  const { rpId } = opts;
  const credential = await credentials
    .get({
      publicKey: {
        challenge: randomChallenge(),
        ...(rpId ? { rpId } : {}),
        ...(credentialId ? { allowCredentials: [{ type: "public-key", id: new Uint8Array(credentialId) }] } : {}),
        userVerification: "required",
        extensions: prfExtension(opts.derivation),
      },
    })
    .catch((cause: unknown) => {
      if ((cause as { name?: unknown } | null)?.name === "NotAllowedError") throw new PasskeyError("the passkey prompt was dismissed or timed out", { cause });
      throw cause;
    });
  const prf = prfFirst(credential);
  if (!prf) throw new PasskeyError("this passkey or browser does not support the PRF extension");
  return { prf, credentialId: new Uint8Array((credential as PublicKeyCredential).rawId) };
};

/**
 * Creates a passkey with PRF enabled and returns the account derived from it, with its Secret Numbers backup (the
 * passkey is the only other way back to this address). A passkey that cannot evaluate PRF would only be an orphan in
 * the OS passkey manager, so: a browser that reports no PRF support is refused before anything is created; an
 * authenticator that only reports `enabled` is asked once more with the new credential to get the PRF result; and when
 * none arrives the credential is reported to the OS as unknown (best effort, `signalUnknownCredential`) and this throws.
 */
export const registerPasskey = async (opts: {
  rp: { id?: string; name: string };
  user: { id: Uint8Array; name: string; displayName: string };
  credentials?: Credentials;
  algorithm?: Algorithm;
  derivation?: PrfDerivation;
}): Promise<{ credentialId: Uint8Array; account: { address: string; secretNumbers: string[] } }> => {
  const credentials = credentialsOf(opts);
  if (!credentials) throw new PasskeyError("WebAuthn is not available");
  if (!(await prfSupported())) throw new PasskeyError("this browser reports no PRF support; no passkey was created");
  const algorithm = opts.algorithm ?? "secp256k1";
  const credential = (await credentials.create({
    publicKey: {
      rp: opts.rp,
      user: { ...opts.user, id: new Uint8Array(opts.user.id) },
      challenge: randomChallenge(),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      attestation: "none",
      extensions: prfExtension(opts.derivation),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new PasskeyError("passkey was not created");
  const credentialId = new Uint8Array(credential.rawId);
  const rpId = opts.rp.id ?? (globalThis as { location?: { hostname?: string } }).location?.hostname;
  const drop = async (error: unknown): Promise<never> => {
    if (rpId) await pkc()?.signalUnknownCredential?.({ rpId, credentialId: toBase64url(credentialId) }).catch(() => undefined);
    throw error;
  };
  const enabled = (credential.getClientExtensionResults() as { prf?: { enabled?: boolean } }).prf?.enabled === true;
  const prf = prfFirst(credential) ?? (enabled ? (await ceremony({ ...opts, ...(opts.rp.id ? { rpId: opts.rp.id } : {}) }, credentialId).catch(drop)).prf : undefined);
  if (!prf) return drop(new PasskeyError("this passkey or browser does not support the PRF extension; the passkey was reported unknown to the OS"));
  try {
    const account = await Effect.runPromise(
      Effect.gen(function* () {
        const entropy = yield* entropyFromPrf(prf, opts.derivation);
        return yield* Effect.gen(function* () {
          const wallet = yield* Wallet.fromEntropy(entropy, { algorithm });
          wallet.destroy();
          return { address: wallet.address, secretNumbers: yield* toSecretNumbers(entropy) };
        }).pipe(Effect.ensuring(Effect.sync(() => entropy.fill(0))));
      }),
    );
    return { credentialId, account };
  } finally {
    prf.fill(0);
  }
};

/**
 * xrpl-connect `WalletAdapter` whose key is derived on the device from a passkey's PRF output; no server holds it.
 * Why no retained key: a connected adapter that signs silently lets any script in the page spend the account. Every
 * signature runs its own user-verified ceremony and the key lives only for that signature.
 */
export class PasskeyAdapter implements WalletAdapter {
  readonly id = "xrp-dev-passkey";
  readonly name = "Passkey";
  readonly capabilities: WalletCapabilities = { sign: true, signAndSubmit: true, signMessage: true };
  #account: AccountInfo | undefined;
  /** The credential `connect` used; later ceremonies are restricted to it. */
  #credentialId: Uint8Array | undefined;
  readonly #opts: PasskeyAdapterOptions;
  readonly #algorithm: Algorithm;

  constructor(opts: PasskeyAdapterOptions) {
    this.#opts = opts;
    this.#algorithm = opts.algorithm ?? "secp256k1";
  }

  async isAvailable(): Promise<boolean> {
    const credentials = credentialsOf(this.#opts);
    if (!credentials) return false;
    return prfSupported();
  }

  /** The client is bound to one node, so a requested network other than the configured one is refused (before any passkey prompt) rather than signed for and submitted elsewhere. */
  async connect(options?: ConnectOptions<StoredAccount>): Promise<AccountInfo> {
    const requested = typeof options?.network === "string" ? options.network : options?.network?.id;
    if (requested !== undefined && requested !== this.#opts.network.id) {
      throw new PasskeyError(`network "${requested}" was requested but this adapter is configured for "${this.#opts.network.id}"; create it with that network`);
    }
    if (options?.reconnect) return this.#restore(options);
    const { prf, credentialId } = await ceremony(this.#opts, this.#opts.credentialId);
    // Derive before replacing anything: a rejected derivation must not leave the adapter half-connected.
    const account = await this.#withPrf(prf, async (wallet) => ({ address: wallet.address, publicKey: wallet.publicKey, network: this.#opts.network }));
    this.#account = account;
    this.#credentialId = credentialId;
    return account;
  }

  /**
   * What xrpl-connect's `WalletManager` stores next to the session and spreads into `connect()` on `reconnect()`. Public
   * data only. A page-load restore never prompts: it trusts these values to show the account, and every signature still
   * re-derives the key and refuses when it is not this address (so a tampered store cannot make a wrong signature).
   */
  serializeReconnectOptions(): ReconnectOptions | undefined {
    const publicKey = this.#account?.publicKey;
    if (!this.#account || !publicKey || !this.#credentialId) return undefined;
    return { reconnect: true, address: this.#account.address, publicKey, credentialId: toBase64url(this.#credentialId), algorithm: this.#algorithm };
  }

  #restore(stored: StoredAccount): AccountInfo {
    const { address, publicKey, credentialId, algorithm } = stored;
    if (typeof address !== "string" || typeof publicKey !== "string" || typeof credentialId !== "string" || !address || !publicKey || !credentialId) {
      throw new PasskeyError("nothing to restore: no stored passkey account");
    }
    if (algorithm !== this.#algorithm) throw new PasskeyError(`the stored account uses ${String(algorithm)} but this adapter derives ${this.#algorithm}; create it with the same algorithm`);
    if (this.#opts.credentialId && toBase64url(this.#opts.credentialId) !== credentialId) throw new PasskeyError("the stored account belongs to another passkey than this adapter's credentialId");
    let id: Uint8Array;
    try {
      id = fromBase64url(credentialId);
    } catch (cause) {
      throw new PasskeyError("the stored credential id is not valid", { cause });
    }
    this.#account = { address, publicKey, network: this.#opts.network };
    this.#credentialId = id;
    return this.#account;
  }

  async disconnect(): Promise<void> {
    this.#account = undefined;
    this.#credentialId = undefined;
  }

  async getAccount(): Promise<AccountInfo | null> {
    return this.#account ?? null;
  }

  async getNetwork(): Promise<NetworkInfo> {
    return this.#opts.network;
  }

  async sign(transaction: SubmittableTransaction): Promise<SignedTransaction> {
    const account = this.#connected();
    // One read of the caller's object: a getter must not show the checks one value and the signer another.
    const snapshot: TxJson = { ...transaction };
    const refusal = signingRefusal(snapshot);
    if (refusal) throw new PasskeyError(refusal);
    requireNumericFlags(snapshot);
    if (snapshot.Account === undefined) snapshot.Account = account.address;
    else if (snapshot.Account !== account.address) throw new PasskeyError("transaction Account is not the connected account");
    const tx = await Effect.runPromise(autofill(this.#opts.client, snapshot));
    return this.#withWallet(async (wallet) => {
      const { tx_blob, hash } = await Effect.runPromise(wallet.sign(tx));
      const signed = await Effect.runPromise(decode(tx_blob));
      return { hash, tx_blob, tx_json: signed as unknown as SubmittableTransaction, signature: signed.TxnSignature as string, signerAddress: wallet.address };
    });
  }

  /**
   * Signs here and submits from the browser straight to the configured node. A failure after signing carries the
   * signed `hash` and `tx_blob` on the error: on a timeout the transaction may still be applied, and signing again
   * would use the next Sequence and pay twice.
   */
  async signAndSubmit(transaction: SubmittableTransaction): Promise<SubmittedTransaction> {
    const signed = await this.sign(transaction);
    const sent = { hash: signed.hash!, tx_blob: signed.tx_blob! };
    const result = await Effect.runPromise(submit(this.#opts.client, sent.tx_blob)).catch((cause: unknown) => {
      const why = cause instanceof Error ? cause.message : String(cause);
      throw new PasskeyError(`submit failed after signing (${why}); the transaction may still be applied: look up ${sent.hash} with the tx method before signing again`, { ...sent, cause });
    });
    if (/^te[mfl]/.test(result.engine_result)) throw new PasskeyError(`${result.engine_result}: ${result.engine_result_message} (transaction ${sent.hash})`, sent);
    return { ...signed, engine_result: result.engine_result, engine_result_message: result.engine_result_message };
  }

  async signMessage(message: string | Uint8Array): Promise<SignedMessage> {
    const account = this.#connected();
    const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message;
    return this.#withWallet(async (wallet) => {
      const signature = await Effect.runPromise(wallet.signMessage(bytes));
      return { message: typeof message === "string" ? message : Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""), signature, publicKey: account.publicKey!, signerAddress: wallet.address };
    });
  }

  #connected(): AccountInfo {
    if (!this.#account) throw new PasskeyError("not connected");
    return this.#account;
  }

  /** Derives a wallet from `prf`, hands it to `use`, and always wipes both afterwards. */
  async #withPrf<T>(prf: Uint8Array, use: (wallet: Wallet) => Promise<T>): Promise<T> {
    try {
      const wallet = await Effect.runPromise(Wallet.fromPrf(prf, walletOpts(this.#algorithm, this.#opts.derivation)));
      try {
        return await use(wallet);
      } finally {
        wallet.destroy();
      }
    } finally {
      prf.fill(0);
    }
  }

  /** A fresh ceremony per call, restricted to the connected credential; a different passkey's PRF derives a different address and is refused. */
  async #withWallet<T>(use: (wallet: Wallet) => Promise<T>): Promise<T> {
    const account = this.#connected();
    const { prf } = await ceremony(this.#opts, this.#credentialId);
    return this.#withPrf(prf, async (wallet) => {
      if (wallet.address !== account.address) throw new PasskeyError("the selected passkey is not the connected account's passkey; nothing was signed");
      return use(wallet);
    });
  }
}
