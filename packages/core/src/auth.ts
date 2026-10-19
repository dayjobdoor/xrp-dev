import { Effect } from "effect";
import type { WalletAdapter } from "xrpl-connect";
import { publicKeyToAddress } from "./address.js";
import { decode, signerMatchesAccount, verifyTransaction, type TxJson } from "./codec.js";
import { ed25519, secp256k1, sha512Half } from "./crypto.js";
import { bytesToHex, hexToBytes } from "./crypto/hex.js";

/** Sign-in for apps whose account is a wallet: the server issues a stateless challenge, the wallet signs it. */

export const CHALLENGE_TTL_MS = 300_000;
const ED25519_PREFIX = 0xed;
const utf8 = (text: string) => new TextEncoder().encode(text);

const hmac = async (secret: string, app: string, issuedAt: string) => {
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(`${app}/login/v1:${issuedAt}`))));
};

/** XOR fold: the time does not depend on where two equal-length strings differ. */
const sameHex = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** `<unix ms>.<hex hmac-sha256>`. Bound to `app`, so a challenge from one service never logs in to another. */
export const createChallenge = async (secret: string, opts: { app: string; now?: number }): Promise<string> => {
  const issuedAt = String(opts.now ?? Date.now());
  return `${issuedAt}.${await hmac(secret, opts.app, issuedAt)}`;
};

export const isFreshChallenge = async (secret: string, challenge: string, opts: { app: string; now?: number }): Promise<boolean> => {
  const [issuedAt, mac, ...rest] = challenge.split(".");
  if (!issuedAt || !mac || rest.length > 0) return false;
  const age = (opts.now ?? Date.now()) - Number(issuedAt);
  if (!Number.isFinite(age) || age < 0 || age > CHALLENGE_TTL_MS) return false;
  return sameHex(mac, await hmac(secret, opts.app, issuedAt));
};

/** Text the wallet signs. The client signs exactly this string and the server rebuilds it. */
export const loginMessage = (app: string, challenge: string): string => `${app} login\n${challenge}`;

/**
 * Verifies a `Wallet.signMessage` signature and returns the classic address derived from the public key,
 * or `undefined` when the signature is not valid for that key.
 */
export const verifyMessage = (params: { message: string; signature: string; publicKey: string }): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const publicKey = yield* hexToBytes(params.publicKey);
    const signature = yield* hexToBytes(params.signature);
    const message = utf8(params.message);
    const isEd25519 = publicKey.length === 33 && publicKey[0] === ED25519_PREFIX;
    const valid = isEd25519
      ? yield* ed25519.verify(signature, message, publicKey.subarray(1))
      : publicKey.length === 33 && (publicKey[0] === 0x02 || publicKey[0] === 0x03)
        ? yield* secp256k1.verify(signature, yield* sha512Half(message), publicKey)
        : false;
    return valid ? yield* publicKeyToAddress(publicKey) : undefined;
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));

const hex = (text: string) => bytesToHex(utf8(text)).toUpperCase();

/**
 * For wallets that cannot sign messages (Xaman): a transaction the ledger can never apply (`Sequence` 0 and `Fee` 0
 * are both invalid), carrying the login message in a memo. Signing it proves the key without moving anything.
 * `SigningPubKey` is left to the wallet: Xaman reads an empty one as a multisign request.
 */
export const loginProofTx = (p: { app: string; challenge: string; account: string }): TxJson => ({
  TransactionType: "AccountSet",
  Account: p.account,
  Sequence: 0,
  Fee: "0",
  // Xaman's sign() wants an absolute value of at least 32570 (smaller ones read as relative offsets).
  // Being present also lets `autofill` skip every network call
  LastLedgerSequence: 32570,
  Memos: [{ Memo: { MemoType: hex("login"), MemoData: hex(loginMessage(p.app, p.challenge)) } }],
});

/** The signer's address when `blob` is a valid, master-key-signed `loginProofTx` for this challenge; else `undefined`. */
export const verifyProofTx = (blob: string, p: { app: string; challenge: string }): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const tx = yield* decode(blob);
    const memos = tx.Memos;
    const memo = Array.isArray(memos) && memos.length === 1 ? (memos[0] as { Memo?: { MemoData?: unknown } } | null)?.Memo : undefined;
    const ok =
      tx.TransactionType === "AccountSet" &&
      tx.Sequence === 0 &&
      tx.Fee === "0" &&
      typeof tx.Account === "string" &&
      typeof memo?.MemoData === "string" &&
      memo.MemoData.toUpperCase() === hex(loginMessage(p.app, p.challenge)) &&
      (yield* verifyTransaction(blob)) &&
      (yield* signerMatchesAccount(blob));
    return ok ? (tx.Account as string) : undefined;
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));

export type LoginFailure = "invalid_request" | "challenge_invalid" | "signature_invalid";

/**
 * Server half of `login`: checks the challenge and the signature (or proof transaction) of a `POST /api/auth/login`
 * body. The address is what the caller then puts into its session.
 */
export const verifyLogin = async (
  secret: string,
  p: { app: string; challenge: string; signature?: string; publicKey?: string; proof?: string },
): Promise<{ address: string } | { code: LoginFailure }> => {
  const credential = p.proof !== undefined || (p.signature !== undefined && p.publicKey !== undefined);
  if (!credential) return { code: "invalid_request" };
  if (!(await isFreshChallenge(secret, p.challenge, { app: p.app }))) return { code: "challenge_invalid" };
  const address = await Effect.runPromise(
    p.proof !== undefined
      ? verifyProofTx(p.proof, p)
      : verifyMessage({ message: loginMessage(p.app, p.challenge), signature: p.signature!, publicKey: p.publicKey! }),
  );
  return address ? { address } : { code: "signature_invalid" };
};

/**
 * Browser half. Fetches a challenge, has the connected wallet sign it (a message when the wallet can, else the proof
 * transaction) and posts it. The session cookie comes back on the response. A non-2xx answer throws its `message`.
 */
export const login = async (
  adapter: WalletAdapter,
  p: { app: string; base?: string; name?: string; fetch?: typeof fetch },
): Promise<{ address: string; name?: string }> => {
  const call = p.fetch ?? fetch;
  const base = p.base ?? "";
  const read = async <T>(res: Response): Promise<T> => {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
    return body as T;
  };
  const { challenge, message } = await read<{ challenge: string; message: string }>(await call(`${base}/api/auth/challenge`, { credentials: "include" }));
  if (message !== loginMessage(p.app, challenge)) throw new Error("the server's login message is not this app's");

  let credential: Record<string, string>;
  if (adapter.capabilities?.signMessage !== false) {
    const { signature, publicKey } = await adapter.signMessage(message);
    credential = { signature, publicKey };
  } else {
    const account = await adapter.getAccount();
    if (!account) throw new Error("the wallet is not connected");
    const signed = await adapter.sign(loginProofTx({ app: p.app, challenge, account: account.address }) as never);
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
