import { bytesToHex, concatBytes, equalBytes } from "../crypto/hex.js";
import { type Definitions, type Field, XRPL_DEFINITIONS } from "./definitions.js";
import { numberToJson } from "./number.js";
import { NO_ACCOUNT, accountString, amountToJson, amountWidth, currencyToJson, fail, isXrpCurrency, uint64ToJson } from "./values.js";

interface Reader {
  readonly bytes: Uint8Array;
  pos: number;
  depth: number;
}

// rippled nests STObjects/STArrays only a few levels (metadata is the deepest).
const MAX_DEPTH = 16;

const HASH_BYTES: Record<string, number> = { Hash128: 16, Hash160: 20, Hash192: 24, Hash256: 32 };
const UINT_BYTES: Record<string, number> = { UInt8: 1, UInt16: 2, UInt32: 4 };

const take = (r: Reader, n: number, field = "binary"): Uint8Array => {
  if (r.pos + n > r.bytes.length) return fail("bad_length", "unexpected end of data", field);
  r.pos += n;
  return r.bytes.subarray(r.pos - n, r.pos);
};

const u8 = (r: Reader): number => take(r, 1)[0]!;

const readField = (r: Reader, d: Definitions): Field => {
  const first = u8(r);
  let type = first >> 4;
  let nth = first & 15;
  // A zero nibble means "next byte", which must then be >= 16 (anything else is non-canonical).
  if (type === 0 && (type = u8(r)) < 16) return fail("bad_type", "non-canonical field id", "binary");
  if (nth === 0 && (nth = u8(r)) < 16) return fail("bad_type", "non-canonical field id", "binary");
  const f = d.fieldByOrdinal.get(type * 65536 + nth);
  return f ?? (fail("unknown_field", `unknown field (type ${type}, code ${nth})`, "binary"));
};

const readLength = (r: Reader): number => {
  const b1 = u8(r);
  if (b1 <= 192) return b1;
  if (b1 <= 240) return 193 + (b1 - 193) * 256 + u8(r);
  if (b1 <= 254) {
    const b2 = u8(r);
    return 12481 + (b1 - 241) * 65536 + b2 * 256 + u8(r);
  }
  return fail("bad_length", "invalid variable-length prefix", "binary");
};

/** An MPT issue is the issuer, the no-account marker and the little-endian sequence; its id is the sequence (big-endian) then the issuer. */
const issue = (r: Reader, field: string): { currency: string; issuer?: string } | { mpt_issuance_id: string } => {
  const first = take(r, 20, field);
  if (isXrpCurrency(first)) return { currency: "XRP" };
  const second = take(r, 20, field);
  if (equalBytes(second, NO_ACCOUNT)) {
    const sequence = take(r, 4, field).slice().reverse();
    return { mpt_issuance_id: bytesToHex(concatBytes(sequence, first)) };
  }
  return { currency: currencyToJson(first), issuer: accountString(second, field) };
};

const xchainBridge = (r: Reader, field: string): Record<string, unknown> => {
  const door = (): string => {
    if (u8(r) !== 20) return fail("bad_length", "bridge door must be 20 bytes", field);
    return accountString(take(r, 20, field), field);
  };
  return {
    LockingChainDoor: door(),
    LockingChainIssue: issue(r, field),
    IssuingChainDoor: door(),
    IssuingChainIssue: issue(r, field),
  };
};

const pathSet = (r: Reader, field: string): unknown[][] => {
  const paths: Record<string, string>[][] = [];
  let path: Record<string, string>[] = [];
  for (;;) {
    const type = u8(r);
    if (type === 0x00 || type === 0xff) {
      if (path.length === 0 && (type === 0xff || paths.length > 0)) return fail("bad_length", "empty path", field);
      if (path.length > 0) paths.push(path);
      if (type === 0x00) return paths;
      path = [];
      continue;
    }
    if (type & ~0x31) return fail("bad_type", `invalid path hop type 0x${type.toString(16)}`, field);
    const hop: Record<string, string> = {};
    if (type & 0x01) hop.account = accountString(take(r, 20, field), field);
    if (type & 0x10) hop.currency = currencyToJson(take(r, 20, field));
    if (type & 0x20) hop.issuer = accountString(take(r, 20, field), field);
    path.push(hop);
  }
};

