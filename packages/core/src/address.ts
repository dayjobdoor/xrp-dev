import { Effect } from "effect";
import { base58CheckDecode, base58CheckEncode } from "./crypto/base58.js";
import { sha256 } from "./crypto/hash.js";
import { concatBytes, equalBytes, hexToBytes } from "./crypto/hex.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { isValidPublicKey as isValidEd25519Key } from "./crypto/ed25519.js";
import { isValidPublicKey } from "./crypto/secp256k1.js";
import { AddressError } from "./errors.js";

export { AddressError };

const ACCOUNT_ID = Uint8Array.of(0x00);
const FAMILY_SEED = Uint8Array.of(0x21);
const ED25519_SEED = Uint8Array.of(0x01, 0xe1, 0x4b);
const X_MAIN = Uint8Array.of(0x05, 0x44);
const X_TEST = Uint8Array.of(0x04, 0x93);
const MAX_TAG = 0xffffffff;

export type Algorithm = "secp256k1" | "ed25519";

/** RIPEMD160(SHA256(publicKey)); ed25519 keys carry their 0xED prefix. */
export const deriveAccountId = (publicKey: Uint8Array): Effect.Effect<Uint8Array> => sha256(publicKey).pipe(Effect.map(ripemd160));

/** Account address of a 33-byte key: `0xED` + ed25519 key, or a compressed secp256k1 point on the curve. Anything else fails. */
export const publicKeyToAddress = (publicKey: string | Uint8Array): Effect.Effect<string, AddressError> =>
  Effect.gen(function* () {
    const bytes =
      typeof publicKey === "string"
        ? yield* hexToBytes(publicKey).pipe(Effect.mapError((e) => new AddressError({ reason: "bad_encoding", message: e.message })))
        : publicKey;
    if (bytes.length !== 33) return yield* new AddressError({ reason: "bad_length", message: "public key must be 33 bytes" });
    if (!(bytes[0] === 0xed ? isValidEd25519Key(bytes.subarray(1)) : (bytes[0] === 2 || bytes[0] === 3) && isValidPublicKey(bytes)))
      return yield* new AddressError({ reason: "bad_key", message: "not an ed25519 (ED…) or valid compressed secp256k1 public key" });
    return yield* deriveAccountId(bytes).pipe(Effect.flatMap(encodeAccountId));
  });

const encodeVersioned = (version: Uint8Array, payload: Uint8Array, length: number, what: string) =>
  payload.length === length
    ? base58CheckEncode(concatBytes(version, payload))
    : Effect.fail(new AddressError({ reason: "bad_length", message: `${what} must be ${length} bytes` }));

const decodeVersioned = (text: string, version: Uint8Array, length: number, what: string) =>
  Effect.gen(function* () {
    const raw = yield* base58CheckDecode(text).pipe(
      Effect.mapError((e) => new AddressError({ reason: e.reason === "bad_checksum" ? "bad_checksum" : "bad_encoding", message: e.message })),
    );
    if (raw.length !== version.length + length || !equalBytes(raw.slice(0, version.length), version))
      return yield* new AddressError({ reason: "bad_version", message: `not a ${what}` });
    return raw.slice(version.length);
  });

export const encodeAccountId = (accountId: Uint8Array): Effect.Effect<string, AddressError> => encodeVersioned(ACCOUNT_ID, accountId, 20, "AccountID");
export const decodeAccountId = (address: string): Effect.Effect<Uint8Array, AddressError> => decodeVersioned(address, ACCOUNT_ID, 20, "classic address");
export const isValidClassicAddress = (address: string): Effect.Effect<boolean> =>
  decodeAccountId(address).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

export const encodeSeed = (entropy: Uint8Array, algorithm: Algorithm): Effect.Effect<string, AddressError> =>
  encodeVersioned(algorithm === "ed25519" ? ED25519_SEED : FAMILY_SEED, entropy, 16, "seed entropy");

/** `sEd…` is ed25519, any other `s…` seed is secp256k1. */
export const decodeSeed = (seed: string): Effect.Effect<{ entropy: Uint8Array; algorithm: Algorithm }, AddressError> =>
  decodeVersioned(seed, ED25519_SEED, 16, "seed").pipe(
    Effect.map((entropy) => ({ entropy, algorithm: "ed25519" as const })),
    Effect.catch(() => decodeVersioned(seed, FAMILY_SEED, 16, "seed").pipe(Effect.map((entropy) => ({ entropy, algorithm: "secp256k1" as const })))),
  );

/** X-address (XLS-5d): prefix, AccountID, tag flag, 32-bit tag (little-endian) and 4 reserved zero bytes. */
export const classicToXAddress = (address: string, tag: number | false, test: boolean): Effect.Effect<string, AddressError> =>
  Effect.gen(function* () {
    if (tag !== false && !(Number.isInteger(tag) && tag >= 0 && tag <= MAX_TAG))
      return yield* new AddressError({ reason: "bad_tag", message: "tag must be an integer from 0 to 4294967295" });
    const accountId = yield* decodeAccountId(address);
    const t = tag === false ? 0 : tag;
    const flags = Uint8Array.of(tag === false ? 0 : 1, t & 0xff, (t >>> 8) & 0xff, (t >>> 16) & 0xff, (t >>> 24) & 0xff, 0, 0, 0, 0);
    return yield* base58CheckEncode(concatBytes(test ? X_TEST : X_MAIN, accountId, flags));
  });

export const xAddressToClassic = (xAddress: string): Effect.Effect<{ classicAddress: string; tag: number | false; test: boolean }, AddressError> =>
  Effect.gen(function* () {
    const raw = yield* base58CheckDecode(xAddress).pipe(
      Effect.mapError((e) => new AddressError({ reason: e.reason === "bad_checksum" ? "bad_checksum" : "bad_encoding", message: e.message })),
    );
    if (raw.length !== 31) return yield* new AddressError({ reason: "bad_length", message: "X-address payload must be 31 bytes" });
    const prefix = raw.slice(0, 2);
    const test = equalBytes(prefix, X_TEST);
    if (!test && !equalBytes(prefix, X_MAIN)) return yield* new AddressError({ reason: "bad_version", message: "not an X-address" });
    const flag = raw[22];
    const tag = new DataView(raw.buffer, raw.byteOffset + 23, 4).getUint32(0, true);
    const reservedZero = raw.slice(27).every((b) => b === 0);
    if (!reservedZero || (flag !== 0 && flag !== 1) || (flag === 0 && tag !== 0))
      return yield* new AddressError({ reason: "bad_tag", message: "unsupported X-address tag encoding" });
    const classicAddress = yield* encodeAccountId(raw.slice(2, 22));
    return { classicAddress, tag: flag === 1 ? tag : false, test };
  });
