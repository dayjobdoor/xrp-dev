import * as base58 from "../crypto/base58.js";
import * as hash from "../crypto/hash.js";
import { hexToBytes as plainHexToBytes } from "../crypto/hex.js";
import { CryptoError } from "../errors.js";
import { lift, liftTotal } from "./lift.js";

// Re-exported as they are: these cannot throw, or are constants. Everything that can throw goes through `lift`.
export { base58Encode } from "../crypto/base58.js";
export { bytesToHex, concatBytes } from "../crypto/hex.js";
export { ripemd160 } from "@noble/hashes/legacy.js";
export * as secp256k1 from "./secp256k1.js";
export * as ed25519 from "./ed25519.js";
export { CryptoError } from "../errors.js";

const fails = /* @__PURE__ */ lift(CryptoError);

export const base58Decode = /* @__PURE__ */ fails(base58.base58Decode);
export const base58CheckEncode = /* @__PURE__ */ liftTotal(base58.base58CheckEncode);
export const base58CheckDecode = /* @__PURE__ */ fails(base58.base58CheckDecode);
export const hexToBytes = /* @__PURE__ */ fails(plainHexToBytes);
export const sha256 = /* @__PURE__ */ liftTotal(hash.sha256);
export const sha512 = /* @__PURE__ */ liftTotal(hash.sha512);
/** First 32 bytes of SHA-512: XRPL's hash for signing, transaction IDs and key derivation. */
export const sha512Half = /* @__PURE__ */ liftTotal(hash.sha512Half);
