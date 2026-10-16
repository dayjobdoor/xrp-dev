import { ed25519 as curve } from "@noble/curves/ed25519.js";
import { Effect } from "effect";
import { CryptoError } from "../errors.js";

// Curve math is @noble/curves. Verification is RFC 8032 strict (zip215: false): S < L, canonical point encodings,
// small-order public keys rejected. noble checks the cofactored equation; rippled/donna's is cofactorless.
const VERIFY_OPTS = { zip215: false } as const;

/**
 * The 32 key bytes (without the XRPL `ED` prefix) are a canonical encoding of a curve point.
 * Small-order points (e.g. the identity) still pass here; `verify` rejects them.
 */
export const isValidPublicKey = (publicKey: Uint8Array): boolean => curve.utils.isValidPublicKey(publicKey, false);

const badKey = () => new CryptoError({ reason: "bad_key", message: "ed25519 private key must be 32 bytes" });

export const getPublicKey = (privateKey: Uint8Array): Effect.Effect<Uint8Array, CryptoError> =>
  curve.utils.isValidSecretKey(privateKey) ? Effect.sync(() => curve.getPublicKey(privateKey)) : Effect.fail(badKey());

export const sign = (message: Uint8Array, privateKey: Uint8Array): Effect.Effect<Uint8Array, CryptoError> =>
  curve.utils.isValidSecretKey(privateKey) ? Effect.sync(() => curve.sign(message, privateKey)) : Effect.fail(badKey());

/** False for anything malformed: wrong lengths, S >= L, non-canonical or small-order public key. */
export const verify = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Effect.Effect<boolean> => {
  if (signature.length !== 64 || publicKey.length !== 32) return Effect.succeed(false);
  return Effect.succeed(curve.verify(signature, message, publicKey, VERIFY_OPTS));
};
