import { Effect } from "effect";
import { concatBytes } from "../crypto/hex.js";
import { CodecError } from "../errors.js";
import { type Field, enumByField, fieldByName } from "./definitions.js";
import { numberBytes } from "./number.js";
import { NO_ACCOUNT, accountBytes, amountBytes, currencyBytes, fail, hexBytes, int32, isRecord, isXrpCurrency, uint, uint64 } from "./values.js";

const OBJECT_END = Uint8Array.of(0xe1);
const ARRAY_END = Uint8Array.of(0xf1);
const HASH_BYTES: Record<string, number> = { Hash128: 16, Hash160: 20, Hash192: 24, Hash256: 32 };

type Encoded = Effect.Effect<Uint8Array, CodecError>;

/** Variable-length prefix: 1 byte up to 192, 2 up to 12480, 3 up to 918744. */
const withLength = (body: Uint8Array, field: string): Encoded => {
  const n = body.length;
  let prefix: number[];
  if (n <= 192) prefix = [n];
  else if (n <= 12480) prefix = [193 + ((n - 193) >> 8), (n - 193) & 0xff];
  else if (n <= 918744) prefix = [241 + ((n - 12481) >> 16), ((n - 12481) >> 8) & 0xff, (n - 12481) & 0xff];
  else return Effect.fail(fail("bad_length", `${n} bytes exceeds the 918744-byte variable-length limit`, field));
  return Effect.succeed(concatBytes(Uint8Array.from(prefix), body));
};

const array = (value: unknown, field: string): Effect.Effect<readonly unknown[], CodecError> =>
  Array.isArray(value) ? Effect.succeed(value) : Effect.fail(fail("bad_type", "expected an array", field));

/** `{ currency }` (XRP), `{ currency, issuer }`, or `{ mpt_issuance_id }`: issuer, the no-account marker and the sequence little-endian. */
const issue = (value: unknown, field: string): Encoded =>
  Effect.gen(function* () {
    if (!isRecord(value)) return yield* fail("bad_type", "expected {currency, issuer?} or {mpt_issuance_id}", field);
    const shape = Object.keys(value).sort().join();
    if (shape === "mpt_issuance_id") {
      const id = yield* hexBytes(value.mpt_issuance_id, field, 24);
      return concatBytes(id.subarray(4), NO_ACCOUNT, id.slice(0, 4).reverse());
    }
    if (shape !== "currency" && shape !== "currency,issuer") return yield* fail("bad_type", "expected {currency}, {currency, issuer} or {mpt_issuance_id}", field);
    const currency = yield* currencyBytes(value.currency, field);
    if (shape === "currency") return isXrpCurrency(currency) ? currency : yield* fail("bad_type", "an issued currency needs an issuer", field);
    if (isXrpCurrency(currency)) return yield* fail("bad_type", "XRP has no issuer", field);
    return concatBytes(currency, yield* accountBytes(value.issuer, field));
  });

const BRIDGE_PARTS = ["LockingChainDoor", "LockingChainIssue", "IssuingChainDoor", "IssuingChainIssue"] as const;

const xchainBridge = (value: unknown, field: string): Encoded =>
  Effect.gen(function* () {
    if (!isRecord(value) || Object.keys(value).sort().join() !== [...BRIDGE_PARTS].sort().join())
      return yield* fail("bad_type", `expected ${BRIDGE_PARTS.join(", ")}`, field);
    const parts: Uint8Array[] = [];
    for (const name of BRIDGE_PARTS) {
      if (name.endsWith("Door")) parts.push(Uint8Array.of(20), yield* accountBytes(value[name], field));
      else parts.push(yield* issue(value[name], field));
    }
    return concatBytes(...parts);
  });

const HOP_KEYS = [
  ["account", 0x01],
  ["currency", 0x10],
  ["issuer", 0x20],
] as const;

const hop = (value: unknown, field: string): Encoded =>
  Effect.gen(function* () {
    // rippled adds `type`/`type_hex` to hops; they are derived from the other keys, so they are ignored.
    const keys = isRecord(value) ? Object.keys(value).filter((k) => k !== "type" && k !== "type_hex") : [];
    if (!isRecord(value) || keys.length === 0 || keys.some((k) => !HOP_KEYS.some(([n]) => n === k)))
      return yield* fail("bad_type", "a path hop has account, currency and/or issuer", field);
    let type = 0;
    const parts: Uint8Array[] = [];
    for (const [name, bit] of HOP_KEYS) {
      if (value[name] === undefined) continue;
      type |= bit;
      parts.push(yield* (name === "currency" ? currencyBytes : accountBytes)(value[name], field));
    }
    return concatBytes(Uint8Array.of(type), ...parts);
  });

