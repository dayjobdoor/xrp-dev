import { Effect } from "effect";
import type { CodecError } from "../errors.js";
import { fail } from "./values.js";

// STNumber as ripple-binary-codec has it: an 8-byte signed mantissa and a 4-byte signed exponent, both big-endian.
// Normalisation, rounding and formatting follow that implementation step for step, so the bytes and strings agree.
const MIN_MANTISSA = 10n ** 18n;
const MAX_MANTISSA = 10n ** 19n - 1n;
const MAX_INT64 = (1n << 63n) - 1n;
const MIN_EXPONENT = -32768;
const MAX_EXPONENT = 32768;
const ZERO_EXPONENT = -(2 ** 31); // zero is a zero mantissa with this exponent
const NUMBER = /^([-+]?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;

const toBytes = (mantissa: bigint, exponent: number): Uint8Array => {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setBigInt64(0, mantissa);
  view.setInt32(8, exponent);
  return out;
};

/** A decimal string ("12", "-1.5", "3e-7") as an STNumber; anything rippled's parser rejects, or that cannot be scaled into range, fails. */
export const numberBytes = (value: unknown, field: string): Effect.Effect<Uint8Array, CodecError> =>
  Effect.gen(function* () {
    const match = typeof value === "string" ? NUMBER.exec(value) : null;
    if (!match) return yield* fail("bad_type", "expected a decimal string like -1.5e3", field);
    const [, sign, int, frac = "", exp = "0"] = match;
    const significant = (int! + frac).replace(/^0+/, "");
    if (significant === "") return toBytes(0n, ZERO_EXPONENT);
    let digits = significant.replace(/0+$/, "");
    let exponent = Number(exp) - frac.length + (significant.length - digits.length);
    // Only the first 20 digits can matter (19 kept, the 20th rounds), so a huge string cannot make the loops below slow.
    if (digits.length > 20) {
      exponent += digits.length - 20;
      digits = digits.slice(0, 20);
    }
    let mantissa = BigInt(digits);
    while (mantissa < MIN_MANTISSA && exponent > MIN_EXPONENT) {
      exponent--;
      mantissa *= 10n;
    }
    let dropped = -1n; // the last digit shifted out; 5 or more rounds up
    const drop = () => {
      exponent++;
      dropped = mantissa % 10n;
      mantissa /= 10n;
    };
    while (mantissa > MAX_MANTISSA) {
      if (exponent >= MAX_EXPONENT) return yield* fail("out_of_range", "Number is too large", field);
      drop();
    }
    if (exponent < MIN_EXPONENT || mantissa < MIN_MANTISSA) return yield* fail("out_of_range", "Number is too small", field);
    if (exponent > MAX_EXPONENT) return yield* fail("out_of_range", "Number is too large", field);
    if (mantissa > MAX_INT64) {
      if (exponent >= MAX_EXPONENT) return yield* fail("out_of_range", "Number is too large", field);
      drop();
    }
    if (dropped >= 5n) {
      mantissa++;
      if (mantissa > MAX_INT64) {
        if (exponent >= MAX_EXPONENT) return yield* fail("out_of_range", "Number is too large", field);
        drop();
        if (dropped >= 5n) mantissa++;
      }
    }
    return toBytes(sign === "-" ? -mantissa : mantissa, exponent);
  });

/**
 * `bytes` is the 12 bytes of one STNumber. Plain decimal for exponents -28..-8 and 0, `<digits>e<exp>` otherwise, as
 * ripple-binary-codec prints it. Its plain branch assumes a 19-digit mantissa, though, so it misprints a mantissa below
 * 10^17 (-1e-7 as -10000000000); here the point is placed by value. Every canonical encoding prints identically.
 */
export const numberToJson = (bytes: Uint8Array): string => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 12);
  const mantissa = view.getBigInt64(0);
  let exponent = view.getInt32(8);
  if (mantissa === 0n && exponent === ZERO_EXPONENT) return "0";
  const sign = mantissa < 0n ? "-" : "";
  let abs = mantissa < 0n ? -mantissa : mantissa;
  // A mantissa below 10^18 was shrunk to fit an int64 (or comes from the smaller range): scale it back up.
  if (abs !== 0n && abs < MIN_MANTISSA) {
    abs *= 10n;
    exponent--;
  }
  if (exponent !== 0 && (exponent < -28 || exponent > -8)) {
    while (abs !== 0n && abs % 10n === 0n && exponent < MAX_EXPONENT) {
      abs /= 10n;
      exponent++;
    }
    return `${sign}${abs}e${exponent}`;
  }
  const digits = abs.toString();
  const point = digits.length + exponent; // digits before the decimal point; <= 0 means "0.000ddd"
  const whole = point > 0 ? digits.slice(0, point) : "0";
  const fraction = (point > 0 ? digits.slice(point) : "0".repeat(-point) + digits).replace(/0+$/, "");
  return `${sign}${whole}${fraction === "" ? "" : `.${fraction}`}`;
};
