import { Effect } from "effect";
import { decodeAccountId, encodeAccountId } from "../address.js";
import { bytesToHex, concatBytes, hexToBytes } from "../crypto/hex.js";
import { CodecError } from "../errors.js";
import { decimalUInt64Fields } from "./definitions.js";

type Reason = CodecError["reason"];

export const fail = (reason: Reason, message: string, field: string) => new CodecError({ reason, message: `${field}: ${message}`, field });

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const hexBytes = (value: unknown, field: string, length?: number): Effect.Effect<Uint8Array, CodecError> =>
  typeof value !== "string"
    ? Effect.fail(fail("bad_type", "expected a hex string", field))
    : hexToBytes(value).pipe(
        Effect.mapError(() => fail("bad_type", "not an even-length hex string", field)),
        Effect.filterOrFail(
          (b) => length === undefined || b.length === length,
          () => fail("bad_length", `expected ${length} bytes`, field),
        ),
      );

export const accountBytes = (value: unknown, field: string): Effect.Effect<Uint8Array, CodecError> =>
  typeof value !== "string"
    ? Effect.fail(fail("bad_type", "expected a classic address", field))
    : decodeAccountId(value).pipe(Effect.mapError((e) => fail("bad_type", e.message, field)));

export const accountString = (bytes: Uint8Array, field: string): Effect.Effect<string, CodecError> =>
  encodeAccountId(bytes).pipe(Effect.mapError((e) => fail("bad_type", e.message, field)));

// ---- integers

export const uint = (value: unknown, bytes: 1 | 2 | 4, field: string): Effect.Effect<Uint8Array, CodecError> => {
  if (typeof value !== "number" || !Number.isInteger(value)) return Effect.fail(fail("bad_type", "expected an integer", field));
  if (value < 0 || value >= 2 ** (8 * bytes)) return Effect.fail(fail("out_of_range", `does not fit in ${8 * bytes} bits`, field));
  return Effect.succeed(beBytes(value, bytes));
};

export const int32 = (value: unknown, field: string): Effect.Effect<Uint8Array, CodecError> => {
  if (typeof value !== "number" || !Number.isInteger(value)) return Effect.fail(fail("bad_type", "expected an integer", field));
  if (value < -(2 ** 31) || value >= 2 ** 31) return Effect.fail(fail("out_of_range", "does not fit in 32 signed bits", field));
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value);
  return Effect.succeed(out);
};

const beBytes = (value: number, n: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let i = n - 1, v = value; i >= 0; i--, v = Math.floor(v / 256)) out[i] = v % 256;
  return out;
};

const be64 = (n: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n);
  return out;
};

const U64_MAX = (1n << 64n) - 1n;

/** Hex string (rippled's form) or, for the few amount-like fields, a decimal string. */
export const uint64 = (value: unknown, field: string): Effect.Effect<Uint8Array, CodecError> => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return Effect.succeed(be64(BigInt(value)));
  if (typeof value !== "string") return Effect.fail(fail("bad_type", "expected a hex string", field));
  const decimal = decimalUInt64Fields.has(field);
  if (!(decimal ? /^\d{1,20}$/ : /^[0-9a-fA-F]{1,16}$/).test(value)) return Effect.fail(fail("bad_type", decimal ? "expected a decimal string" : "expected 1-16 hex digits", field));
  const n = BigInt(decimal ? value : `0x${value}`);
  return n > U64_MAX ? Effect.fail(fail("out_of_range", "does not fit in 64 bits", field)) : Effect.succeed(be64(n));
};

export const uint64ToJson = (bytes: Uint8Array, field: string): string => {
  const n = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0);
  return decimalUInt64Fields.has(field) ? n.toString() : bytesToHex(bytes);
};

// ---- currency

