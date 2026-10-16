import { Effect } from "effect";
import { CryptoError } from "../errors.js";

const HEX = "0123456789ABCDEF";

/** Upper-case hex, the form rippled uses. */
export const bytesToHex = (bytes: Uint8Array): string => {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
};

const isHex = (hex: string) => hex.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(hex);

/** For hex the caller already validated (internal use). */
export const unsafeHexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const hexToBytes = (hex: string): Effect.Effect<Uint8Array, CryptoError> =>
  isHex(hex) ? Effect.succeed(unsafeHexToBytes(hex)) : Effect.fail(new CryptoError({ reason: "bad_hex", message: "not an even-length hex string" }));

export const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
