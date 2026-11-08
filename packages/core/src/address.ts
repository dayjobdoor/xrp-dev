import { ripemd160 } from "@noble/hashes/legacy.js";
import { base58CheckDecode, base58CheckEncode } from "./crypto/base58.js";
import { isValidPublicKey as isValidEd25519Key } from "./crypto/ed25519.js";
import { sha256 } from "./crypto/hash.js";
import { concatBytes, equalBytes, hexToBytes } from "./crypto/hex.js";
import { isValidPublicKey } from "./crypto/secp256k1.js";
import { AddressError, CryptoError } from "./errors.js";

export { AddressError };

// Version bytes: they make the base58 text start with `r` (account), `s` (secp256k1 seed), `sEd` (ed25519 seed), `X` / `T` (X-address).
const ACCOUNT_ID = Uint8Array.of(0x00);
const FAMILY_SEED = Uint8Array.of(0x21);
const ED25519_SEED = Uint8Array.of(0x01, 0xe1, 0x4b);
const X_MAIN = Uint8Array.of(0x05, 0x44);
const X_TEST = Uint8Array.of(0x04, 0x93);
const MAX_TAG = 0xffffffff;

export type Algorithm = "secp256k1" | "ed25519";

// base58 and hex failures are CryptoErrors; an address caller sees them as AddressErrors, the original kept as `cause`.
const asAddressError = (e: CryptoError, reason: AddressError["reason"]) => new AddressError({ reason, message: e.message, cause: e });

const checkedDecode = (text: string): Uint8Array => {
  try {
    return base58CheckDecode(text);
  } catch (e) {
    if (e instanceof CryptoError) throw asAddressError(e, e.reason === "bad_checksum" ? "bad_checksum" : "bad_encoding");
    throw e;
  }
};

/** RIPEMD160(SHA256(publicKey)); ed25519 keys carry their 0xED prefix. */
export const deriveAccountId = (publicKey: Uint8Array): Uint8Array => ripemd160(sha256(publicKey));

/** Account address of a 33-byte key: `0xED` + ed25519 key, or a compressed secp256k1 point on the curve. Anything else throws `AddressError`. */
export const publicKeyToAddress = (publicKey: string | Uint8Array): string => {
  let bytes: Uint8Array;
  if (typeof publicKey === "string") {
    try {
      bytes = hexToBytes(publicKey);
    } catch (e) {
      if (e instanceof CryptoError) throw asAddressError(e, "bad_encoding");
      throw e;
    }
  } else bytes = publicKey;
  if (bytes.length !== 33) throw new AddressError({ reason: "bad_length", message: "public key must be 33 bytes" });
  if (!(bytes[0] === 0xed ? isValidEd25519Key(bytes.subarray(1)) : (bytes[0] === 2 || bytes[0] === 3) && isValidPublicKey(bytes)))
    throw new AddressError({ reason: "bad_key", message: "not an ed25519 (ED…) or valid compressed secp256k1 public key" });
  return encodeAccountId(deriveAccountId(bytes));
};

const encodeVersioned = (version: Uint8Array, payload: Uint8Array, length: number, what: string): string => {
  if (payload.length !== length) throw new AddressError({ reason: "bad_length", message: `${what} must be ${length} bytes` });
  return base58CheckEncode(concatBytes(version, payload));
};

const decodeVersioned = (text: string, version: Uint8Array, length: number, what: string): Uint8Array => {
  const raw = checkedDecode(text);
  if (raw.length !== version.length + length || !equalBytes(raw.slice(0, version.length), version))
    throw new AddressError({ reason: "bad_version", message: `not a ${what}` });
  return raw.slice(version.length);
};

export const encodeAccountId = (accountId: Uint8Array): string => encodeVersioned(ACCOUNT_ID, accountId, 20, "AccountID");
export const decodeAccountId = (address: string): Uint8Array => decodeVersioned(address, ACCOUNT_ID, 20, "classic address");

/** Never throws for a string: anything that does not decode is `false`. */
export const isValidClassicAddress = (address: string): boolean => {
  try {
    decodeAccountId(address);
    return true;
  } catch (e) {
    if (e instanceof AddressError) return false;
    throw e;
  }
};

export const encodeSeed = (entropy: Uint8Array, algorithm: Algorithm): string =>
  encodeVersioned(algorithm === "ed25519" ? ED25519_SEED : FAMILY_SEED, entropy, 16, "seed entropy");

/** `sEd…` is ed25519, any other `s…` seed is secp256k1. */
export const decodeSeed = (seed: string): { entropy: Uint8Array; algorithm: Algorithm } => {
  try {
    return { entropy: decodeVersioned(seed, ED25519_SEED, 16, "seed"), algorithm: "ed25519" };
  } catch (e) {
    if (!(e instanceof AddressError)) throw e;
  }
  return { entropy: decodeVersioned(seed, FAMILY_SEED, 16, "seed"), algorithm: "secp256k1" };
};

/** X-address (XLS-5d): prefix, AccountID, tag flag, 32-bit tag (little-endian) and 4 reserved zero bytes. */
export const classicToXAddress = (address: string, tag: number | false, test: boolean): string => {
  if (tag !== false && !(Number.isInteger(tag) && tag >= 0 && tag <= MAX_TAG))
    throw new AddressError({ reason: "bad_tag", message: "tag must be an integer from 0 to 4294967295" });
  const accountId = decodeAccountId(address);
  const t = tag === false ? 0 : tag;
  const flags = Uint8Array.of(tag === false ? 0 : 1, t & 0xff, (t >>> 8) & 0xff, (t >>> 16) & 0xff, (t >>> 24) & 0xff, 0, 0, 0, 0);
  return base58CheckEncode(concatBytes(test ? X_TEST : X_MAIN, accountId, flags));
};

export const xAddressToClassic = (xAddress: string): { classicAddress: string; tag: number | false; test: boolean } => {
  const raw = checkedDecode(xAddress);
  if (raw.length !== 31) throw new AddressError({ reason: "bad_length", message: "X-address payload must be 31 bytes" });
  const prefix = raw.slice(0, 2);
  const test = equalBytes(prefix, X_TEST);
  if (!test && !equalBytes(prefix, X_MAIN)) throw new AddressError({ reason: "bad_version", message: "not an X-address" });
  const flag = raw[22];
  const tag = new DataView(raw.buffer, raw.byteOffset + 23, 4).getUint32(0, true);
  const reservedZero = raw.slice(27).every((b) => b === 0);
  if (!reservedZero || (flag !== 0 && flag !== 1) || (flag === 0 && tag !== 0))
    throw new AddressError({ reason: "bad_tag", message: "unsupported X-address tag encoding" });
  return { classicAddress: encodeAccountId(raw.slice(2, 22)), tag: flag === 1 ? tag : false, test };
};
