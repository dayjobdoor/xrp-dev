import { Effect } from "effect";
import { CryptoError } from "../errors.js";
import { sha256 } from "./hash.js";
import { concatBytes, equalBytes } from "./hex.js";

/** XRPL's alphabet (not Bitcoin's): `r` is zero. */
const ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export const base58Encode = (bytes: Uint8Array): string => {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)]! + out;
    n /= 58n;
  }
  return ALPHABET[0]!.repeat(zeros) + out;
};

// The longest XRPL base58 string (X-address) is 47 characters; the cap keeps the BigInt work bounded.
const MAX_BASE58 = 128;

export const base58Decode = (text: string): Effect.Effect<Uint8Array, CryptoError> => {
  if (text.length > MAX_BASE58) return Effect.fail(new CryptoError({ reason: "bad_length", message: "base58 input is too long" }));
  let n = 0n;
  for (const c of text) {
    const v = INDEX.get(c);
    if (v === undefined) return Effect.fail(new CryptoError({ reason: "bad_base58", message: `invalid base58 character: ${JSON.stringify(c)}` }));
    n = n * 58n + v;
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === ALPHABET[0]) zeros++;
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Effect.succeed(Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]));
};

const checksum = (payload: Uint8Array) =>
  sha256(payload).pipe(
    Effect.flatMap(sha256),
    Effect.map((h) => h.slice(0, 4)),
  );

export const base58CheckEncode = (payload: Uint8Array): Effect.Effect<string> =>
  checksum(payload).pipe(Effect.map((c) => base58Encode(concatBytes(payload, c))));

export const base58CheckDecode = (text: string): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.gen(function* () {
    const raw = yield* base58Decode(text);
    if (raw.length < 5) return yield* new CryptoError({ reason: "bad_length", message: "base58check input is too short" });
    const payload = raw.slice(0, -4);
    if (!equalBytes(yield* checksum(payload), raw.slice(-4))) return yield* new CryptoError({ reason: "bad_checksum", message: "base58check checksum mismatch" });
    return payload;
  });
