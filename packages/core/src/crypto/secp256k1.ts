import { secp256k1 as curve } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/utils.js";
import { CryptoError } from "../errors.js";

// XRPL rules @noble/curves does not enforce by itself (SHA-512-Half digests, no sha256 prehash,
// rippled's 8..72 DER length bound, 32-byte digests) are applied here.
// The group order, written out: reading it from `curve.Point` at module level keeps the whole curve in every bundle that
// imports this file, even one that never signs (the client imports the codec only for `encode`). A test pins it to noble's.
export const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SIG_OPTS = { prehash: false, lowS: true, format: "der" } as const;

export const isValidPrivateKey = (k: Uint8Array): boolean => curve.utils.isValidSecretKey(k);

/** 33-byte compressed or 65-byte uncompressed SEC1 point on the curve (never the identity). */
export const isValidPublicKey = (publicKey: Uint8Array): boolean => curve.utils.isValidPublicKey(publicKey);

/** (a + b) mod n as 32 bytes; XRPL family-seed derivation adds root and intermediate keys. */
export const addScalars = (a: Uint8Array, b: Uint8Array): Uint8Array => numberToBytesBE((bytesToNumberBE(a) + bytesToNumberBE(b)) % n, 32);

const checkKey = (privateKey: Uint8Array) => {
  if (!isValidPrivateKey(privateKey)) throw new CryptoError({ reason: "bad_key", message: "private key must be 32 bytes in 1..n-1" });
};

/** Compressed public key. Throws `CryptoError` (`bad_key`) for a key outside 1..n-1. */
export const getPublicKey = (privateKey: Uint8Array): Uint8Array => (checkKey(privateKey), curve.getPublicKey(privateKey, true));

/** DER signature over a 32-byte digest: RFC 6979 nonce, low-S. Throws `CryptoError` (`bad_length`, `bad_key`). */
export const sign = (digest: Uint8Array, privateKey: Uint8Array): Uint8Array => {
  if (digest.length !== 32) throw new CryptoError({ reason: "bad_length", message: "digest must be 32 bytes" });
  checkKey(privateKey);
  return curve.sign(digest, privateKey, SIG_OPTS);
};

/** False for anything malformed, off-curve, or high-S (XRPL requires canonical signatures). */
export const verify = (signature: Uint8Array, digest: Uint8Array, publicKey: Uint8Array): boolean => {
  // noble's DER parser only caps at 80 bytes and throws on bad types; rippled's ecdsaCanonicality caps at 72.
  if (digest.length !== 32 || signature.length < 8 || signature.length > 72) return false;
  try {
    return curve.verify(signature, digest, publicKey, SIG_OPTS);
  } catch {
    return false;
  }
};
