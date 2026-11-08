import type { WalletAdapter } from "xrpl-connect";
import { publicKeyToAddress } from "./address.js";
import { decode, signerMatchesAccount, verifyTransaction } from "./codec.js";
import * as ed25519 from "./crypto/ed25519.js";
import { sha512Half } from "./crypto/hash.js";
import { bytesToHex, hexToBytes } from "./crypto/hex.js";
import * as secp256k1 from "./crypto/secp256k1.js";
import { AddressError, CodecError, CryptoError } from "./errors.js";

// Sign-in for apps whose account is a wallet: the server issues a signed challenge, the wallet signs it.
//
// A challenge is `<unix ms>.<hex nonce>.<hex hmac-sha256>`. The HMAC covers the app, the web origin, the time and the
// nonce, so a challenge never works for another service or another origin, and no two challenges are equal. The wallet
// signs a message that names app, origin and (when given) the account name. Without `consumeChallenge` a signed login
// can be replayed within `CHALLENGE_TTL_MS`.

/** How long a challenge stays valid. */
export const CHALLENGE_TTL_MS = 300_000;
const ED25519_PREFIX = 0xed;
const NONCE_BYTES = 16;
// Upper bounds for what `verifyLogin` accepts (hex characters for the credential fields), checked before any crypto.
const MAX_CHALLENGE = 128;
const MAX_SIGNATURE = 160; // ed25519: 128, DER secp256k1: at most 144
const MAX_PUBLIC_KEY = 66;
const MAX_PROOF = 4096; // one signature over a small AccountSet; a 32-signer multisig is about 10 000
const MAX_NAME = 128;
const utf8 = (text: string) => new TextEncoder().encode(text);

// Not a malformed request but a caller bug: without an origin the challenge would not be bound to one.
const requireOrigin = (origin: string) => {
  if (typeof origin !== "string" || origin === "") throw new TypeError("origin is required, e.g. https://app.example");
};

const hmac = async (secret: string, app: string, origin: string, issuedAt: string, nonce: string) => {
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const input = JSON.stringify(["xrp-dev/login/v2", app, origin, issuedAt, nonce]);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(input))));
};

/** XOR fold: the time does not depend on where two equal-length strings differ. */
const sameHex = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * `<unix ms>.<hex nonce>.<hex hmac-sha256>`: 128 random bits make every challenge unique. Bound to `app` and `origin`
 * (the web origin the page is served from, e.g. `https://app.example`), so a challenge from one service or origin never logs
 * in to another.
 */
export const createChallenge = async (secret: string, opts: { app: string; origin: string; now?: number }): Promise<string> => {
  requireOrigin(opts.origin);
  const issuedAt = String(opts.now ?? Date.now());
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
  return `${issuedAt}.${nonce}.${await hmac(secret, opts.app, opts.origin, issuedAt, nonce)}`;
};

/** The nonce and the end of validity of a challenge this server issued for `app` and `origin` and that has not expired; else `undefined`. */
const openChallenge = async (
  secret: string,
  challenge: string,
  opts: { app: string; origin: string; now?: number },
): Promise<{ nonce: string; expiresAt: number } | undefined> => {
  requireOrigin(opts.origin);
  if (typeof challenge !== "string" || challenge.length > MAX_CHALLENGE) return undefined;
  const parts = challenge.split(".");
  if (parts.length !== 3) return undefined; // includes the old `<unix ms>.<mac>` format
  const [issuedAt, nonce, mac] = parts as [string, string, string];
  if (!/^\d{1,16}$/.test(issuedAt) || !/^[0-9A-F]{32}$/.test(nonce)) return undefined;
  const age = (opts.now ?? Date.now()) - Number(issuedAt);
  if (age < 0 || age > CHALLENGE_TTL_MS) return undefined;
  if (!sameHex(mac, await hmac(secret, opts.app, opts.origin, issuedAt, nonce))) return undefined;
  return { nonce, expiresAt: Number(issuedAt) + CHALLENGE_TTL_MS };
};

export const isFreshChallenge = async (secret: string, challenge: string, opts: { app: string; origin: string; now?: number }): Promise<boolean> =>
  (await openChallenge(secret, challenge, opts)) !== undefined;

/** Scope of a signed login: what the wallet's signature is for. */
export type LoginScope = { app: string; origin: string; challenge: string; name?: string };

/**
 * Text the wallet signs. The client signs exactly this string and the server rebuilds it. It names the app, the origin
 * and, when the app passes one, the account name, so a relayed signature cannot register a different permanent name.
 */