const ISO = /^[A-Za-z0-9?!@#$%^&*(){}[\]|]{3}$/;

/** 3-char codes sit at bytes 12-14; 40 hex digits are taken as is. "XRP" is the all-zero code. */
export const currencyBytes = (value: unknown, field: string): Effect.Effect<Uint8Array, CodecError> => {
  if (typeof value !== "string") return Effect.fail(fail("bad_type", "expected a currency code", field));
  if (value.length === 40) return hexBytes(value, field, 20);
  if (!ISO.test(value)) return Effect.fail(fail("bad_type", "currency must be 3 standard characters or 40 hex digits", field));
  const out = new Uint8Array(20);
  if (value !== "XRP") for (let i = 0; i < 3; i++) out[12 + i] = value.charCodeAt(i);
  return Effect.succeed(out);
};

export const isXrpCurrency = (bytes: Uint8Array): boolean => bytes.every((b) => b === 0);

/** Where an MPT issue puts the issuer's account: 19 zero bytes and a 1. */
export const NO_ACCOUNT = Uint8Array.of(...new Array<number>(19).fill(0), 1);

export const currencyToJson = (bytes: Uint8Array): string => {
  if (isXrpCurrency(bytes)) return "XRP";
  const code = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!);
  const standard = bytes.every((b, i) => b === 0 || (i >= 12 && i < 15)) && ISO.test(code) && code !== "XRP";
  return standard ? code : bytesToHex(bytes);
};

// ---- amounts

