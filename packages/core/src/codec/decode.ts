import { Effect } from "effect";
import { bytesToHex, concatBytes, equalBytes } from "../crypto/hex.js";
import type { CodecError } from "../errors.js";
import { type Field, enumByField, fieldByOrdinal } from "./definitions.js";
import { numberToJson } from "./number.js";
import { NO_ACCOUNT, accountString, amountToJson, amountWidth, currencyToJson, fail, isXrpCurrency, uint64ToJson } from "./values.js";

interface Reader {
  readonly bytes: Uint8Array;
  pos: number;
  depth: number;
}

// rippled nests STObjects/STArrays only a few levels (metadata is the deepest).
const MAX_DEPTH = 16;

type Decoded<A> = Effect.Effect<A, CodecError>;

const HASH_BYTES: Record<string, number> = { Hash128: 16, Hash160: 20, Hash192: 24, Hash256: 32 };
const UINT_BYTES: Record<string, number> = { UInt8: 1, UInt16: 2, UInt32: 4 };

const take = (r: Reader, n: number, field = "binary"): Decoded<Uint8Array> => {
  if (r.pos + n > r.bytes.length) return Effect.fail(fail("bad_length", "unexpected end of data", field));
  r.pos += n;
  return Effect.succeed(r.bytes.subarray(r.pos - n, r.pos));
};

const u8 = (r: Reader): Decoded<number> => take(r, 1).pipe(Effect.map((b) => b[0]!));

const readField = (r: Reader): Decoded<Field> =>
  Effect.gen(function* () {
    const first = yield* u8(r);
    let type = first >> 4;
    let nth = first & 15;
    // A zero nibble means "next byte", which must then be >= 16 (anything else is non-canonical).
    if (type === 0 && (type = yield* u8(r)) < 16) return yield* fail("bad_type", "non-canonical field id", "binary");
    if (nth === 0 && (nth = yield* u8(r)) < 16) return yield* fail("bad_type", "non-canonical field id", "binary");
    const f = fieldByOrdinal.get(type * 65536 + nth);
    return f ?? (yield* fail("unknown_field", `unknown field (type ${type}, code ${nth})`, "binary"));
  });

const readLength = (r: Reader): Decoded<number> =>
  Effect.gen(function* () {
    const b1 = yield* u8(r);
    if (b1 <= 192) return b1;
    if (b1 <= 240) return 193 + (b1 - 193) * 256 + (yield* u8(r));
    if (b1 <= 254) {
      const b2 = yield* u8(r);
      return 12481 + (b1 - 241) * 65536 + b2 * 256 + (yield* u8(r));
    }
    return yield* fail("bad_length", "invalid variable-length prefix", "binary");
  });

/** An MPT issue is the issuer, the no-account marker and the little-endian sequence; its id is the sequence (big-endian) then the issuer. */
const issue = (r: Reader, field: string): Decoded<{ currency: string; issuer?: string } | { mpt_issuance_id: string }> =>
  Effect.gen(function* () {
    const first = yield* take(r, 20, field);
    if (isXrpCurrency(first)) return { currency: "XRP" };
    const second = yield* take(r, 20, field);
    if (equalBytes(second, NO_ACCOUNT)) {
      const sequence = (yield* take(r, 4, field)).slice().reverse();
      return { mpt_issuance_id: bytesToHex(concatBytes(sequence, first)) };
    }
    return { currency: currencyToJson(first), issuer: yield* accountString(second, field) };
  });

const xchainBridge = (r: Reader, field: string): Decoded<Record<string, unknown>> =>
  Effect.gen(function* () {
    const door = function* () {
      if ((yield* u8(r)) !== 20) return yield* fail("bad_length", "bridge door must be 20 bytes", field);
      return yield* accountString(yield* take(r, 20, field), field);
    };
    return {
      LockingChainDoor: yield* door(),
      LockingChainIssue: yield* issue(r, field),
      IssuingChainDoor: yield* door(),
      IssuingChainIssue: yield* issue(r, field),
    };
  });

const pathSet = (r: Reader, field: string): Decoded<unknown[][]> =>
  Effect.gen(function* () {
    const paths: Record<string, string>[][] = [];
    let path: Record<string, string>[] = [];
    for (;;) {
      const type = yield* u8(r);
      if (type === 0x00 || type === 0xff) {
        if (path.length === 0 && (type === 0xff || paths.length > 0)) return yield* fail("bad_length", "empty path", field);
        if (path.length > 0) paths.push(path);
        if (type === 0x00) return paths;
        path = [];
        continue;
      }
      if (type & ~0x31) return yield* fail("bad_type", `invalid path hop type 0x${type.toString(16)}`, field);
      const hop: Record<string, string> = {};
      if (type & 0x01) hop.account = yield* accountString(yield* take(r, 20, field), field);
      if (type & 0x10) hop.currency = currencyToJson(yield* take(r, 20, field));
      if (type & 0x20) hop.issuer = yield* accountString(yield* take(r, 20, field), field);
      path.push(hop);
    }
  });