export const loginMessage = (p: LoginScope): string =>
  `${p.app} login\nOrigin: ${p.origin}\n${p.name !== undefined ? `Name: ${p.name}\n` : ""}Challenge: ${p.challenge}`;

// A malformed key, signature or blob is "not valid", not an exception; anything else thrown is a bug and propagates.
const orUndefined = <T>(f: () => T): T | undefined => {
  try {
    return f();
  } catch (e) {
    if (e instanceof CryptoError || e instanceof AddressError || e instanceof CodecError) return undefined;
    throw e;
  }
};

/**
 * Verifies a `Wallet.signMessage` signature and returns the classic address derived from the public key,
 * or `undefined` when the signature is not valid for that key.
 */
export const verifyMessage = (params: { message: string; signature: string; publicKey: string }): string | undefined =>
  orUndefined(() => {
    const publicKey = hexToBytes(params.publicKey);
    const signature = hexToBytes(params.signature);
    const message = utf8(params.message);
    const isEd25519 = publicKey.length === 33 && publicKey[0] === ED25519_PREFIX;
    const valid = isEd25519
      ? ed25519.verify(signature, message, publicKey.subarray(1))
      : publicKey.length === 33 && (publicKey[0] === 0x02 || publicKey[0] === 0x03)
        ? secp256k1.verify(signature, sha512Half(message), publicKey)
        : false;
    return valid ? publicKeyToAddress(publicKey) : undefined;
  });

const hex = (text: string) => bytesToHex(utf8(text)).toUpperCase();

/**
 * For wallets that cannot sign messages (Xaman): a transaction the ledger can never apply (`Sequence` 0 and `Fee` 0
 * are both invalid), carrying the login message in a memo. Signing it proves the key without moving anything.
 * `SigningPubKey` is left to the wallet: Xaman reads an empty one as a multisign request.
 */
export type LoginProofTx = {
  TransactionType: "AccountSet";
  Account: string;
  Sequence: 0;
  Fee: "0";
  LastLedgerSequence: number;
  Memos: { Memo: { MemoType: string; MemoData: string } }[];
};

export const loginProofTx = (p: LoginScope & { account: string }): LoginProofTx => ({
  TransactionType: "AccountSet",
  Account: p.account,
  Sequence: 0,
  Fee: "0",
  // Xaman's sign() wants an absolute value (at least 32570; smaller ones read as relative offsets). Xaman may raise one
  // that is near or past expiry, and xrpl-connect rejects a raise of more than 50 ledgers, so use the maximum: it never
  // expires. Being present also lets `autofill` skip every network call
  LastLedgerSequence: 4294967295,
  Memos: [{ Memo: { MemoType: hex("login"), MemoData: hex(loginMessage(p)) } }],
});

/**
 * The signer's address when `blob` is a valid, master-key-signed `loginProofTx` for this challenge; else `undefined`.
 * The cheap checks come first (fields, no `Signers`, the one `SigningPubKey` is the account's own key); the signature, the
 * only expensive part, is verified last, so a multisigned blob with many signers costs no more than garbage.
 */
export const verifyProofTx = (blob: string, p: LoginScope): string | undefined =>
  orUndefined(() => {
    const tx = decode(blob);
    const memos = tx.Memos;
    const memo = Array.isArray(memos) && memos.length === 1 ? (memos[0] as { Memo?: { MemoData?: unknown } } | null)?.Memo : undefined;
    const ok =
      tx.TransactionType === "AccountSet" &&
      tx.Sequence === 0 &&
      tx.Fee === "0" &&
      typeof tx.Account === "string" &&
      typeof memo?.MemoData === "string" &&
      memo.MemoData.toUpperCase() === hex(loginMessage(p)) &&
      tx.Signers === undefined &&
      signerMatchesAccount(blob) &&
      verifyTransaction(blob);
    return ok ? (tx.Account as string) : undefined;
  });

/** `challenge_used`: `consumeChallenge` said the challenge was already spent. */
export type LoginFailure = "invalid_request" | "challenge_invalid" | "challenge_used" | "signature_invalid";