const MAX_DROPS = 10n ** 17n;
const MAX_MPT = (1n << 63n) - 1n;
const MPT_POSITIVE = 0x60; // lead byte: positive + MPT flags
const POSITIVE = 1n << 62n;
const NOT_XRP = 1n << 63n;
const MANTISSA_BITS = (1n << 54n) - 1n;
const MIN_MANTISSA = 10n ** 15n;
const MAX_MANTISSA = 10n ** 16n - 1n;
const IOU_VALUE = /^([-+]?)(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/;

/** Amount fields that ripple-binary-codec encodes as SignedAmount: a native delta that may be negative (positive bit clear). */
const SIGNED_DROPS = new Set(["FeeAmountDelta"]);

const nativeAmount = (value: string, field: string): Effect.Effect<Uint8Array, CodecError> => {
  if (!/^-?\d+$/.test(value)) return Effect.fail(fail("bad_type", "XRP amount must be an integer string of drops", field));
  const drops = BigInt(value);
  const signed = SIGNED_DROPS.has(field);
  if ((!signed && value.startsWith("-")) || (drops < 0n ? -drops : drops) > MAX_DROPS)
    return Effect.fail(fail("out_of_range", `XRP amount must be ${signed ? "-10^17" : "0"}..10^17 drops`, field));
  return Effect.succeed(drops < 0n ? be64(-drops) : be64(drops | POSITIVE));
};

const iouValue = (value: unknown, field: string): Effect.Effect<Uint8Array, CodecError> => {
  const m = typeof value === "string" ? IOU_VALUE.exec(value) : null;
  if (!m) return Effect.fail(fail("bad_type", "IOU value must be a decimal string", field));
  const [, sign, int, frac = "", exp = "0"] = m;
  let digits = (int! + frac).replace(/^0+/, "");
  if (digits === "") return Effect.succeed(be64(NOT_XRP)); // zero has one encoding, sign dropped
  const trimmed = digits.replace(/0+$/, "");
  const decimalExp = Number(exp) - frac.length + (digits.length - trimmed.length);
  digits = trimmed;
  if (digits.length > 16) return Effect.fail(fail("out_of_range", "IOU value has more than 16 significant digits", field));
  const exponent = decimalExp - (16 - digits.length);
  if (exponent < -96 || exponent > 80) return Effect.fail(fail("out_of_range", "IOU exponent out of range", field));
  const mantissa = BigInt(digits) * 10n ** BigInt(16 - digits.length);
  return Effect.succeed(be64(NOT_XRP | (sign === "-" ? 0n : POSITIVE) | (BigInt(exponent + 97) << 54n) | mantissa));
};

const mptAmount = (value: Record<string, unknown>, field: string): Effect.Effect<Uint8Array, CodecError> =>
  Effect.gen(function* () {
    if (Object.keys(value).sort().join() !== "mpt_issuance_id,value") return yield* fail("bad_type", "MPT amount needs exactly mpt_issuance_id and value", field);
    if (typeof value.value !== "string" || !/^\d+$/.test(value.value)) return yield* fail("bad_type", "MPT value must be a decimal string of whole units", field);
    const units = BigInt(value.value);
    if (units > MAX_MPT) return yield* fail("out_of_range", "MPT value must be 0..2^63-1", field);
    return concatBytes(Uint8Array.of(MPT_POSITIVE), be64(units), yield* hexBytes(value.mpt_issuance_id, field, 24));
  });

export const amountBytes = (value: unknown, field: string): Effect.Effect<Uint8Array, CodecError> =>
  Effect.gen(function* () {
    if (typeof value === "string") return yield* nativeAmount(value, field);
    if (!isRecord(value)) return yield* fail("bad_type", "expected drops string, {currency, issuer, value} or {mpt_issuance_id, value}", field);
    if ("mpt_issuance_id" in value) return yield* mptAmount(value, field);
    if (Object.keys(value).sort().join() !== "currency,issuer,value") return yield* fail("bad_type", "IOU amount needs exactly currency, issuer and value", field);
    const currency = yield* currencyBytes(value.currency, field);
    if (isXrpCurrency(currency)) return yield* fail("bad_type", "XRP is not an issued currency", field);
    return concatBytes(yield* iouValue(value.value, field), currency, yield* accountBytes(value.issuer, field));
  });

/** Plain decimal text, shortest form (what ripple-binary-codec prints; never exponent notation in range). */
const decimalString = (negative: boolean, mantissa: bigint, exponent: number): string => {
  let digits = mantissa.toString();
  const trimmed = digits.replace(/0+$/, "");
  exponent += digits.length - trimmed.length;
  digits = trimmed;
  const point = digits.length + exponent;
  const body = exponent >= 0 ? digits + "0".repeat(exponent) : point > 0 ? `${digits.slice(0, point)}.${digits.slice(point)}` : `0.${"0".repeat(-point)}${digits}`;
  return negative ? `-${body}` : body;
};

/** Bytes in the amount that starts with this lead byte: IOU 48, MPT 33, XRP 8. */
export const amountWidth = (lead: number): number => (lead & 0x80 ? 48 : lead & 0x20 ? 33 : 8);

type AmountJson = string | { value: string; currency: string; issuer: string } | { value: string; mpt_issuance_id: string };

/** `bytes` is exactly one amount: 8 bytes (XRP), 33 (MPT) or 48 (IOU). */
export const amountToJson = (bytes: Uint8Array, field: string): Effect.Effect<AmountJson, CodecError> =>
  Effect.gen(function* () {
    if (bytes.length === 33) {
      const units = new DataView(bytes.buffer, bytes.byteOffset + 1, 8).getBigUint64(0);
      if (bytes[0] !== MPT_POSITIVE) return yield* fail("bad_type", "MPT amount must be positive with no other flags", field);
      if (units > MAX_MPT) return yield* fail("out_of_range", "MPT value must be 0..2^63-1", field);
      return { value: units.toString(), mpt_issuance_id: bytesToHex(bytes.subarray(9)) };
    }
    const v = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0);
    if (!(v & NOT_XRP)) {
      const drops = v & ~POSITIVE;
      const negative = !(v & POSITIVE);
      if ((negative && (!SIGNED_DROPS.has(field) || drops === 0n)) || drops > MAX_DROPS)
        return yield* fail("out_of_range", "XRP amount must be 0..10^17 drops", field);
      return negative ? `-${drops}` : drops.toString();
    }
    const mantissa = v & MANTISSA_BITS;
    const currency = currencyToJson(bytes.subarray(8, 28));
    const issuer = yield* accountString(bytes.subarray(28, 48), field);
    if (mantissa === 0n) {
      // rippled's STAmount reader takes a zero only with offset 512 (exactly 0x8000…); other bit patterns re-encode to it and would change the signed bytes.
      if (v !== NOT_XRP) return yield* fail("out_of_range", "IOU zero must be encoded as 0x8000000000000000", field);
      return { value: "0", currency, issuer };
    }
    const exponent = Number((v >> 54n) & 0xffn) - 97;
    if (mantissa < MIN_MANTISSA || mantissa > MAX_MANTISSA || exponent < -96 || exponent > 80) return yield* fail("out_of_range", "IOU amount is not normalized", field);
    return { value: decimalString(!(v & POSITIVE), mantissa, exponent), currency, issuer };
  });
