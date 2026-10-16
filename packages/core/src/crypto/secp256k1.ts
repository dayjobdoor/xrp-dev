import { secp256k1 as curve } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/utils.js";
import { Effect } from "effect";
import { CryptoError } from "../errors.js";

// Curve math is @noble/curves. XRPL rules it does not enforce by itself (SHA-512-Half digests, no sha256 prehash,
// rippled's 8..72 DER length bound, 32-byte digests) are applied here.
const { Fn } = curve.Point;
export const n = Fn.ORDER;
const SIG_OPTS = { prehash: false, lowS: true, format: "der" } as const;

export const isValidPrivateKey = (k: Uint8Array): boolean => curve.utils.isValidSecretKey(k);

/** 33-byte compressed or 65-byte uncompressed SEC1 point on the curve (never the identity). */
export const isValidPublicKey = (publicKey: Uint8Array): boolean => curve.utils.isValidPublicKey(publicKey);

/** (a + b) mod n as 32 bytes; XRPL family-seed derivation adds root and intermediate keys. */
export const addScalars = (a: Uint8Array, b: Uint8Array): Uint8Array => numberToBytesBE(Fn.create(bytesToNumberBE(a) + bytesToNumberBE(b)), 32);

const badKey = new CryptoError({ reason: "bad_key", message: "private key must be 32 bytes in 1..n-1" });

export const getPublicKey = (privateKey: Uint8Array): Effect.Effect<Uint8Array, CryptoError> =>
  isValidPrivateKey(privateKey) ? Effect.sync(() => curve.getPublicKey(privateKey, true)) : Effect.fail(badKey);

/** DER signature over a 32-byte digest: RFC 6979 nonce, low-S. */
export const sign = (digest: Uint8Array, privateKey: Uint8Array): Effect.Effect<Uint8Array, CryptoError> =>
  digest.length !== 32
    ? Effect.fail(new CryptoError({ reason: "bad_length", message: "digest must be 32 bytes" }))
    : !isValidPrivateKey(privateKey)
      ? Effect.fail(badKey)
      : Effect.sync(() => curve.sign(digest, privateKey, SIG_OPTS));

/** False for anything malformed, off-curve, or high-S (XRPL requires canonical signatures). */
export const verify = (signature: Uint8Array, digest: Uint8Array, publicKey: Uint8Array): Effect.Effect<boolean> => {
  // noble's DER parser only caps at 80 bytes and throws on bad types; rippled's ecdsaCanonicality caps at 72.
  if (digest.length !== 32 || signature.length < 8 || signature.length > 72) return Effect.succeed(false);
  try {
    return Effect.succeed(curve.verify(signature, digest, publicKey, SIG_OPTS));
  } catch {
    return Effect.succeed(false);
  }
};