/**
 * Server half of `login`: checks the challenge and the signature (or proof transaction) of a `POST /api/auth/login`
 * body. The address is what the caller then puts into its session.
 *
 * `origin` is the app's own web origin from its configuration (`https://app.example`), never a value from the request.
 * `name` is the account name from the body, if any; the wallet signed it, so it cannot be swapped.
 *
 * A signed login can be replayed until the challenge expires, unless `consumeChallenge` is given. It is called once per
 * valid signed login with the challenge's nonce and its expiry (ms, when the entry may be dropped) and must return `false`
 * if that nonce was seen before, which makes `verifyLogin` answer `challenge_used`. It has to be atomic, e.g. an insert
 * that fails on a duplicate:
 *
 * ```ts
 * const seen = new Map<string, number>(); // a database `INSERT … ON CONFLICT DO NOTHING` with a unique nonce works across servers
 * const consumeChallenge = (nonce: string, expiresAtMs: number) => {
 *   for (const [n, at] of seen) if (at < Date.now()) seen.delete(n);
 *   if (seen.has(nonce)) return false;
 *   seen.set(nonce, expiresAtMs);
 *   return true;
 * };
 * await verifyLogin(secret, { app, origin, challenge, signature, publicKey, consumeChallenge });
 * ```
 */
export const verifyLogin = async (
  secret: string,
  p: {
    app: string;
    origin: string;
    challenge: string;
    name?: string;
    signature?: string;
    publicKey?: string;
    proof?: string;
    consumeChallenge?: (nonce: string, expiresAtMs: number) => boolean | Promise<boolean>;
  },
): Promise<{ address: string } | { code: LoginFailure }> => {
  const credential = p.proof !== undefined || (p.signature !== undefined && p.publicKey !== undefined);
  if (!credential) return { code: "invalid_request" };
  const tooLong = (value: string | undefined, max: number) => value !== undefined && (typeof value !== "string" || value.length > max);
  if (tooLong(p.proof, MAX_PROOF) || tooLong(p.signature, MAX_SIGNATURE) || tooLong(p.publicKey, MAX_PUBLIC_KEY) || tooLong(p.name, MAX_NAME)) {
    return { code: "invalid_request" };
  }
  const opened = await openChallenge(secret, p.challenge, p);
  if (!opened) return { code: "challenge_invalid" };
  const scope: LoginScope = { app: p.app, origin: p.origin, challenge: p.challenge, ...(p.name !== undefined && { name: p.name }) };
  const address =
    p.proof !== undefined
      ? verifyProofTx(p.proof, scope)
      : verifyMessage({ message: loginMessage(scope), signature: p.signature!, publicKey: p.publicKey! });
  if (!address) return { code: "signature_invalid" };
  // Only after the signature: an unsigned request must not be able to spend someone else's challenge.
  if (p.consumeChallenge && !(await p.consumeChallenge(opened.nonce, opened.expiresAt))) return { code: "challenge_used" };
  return { address };
};

/** A non-2xx answer of the app's auth API: `message` as sent, plus the HTTP `status` and the body's `code` (e.g. `name_taken`) and `reason`. */
export class LoginError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "LoginError";
  }
}

/**
 * Browser half. Fetches a challenge, has the connected wallet sign it (a message when the wallet can, else the proof
 * transaction) and posts it. `origin` defaults to `location.origin` and must be the one the server was configured with.
 * `name`, when given, is part of the signed text. The session cookie comes back on the response. A non-2xx answer throws a `LoginError` with its `message`.
 */
export const login = async (
  adapter: WalletAdapter,
  p: { app: string; origin?: string; base?: string; name?: string; fetch?: typeof fetch },
): Promise<{ address: string; name?: string }> => {
  const call = p.fetch ?? fetch;
  const base = p.base ?? "";
  const read = async <T>(res: Response): Promise<T> => {
    const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string; reason?: string };
    if (!res.ok) throw new LoginError(body.message ?? `HTTP ${res.status}`, res.status, body.code, body.reason);
    return body as T;
  };
  const origin = p.origin ?? globalThis.location?.origin;
  if (!origin) throw new Error("origin is required outside a browser, e.g. https://app.example");
  // The message is built here, not taken from the server: the wallet only ever signs this app, this origin and this name.
  const { challenge } = await read<{ challenge: string }>(await call(`${base}/api/auth/challenge`, { credentials: "include" }));
  const scope: LoginScope = { app: p.app, origin, challenge, ...(p.name !== undefined && { name: p.name }) };
  const message = loginMessage(scope);

  let credential: Record<string, string>;
  if (adapter.capabilities?.signMessage !== false) {
    const { signature, publicKey } = await adapter.signMessage(message);
    credential = { signature, publicKey };
  } else {
    const account = await adapter.getAccount();
    if (!account) throw new Error("the wallet is not connected");
    const signed = await adapter.sign(loginProofTx({ ...scope, account: account.address }));
    if (!signed.tx_blob) throw new Error("the wallet did not return a signed transaction");
    credential = { proof: signed.tx_blob };
  }

  return read(
    await call(`${base}/api/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge, ...credential, ...(p.name !== undefined && { name: p.name }) }),
    }),
  );
};