/** Paths joined by 0xFF, set terminated by 0x00. */
const pathSet = (value: unknown, field: string): Encoded =>
  Effect.gen(function* () {
    const parts: Uint8Array[] = [];
    for (const path of yield* array(value, field)) {
      const hops = yield* array(path, field);
      if (hops.length === 0) return yield* fail("bad_length", "a path needs at least one hop", field);
      for (const h of hops) parts.push(yield* hop(h, field));
      parts.push(Uint8Array.of(0xff));
    }
    if (parts.length > 0) parts.pop();
    parts.push(Uint8Array.of(0x00));
    return concatBytes(...parts);
  });

const stArray = (value: unknown, field: string): Encoded =>
  Effect.gen(function* () {
    const parts: Uint8Array[] = [];
    for (const element of yield* array(value, field)) {
      const keys = isRecord(element) ? Object.keys(element) : [];
      const inner = keys.length === 1 ? fieldByName.get(keys[0]!) : undefined;
      if (!isRecord(element) || keys.length !== 1) return yield* fail("bad_type", "array elements must be single-key objects like { Memo: {...} }", field);
      if (inner === undefined) return yield* fail("unknown_field", `unknown field ${keys[0]}`, keys[0]!);
      if (inner.type !== "STObject") return yield* fail("bad_type", `${inner.name} is not an object field`, inner.name);
      parts.push(inner.header, yield* encodeObject(element[inner.name], false), OBJECT_END);
    }
    parts.push(ARRAY_END);
    return concatBytes(...parts);
  });

const integer = (f: Field, value: unknown, bytes: 1 | 2 | 4): Encoded => {
  const names = enumByField.get(f.name);
  if (names === undefined) return uint(value, bytes, f.name);
  // decode rejects codes outside the table, so a number is accepted only when it round-trips.
  if (typeof value === "number" && !names.name.has(value)) return Effect.fail(fail("bad_type", `unknown ${f.name} code ${value}`, f.name));
  if (typeof value !== "string") return uint(value, bytes, f.name);
  const code = names.code.get(value);
  return code === undefined ? Effect.fail(fail("bad_type", `unknown ${f.name} ${JSON.stringify(value)}`, f.name)) : uint(code, bytes, f.name);
};

const body = (f: Field, value: unknown): Encoded => {
  switch (f.type) {
    case "UInt8":
      return integer(f, value, 1);
    case "UInt16":
      return integer(f, value, 2);
    case "UInt32":
      return integer(f, value, 4);
    case "UInt64":
      return uint64(value, f.name);
    case "Int32":
      return int32(value, f.name);
    case "Number":
      return numberBytes(value, f.name);
    case "Hash128":
    case "Hash160":
    case "Hash192":
    case "Hash256":
      return hexBytes(value, f.name, HASH_BYTES[f.type]);
    case "Amount":
      return amountBytes(value, f.name);
    case "Blob":
      return hexBytes(value, f.name);
    case "AccountID":
      return accountBytes(value, f.name);
    case "Currency":
      return currencyBytes(value, f.name);
    case "Issue":
      return issue(value, f.name);
    case "XChainBridge":
      return xchainBridge(value, f.name);
    case "PathSet":
      return pathSet(value, f.name);
    case "STArray":
      return stArray(value, f.name);
    case "STObject":
      return encodeObject(value, false);
    case "Vector256":
      return Effect.gen(function* () {
        const hashes = yield* array(value, f.name);
        const out: Uint8Array[] = [];
        for (const h of hashes) out.push(yield* hexBytes(h, f.name, 32));
        return concatBytes(...out);
      });
    default:
      return Effect.fail(fail("bad_type", `${f.type} fields are not supported`, f.name));
  }
};

/**
 * Fields in canonical order. `signingOnly` drops non-signing fields (top level only,
 * like rippled). `undefined` and non-serialized (e.g. `hash`) fields are skipped; anything
 * else unknown is an error rather than silently dropped.
 */
export const encodeObject = (json: unknown, signingOnly: boolean): Encoded =>
  Effect.gen(function* () {
    if (!isRecord(json)) return yield* new CodecError({ reason: "bad_type", message: "expected an object" });
    const present: Field[] = [];
    for (const [name, value] of Object.entries(json)) {
      const f = fieldByName.get(name);
      if (f === undefined) return yield* fail("unknown_field", `unknown field ${name}`, name);
      if (value !== undefined && f.isSerialized && name.endsWith("EndMarker")) return yield* fail("bad_type", `${name} is a wire marker, not a field`, name);
      if (value !== undefined && f.isSerialized && (!signingOnly || f.isSigning)) present.push(f);
    }
    present.sort((a, b) => a.ordinal - b.ordinal);
    const parts: Uint8Array[] = [];
    for (const f of present) {
      const bytes = yield* body(f, json[f.name]);
      parts.push(f.header, f.isVL ? yield* withLength(bytes, f.name) : bytes);
      if (f.type === "STObject") parts.push(OBJECT_END);
    }
    return concatBytes(...parts);
  });
