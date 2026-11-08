import { sha256 as nobleSha256, sha512 as nobleSha512 } from "@noble/hashes/sha2.js";

export const sha256 = (data: Uint8Array): Uint8Array => nobleSha256(data);
export const sha512 = (data: Uint8Array): Uint8Array => nobleSha512(data);
/** First 32 bytes of SHA-512: XRPL's hash for signing, transaction IDs and key derivation. */
export const sha512Half = (data: Uint8Array): Uint8Array => nobleSha512(data).slice(0, 32);