const stArray = (r: Reader, field: string): Decoded<unknown[]> =>
  Effect.gen(function* () {
    const out: unknown[] = [];
    for (;;) {
      const f = yield* readField(r);
      if (f.name === "ArrayEndMarker") return out;
      if (f.type !== "STObject" || f.name === "ObjectEndMarker") return yield* fail("bad_type", `${f.name} cannot be an array element`, field);
      out.push({ [f.name]: yield* decodeObject(r, true) });
    }
  });

const lengthPrefixed = (f: Field, data: Uint8Array): Decoded<unknown> => {
  switch (f.type) {
    case "Blob":
      return Effect.succeed(bytesToHex(data));
    case "AccountID":
      return data.length === 20 ? accountString(data, f.name) : Effect.fail(fail("bad_length", "AccountID must be 20 bytes", f.name));
    case "Vector256":
      return data.length % 32 === 0
        ? Effect.succeed(Array.from({ length: data.length / 32 }, (_, i) => bytesToHex(data.subarray(i * 32, i * 32 + 32))))
        : Effect.fail(fail("bad_length", "Vector256 length must be a multiple of 32", f.name));
    default:
      return Effect.fail(fail("bad_type", `${f.type} fields are not supported`, f.name));
  }
};

const value = (f: Field, r: Reader): Decoded<unknown> =>
  Effect.gen(function* () {
    if (f.isVL) return yield* lengthPrefixed(f, yield* take(r, yield* readLength(r), f.name));
    const width = UINT_BYTES[f.type];
    if (width !== undefined) {
      const n = (yield* take(r, width, f.name)).reduce((acc, b) => acc * 256 + b, 0);
      const names = enumByField.get(f.name);
      if (names === undefined) return n;
      return names.name.get(n) ?? (yield* fail("bad_type", `unknown ${f.name} code ${n}`, f.name));
    }
    const hashWidth = HASH_BYTES[f.type];
    if (hashWidth !== undefined) return bytesToHex(yield* take(r, hashWidth, f.name));
    switch (f.type) {
      case "UInt64":
        return uint64ToJson(yield* take(r, 8, f.name), f.name);
      case "Amount": {
        const lead = (yield* take(r, 1, f.name))[0]!;
        r.pos--;
        return yield* amountToJson(yield* take(r, amountWidth(lead), f.name), f.name);
      }
      case "Int32": {
        const b = yield* take(r, 4, f.name);
        return new DataView(b.buffer, b.byteOffset, 4).getInt32(0);
      }
      case "Number":
        return numberToJson(yield* take(r, 12, f.name));
      case "Currency":
        return currencyToJson(yield* take(r, 20, f.name));
      case "Issue":
        return yield* issue(r, f.name);
      case "XChainBridge":
        return yield* xchainBridge(r, f.name);
      case "PathSet":
        return yield* pathSet(r, f.name);
      case "STArray":
        return yield* stArray(r, f.name);
      case "STObject":
        return yield* decodeObject(r, true);
      default:
        return yield* fail("bad_type", `${f.type} fields are not supported`, f.name);
    }
  });

/** Nested objects end with an 0xE1 marker; the top level ends with the data. Fields must be strictly ascending. */
const decodeObject = (r: Reader, nested: boolean): Decoded<Record<string, unknown>> =>
  Effect.gen(function* () {
    if (nested && ++r.depth > MAX_DEPTH) return yield* fail("bad_length", "objects nested too deeply", "binary");
    const out: Record<string, unknown> = {};
    let last = -1;
    while (r.pos < r.bytes.length || nested) {
      const f = yield* readField(r);
      if (f.name === "ObjectEndMarker") {
        if (nested) {
          r.depth--;
          return out;
        }
        return yield* fail("bad_type", "unexpected object end marker", f.name);
      }
      if (f.name === "ArrayEndMarker") return yield* fail("bad_type", "unexpected array end marker", f.name);
      if (f.ordinal <= last) return yield* fail("bad_type", "fields out of order or duplicated", f.name);
      last = f.ordinal;
      out[f.name] = yield* value(f, r);
    }
    return out;
  });

export const decodeBytes = (bytes: Uint8Array): Decoded<Record<string, unknown>> => decodeObject({ bytes, pos: 0, depth: 0 }, false);
