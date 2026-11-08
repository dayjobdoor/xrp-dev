import { decodeAccountId, deriveAccountId, encodeAccountId } from "./address.js";
import * as ed25519 from "./crypto/ed25519.js";
import { sha512Half } from "./crypto/hash.js";
import { bytesToHex, concatBytes, hexToBytes } from "./crypto/hex.js";
import * as secp256k1 from "./crypto/secp256k1.js";
import { decodeBytes } from "./codec/decode.js";
import { type Definitions, XRPL_DEFINITIONS } from "./codec/definitions.js";
import { encodeObject } from "./codec/encode.js";
import { accountBytes, hexBytes, isRecord } from "./codec/values.js";
import { AddressError, CodecError, CryptoError } from "./errors.js";

export { CodecError };
export type { Definitions } from "./codec/definitions.js";
export { XRPL_DEFINITIONS, makeDefinitions } from "./codec/definitions.js";

/** Transaction / ledger object in rippled's JSON form. */
export type TxJson = Record<string, unknown>;

const SIGN = Uint8Array.of(0x53, 0x54, 0x58, 0x00); // "STX\0"
const MULTISIGN = Uint8Array.of(0x53, 0x4d, 0x54, 0x00); // "SMT\0"
const TX_ID = Uint8Array.of(0x54, 0x58, 0x4e, 0x00); // "TXN\0"
// rippled refuses more signers than a signer list holds; without the cap one blob buys unbounded signature checks.
const MAX_SIGNERS = 32;

/** Throws `CodecError` for a field or value the codec cannot serialize. */
export const encode = (json: TxJson, defs: Definitions = XRPL_DEFINITIONS): string => bytesToHex(encodeObject(json, false, defs));

/** Throws `CodecError` for bytes that are not a canonical serialization. */
export const decode = (hex: string, defs: Definitions = XRPL_DEFINITIONS): TxJson => decodeBytes(hexBytes(hex, "hex"), defs);

/** `STX\0` + the signing fields only (TxnSignature, Signers, … dropped). */
export const encodeForSigning = (json: TxJson, defs: Definitions = XRPL_DEFINITIONS): Uint8Array => concatBytes(SIGN, encodeObject(json, true, defs));

/** `SMT\0` + signing fields with SigningPubKey emptied + the signer's AccountID. */
export const encodeForMultisigning = (json: TxJson, signerAccount: string, defs: Definitions = XRPL_DEFINITIONS): Uint8Array => {
  const body = encodeObject({ ...json, SigningPubKey: "" }, true, defs);
  return concatBytes(MULTISIGN, body, accountBytes(signerAccount, "signerAccount"));
};

/** Transaction ID: sha512Half(`TXN\0` + signed blob). */
export const hashTransaction = (blobHex: string): string => bytesToHex(sha512Half(concatBytes(TX_ID, hexBytes(blobHex, "blob"))));

// What a malformed signature, key or address becomes in a verification: no bytes, so the check is false.
const orEmpty = (f: () => Uint8Array): Uint8Array => {
  try {
    return f();
  } catch (e) {
    if (e instanceof CryptoError || e instanceof AddressError) return new Uint8Array();
    throw e;
  }
};

// rippled accepts only 33-byte keys: 02/03 (secp256k1, compressed) or ED (ed25519).
const verifyBytes = (signature: Uint8Array, data: Uint8Array, publicKey: Uint8Array): boolean =>
  publicKey.length !== 33
    ? false
    : publicKey[0] === 0xed
      ? ed25519.verify(signature, data, publicKey.slice(1))
      : publicKey[0] === 2 || publicKey[0] === 3
        ? secp256k1.verify(signature, sha512Half(data), publicKey)
        : false;

/**
 * True when the blob is signed the way rippled requires and every signature verifies. Single-signed: non-empty
 * `SigningPubKey` and `TxnSignature`, no `Signers`. Multisigned: empty `SigningPubKey`, no `TxnSignature`, 1 to 32
 * `Signers` (rippled's limit) strictly ascending by AccountID (so unique), and each entry verifies against its own
 * key. Anything else is false, except a blob that does not decode, which throws `CodecError`.
 * It does not check that the key is authorised for `Account` (see `signerMatchesAccount`).
 */
export const verifyTransaction = (blob: string, defs: Definitions = XRPL_DEFINITIONS): boolean => {
  const tx = decode(blob, defs);
  // The signature is checked over the re-encoding, so a non-canonical blob would verify bytes other than the ones submitted.
  if (encode(tx, defs).toLowerCase() !== blob.toLowerCase()) return false;
  const { TxnSignature, Signers, ...rest } = tx;
  const hex = (h: unknown) => (typeof h === "string" ? orEmpty(() => hexToBytes(h)) : new Uint8Array());
  const pubKey = typeof rest.SigningPubKey === "string" ? rest.SigningPubKey : "";
  const hasTxnSig = typeof TxnSignature === "string" && TxnSignature.length > 0;
  if (pubKey.length > 0) {
    if (!hasTxnSig || Signers !== undefined) return false;
    return verifyBytes(hex(TxnSignature), encodeForSigning(rest, defs), hex(pubKey));
  }
  if (hasTxnSig || !Array.isArray(Signers) || Signers.length === 0 || Signers.length > MAX_SIGNERS) return false;
  let previous = "";
  for (const entry of Signers as unknown[]) {
    const s = isRecord(entry) && isRecord(entry.Signer) ? entry.Signer : undefined;
    if (!s || typeof s.Account !== "string") return false;
    const account = s.Account;
    const id = bytesToHex(orEmpty(() => decodeAccountId(account)));
    if (id <= previous) return false; // also rejects an undecodable (empty) account
    previous = id;
    const data = encodeForMultisigning(rest, account, defs);
    if (!verifyBytes(hex(s.TxnSignature), data, hex(s.SigningPubKey))) return false;
  }
  return true;
};

/** True when a single-signed blob's `SigningPubKey` is the master key of its `Account`. Throws `CodecError` if the blob does not decode. */
export const signerMatchesAccount = (blob: string, defs: Definitions = XRPL_DEFINITIONS): boolean => {
  const tx = decode(blob, defs);
  const publicKey = orEmpty(() => hexToBytes(String(tx.SigningPubKey ?? "")));
  if (publicKey.length !== 33) return false;
  let address = "";
  try {
    address = encodeAccountId(deriveAccountId(publicKey));
  } catch (e) {
    if (!(e instanceof AddressError)) throw e;
  }
  return address === tx.Account;
};