const stArray = (r: Reader, field: string, d: Definitions): unknown[] => {
  const out: unknown[] = [];
  for (;;) {
    const f = readField(r, d);
    if (f.name === "ArrayEndMarker") return out;
    if (f.type !== "STObject" || f.name === "ObjectEndMarker") return fail("bad_type", `${f.name} cannot be an array element`, field);
    out.push({ [f.name]: decodeObject(r, true, d) });
  }
};

const lengthPrefixed = (f: Field, data: Uint8Array): unknown => {
  switch (f.type) {
    case "Blob":
      return bytesToHex(data);
    case "AccountID":
      return data.length === 20 ? accountString(data, f.name) : fail("bad_length", "AccountID must be 20 bytes", f.name);
    case "Vector256":
      return data.length % 32 === 0
        ? Array.from({ length: data.length / 32 }, (_, i) => bytesToHex(data.subarray(i * 32, i * 32 + 32)))
        : fail("bad_length", "Vector256 length must be a multiple of 32", f.name);
    default:
      return fail("bad_type", `${f.type} fields are not supported`, f.name);
  }
};

const value = (f: Field, r: Reader, d: Definitions): unknown => {
  if (f.isVL) return lengthPrefixed(f, take(r, readLength(r), f.name));
  const width = UINT_BYTES[f.type];
  if (width !== undefined) {
    const n = take(r, width, f.name).reduce((acc, b) => acc * 256 + b, 0);
    const names = d.enumByField.get(f.name);
    if (names === undefined) return n;
    return names.name.get(n) ?? (fail("bad_type", `unknown ${f.name} code ${n}`, f.name));
  }
  const hashWidth = HASH_BYTES[f.type];
  if (hashWidth !== undefined) return bytesToHex(take(r, hashWidth, f.name));
  switch (f.type) {
    case "UInt64":
      return uint64ToJson(take(r, 8, f.name), f.name);
    case "Amount": {
      const lead = take(r, 1, f.name)[0]!;
      r.pos--;
      return amountToJson(take(r, amountWidth(lead), f.name), f.name);
    }
    case "Int32": {
      const b = take(r, 4, f.name);
      return new DataView(b.buffer, b.byteOffset, 4).getInt32(0);
    }
    case "Number":
      return numberToJson(take(r, 12, f.name));
    case "Currency":
      return currencyToJson(take(r, 20, f.name));
    case "Issue":
      return issue(r, f.name);
    case "XChainBridge":
      return xchainBridge(r, f.name);
    case "PathSet":
      return pathSet(r, f.name);
    case "STArray":
      return stArray(r, f.name, d);
    case "STObject":
      return decodeObject(r, true, d);
    default:
      return fail("bad_type", `${f.type} fields are not supported`, f.name);
  }
};

/** Nested objects end with an 0xE1 marker; the top level ends with the data. Fields must be strictly ascending. */
const decodeObject = (r: Reader, nested: boolean, d: Definitions): Record<string, unknown> => {
  if (nested && ++r.depth > MAX_DEPTH) return fail("bad_length", "objects nested too deeply", "binary");
  const out: Record<string, unknown> = {};
  let last = -1;
  while (r.pos < r.bytes.length || nested) {
    const f = readField(r, d);
    if (f.name === "ObjectEndMarker") {
      if (nested) {
        r.depth--;
        return out;
      }
      return fail("bad_type", "unexpected object end marker", f.name);
    }
    if (f.name === "ArrayEndMarker") return fail("bad_type", "unexpected array end marker", f.name);
    if (f.ordinal <= last) return fail("bad_type", "fields out of order or duplicated", f.name);
    last = f.ordinal;
    out[f.name] = value(f, r, d);
  }
  return out;
};

export const decodeBytes = (bytes: Uint8Array, d: Definitions = XRPL_DEFINITIONS): Record<string, unknown> =>
  decodeObject({ bytes, pos: 0, depth: 0 }, false, d);
