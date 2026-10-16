import { Effect } from "effect";

// crypto.subtle wants an ArrayBuffer-backed view; copying also detaches us from the caller's buffer.
const digest = (algorithm: "SHA-256" | "SHA-512", data: Uint8Array) =>
  Effect.promise(() => crypto.subtle.digest(algorithm, new Uint8Array(data))).pipe(Effect.map((b) => new Uint8Array(b)));

export const sha256 = (data: Uint8Array): Effect.Effect<Uint8Array> => digest("SHA-256", data);
export const sha512 = (data: Uint8Array): Effect.Effect<Uint8Array> => digest("SHA-512", data);
/** First 32 bytes of SHA-512: XRPL's hash for signing, transaction IDs and key derivation. */
export const sha512Half = (data: Uint8Array): Effect.Effect<Uint8Array> => sha512(data).pipe(Effect.map((h) => h.slice(0, 32)));

