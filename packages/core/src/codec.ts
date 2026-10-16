import { Effect } from "effect";
import { decodeAccountId, deriveAccountId, encodeAccountId } from "./address.js";
import * as ed25519 from "./crypto/ed25519.js";
import { sha512Half } from "./crypto/hash.js";
import { bytesToHex, concatBytes, hexToBytes } from "./crypto/hex.js";
import * as secp256k1 from "./crypto/secp256k1.js";
import { decodeBytes } from "./codec/decode.js";
import { encodeObject } from "./codec/encode.js";
import { accountBytes, hexBytes } from "./codec/values.js";
import { CodecError } from "./errors.js";

export { CodecError };

/** Transaction / ledger object in rippled's JSON form. */
export type TxJson = Record<string, unknown>;

const SIGN = Uint8Array.of(0x53, 0x54, 0x58, 0x00); // "STX\0"
const MULTISIGN = Uint8Array.of(0x53, 0x4d, 0x54, 0x00); // "SMT\0"
const TX_ID = Uint8Array.of(0x54, 0x58, 0x4e, 0x00); // "TXN\0"
// rippled refuses more signers than a signer list holds; without the cap one blob buys unbounded signature checks.
const MAX_SIGNERS = 32;

export const encode = (json: TxJson): Effect.Effect<string, CodecError> => encodeObject(json, false).pipe(Effect.map(bytesToHex));

export const decode = (hex: string): Effect.Effect<TxJson, CodecError> => hexBytes(hex, "hex").pipe(Effect.flatMap(decodeBytes));

/** `STX\0` + the signing fields only (TxnSignature, Signers, … dropped). */
export const encodeForSigning = (json: TxJson): Effect.Effect<Uint8Array, CodecError> =>
  encodeObject(json, true).pipe(Effect.map((body) => concatBytes(SIGN, body)));

/** `SMT\0` + signing fields with SigningPubKey emptied + the signer's AccountID. */
export const encodeForMultisigning = (json: TxJson, signerAccount: string): Effect.Effect<Uint8Array, CodecError> =>
  Effect.gen(function* () {
    const body = yield* encodeObject({ ...json, SigningPubKey: "" }, true);
    return concatBytes(MULTISIGN, body, yield* accountBytes(signerAccount, "signerAccount"));
  });

/** Transaction ID: sha512Half(`TXN\0` + signed blob). */
export const hashTransaction = (blobHex: string): Effect.Effect<string, CodecError> =>
  hexBytes(blobHex, "blob").pipe(
    Effect.flatMap((blob) => sha512Half(concatBytes(TX_ID, blob))),
    Effect.map(bytesToHex),
  );

// rippled accepts only 33-byte keys: 02/03 (secp256k1, compressed) or ED (ed25519).
const verifyBytes = (signature: Uint8Array, data: Uint8Array, publicKey: Uint8Array) =>
  publicKey.length !== 33
    ? Effect.succeed(false)
    : publicKey[0] === 0xed
      ? ed25519.verify(signature, data, publicKey.slice(1))
      : publicKey[0] === 2 || publicKey[0] === 3
        ? Effect.flatMap(sha512Half(data), (h) => secp256k1.verify(signature, h, publicKey))
        : Effect.succeed(false);

/**
 * True when the blob is signed the way rippled requires and every signature verifies. Single-signed: non-empty
 * `SigningPubKey` and `TxnSignature`, no `Signers`. Multisigned: empty `SigningPubKey`, no `TxnSignature`, 1 to 32
 * `Signers` (rippled's limit) strictly ascending by AccountID (so unique), and each entry verifies against its own
 * key. Anything else is false.
 * It does not check that the key is authorised for `Account` (see `signerMatchesAccount`).
 */
export const verifyTransaction = (blob: string): Effect.Effect<boolean, CodecError> =>
  Effect.gen(function* () {
    const tx = yield* decode(blob);
    // The signature is checked over the re-encoding, so a non-canonical blob would verify bytes other than the ones submitted.
    if ((yield* encode(tx)).toLowerCase() !== blob.toLowerCase()) return false;
    const { TxnSignature, Signers, ...rest } = tx as TxJson & { TxnSignature?: unknown; Signers?: unknown };
    const hex = (h: unknown) => (typeof h === "string" ? hexToBytes(h).pipe(Effect.orElseSucceed(() => new Uint8Array())) : Effect.succeed(new Uint8Array()));
    const pubKey = typeof rest.SigningPubKey === "string" ? rest.SigningPubKey : "";
    const hasTxnSig = typeof TxnSignature === "string" && TxnSignature.length > 0;
    if (pubKey.length > 0) {
      if (!hasTxnSig || Signers !== undefined) return false;
      return yield* verifyBytes(yield* hex(TxnSignature), yield* encodeForSigning(rest), yield* hex(pubKey));
    }
    if (hasTxnSig || !Array.isArray(Signers) || Signers.length === 0 || Signers.length > MAX_SIGNERS) return false;
    let previous = "";
    for (const entry of Signers as unknown[]) {
      const s = (entry as { Signer?: { Account?: unknown; SigningPubKey?: unknown; TxnSignature?: unknown } } | null)?.Signer;
      if (!s || typeof s.Account !== "string") return false;
      const id = bytesToHex(yield* decodeAccountId(s.Account).pipe(Effect.orElseSucceed(() => new Uint8Array())));
      if (id <= previous) return false; // also rejects an undecodable (empty) account
      previous = id;
      const data = yield* encodeForMultisigning(rest, s.Account);
      if (!(yield* verifyBytes(yield* hex(s.TxnSignature), data, yield* hex(s.SigningPubKey)))) return false;
    }
    return true;
  });

/** True when a single-signed blob's `SigningPubKey` is the master key of its `Account`. */
export const signerMatchesAccount = (blob: string): Effect.Effect<boolean, CodecError> =>
  Effect.gen(function* () {
    const tx = yield* decode(blob);
    const publicKey = yield* hexToBytes(String(tx.SigningPubKey ?? "")).pipe(Effect.orElseSucceed(() => new Uint8Array()));
    if (publicKey.length !== 33) return false;
    const address = yield* deriveAccountId(publicKey).pipe(Effect.flatMap(encodeAccountId), Effect.orElseSucceed(() => ""));
    return address === tx.Account;
  });
