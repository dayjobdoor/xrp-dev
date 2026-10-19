import xrplRaw from "./definitions.json" with { type: "json" };

/** The XRPL `server_definitions` snapshot (regenerate with `scripts/definitions.ts`). */
export const definitions = xrplRaw;

export interface Field {
  readonly name: string;
  readonly type: string;
  readonly ordinal: number; // (type code << 16) | field code: the canonical sort key
  readonly header: Uint8Array;
  readonly isVL: boolean;
  readonly isSerialized: boolean;
  readonly isSigning: boolean;
}

interface RawField {
  readonly nth: number;
  readonly type: string;
  readonly isVLEncoded: boolean;
  readonly isSerialized: boolean;
  readonly isSigningField: boolean;
}

/** XRPL field ID: 1 byte if both codes < 16, 2 if one is, 3 if neither. */
const fieldHeader = (type: number, nth: number): Uint8Array =>
  type < 16 ? (nth < 16 ? Uint8Array.of((type << 4) | nth) : Uint8Array.of(type << 4, nth)) : nth < 16 ? Uint8Array.of(nth, type) : Uint8Array.of(0, type, nth);

export interface Enum {
  readonly code: ReadonlyMap<string, number>;
  readonly name: ReadonlyMap<number, string>;
}

/** The tables the codec reads. One per ledger (XRPL, Xahau, ...); pass it as the last argument of encode/decode. */
export interface Definitions {
  readonly fieldByName: ReadonlyMap<string, Field>;
  /** Only serialized fields: they are the only ones that appear on the wire. */
  readonly fieldByOrdinal: ReadonlyMap<number, Field>;
  /** Fields whose integer value is shown by name. */
  readonly enumByField: ReadonlyMap<string, Enum>;
}

/** The five tables of a `server_definitions` response. */
export interface RawDefinitions {
  readonly TYPES: Readonly<Record<string, number>>;
  readonly FIELDS: unknown;
  readonly TRANSACTION_TYPES: Readonly<Record<string, number>>;
  readonly LEDGER_ENTRY_TYPES: Readonly<Record<string, number>>;
  readonly TRANSACTION_RESULTS: Readonly<Record<string, number>>;
}

const toField = (types: Readonly<Record<string, number>>, [name, f]: readonly [string, RawField]): Field => {
  const typeCode = types[f.type] ?? -2;
  return {
    name,
    type: f.type,
    ordinal: typeCode * 65536 + f.nth,
    header: fieldHeader(typeCode, f.nth),
    isVL: f.isVLEncoded,
    // Xahau's server_definitions marks the object/array end markers as not serialized; they are on the wire on both ledgers.
    isSerialized: f.isSerialized || name.endsWith("EndMarker"),
    isSigning: f.isSigningField,
  };
};

const makeEnum = (table: Readonly<Record<string, number>>): Enum => ({
  code: new Map(Object.entries(table)),
  name: new Map(Object.entries(table).map(([k, v]) => [v, k])),
});

// Delegation permissions are not in server_definitions: rippled's granular ones, then every tx type + 1.
const GRANULAR_PERMISSIONS = {
  TrustlineAuthorize: 65537,
  TrustlineFreeze: 65538,
  TrustlineUnfreeze: 65539,
  AccountDomainSet: 65540,
  AccountEmailHashSet: 65541,
  AccountMessageKeySet: 65542,
  AccountTransferRateSet: 65543,
  AccountTickSizeSet: 65544,
  PaymentMint: 65545,
  PaymentBurn: 65546,
  MPTokenIssuanceLock: 65547,
  MPTokenIssuanceUnlock: 65548,
};

export const makeDefinitions = (raw: RawDefinitions): Definitions => {
  const fields = (raw.FIELDS as unknown as ReadonlyArray<readonly [string, RawField]>).map((e) => toField(raw.TYPES, e));
  return {
    fieldByName: new Map(fields.map((f) => [f.name, f])),
    fieldByOrdinal: new Map(fields.filter((f) => f.isSerialized).map((f) => [f.ordinal, f])),
    enumByField: new Map([
      ["TransactionType", makeEnum(raw.TRANSACTION_TYPES)],
      ["LedgerEntryType", makeEnum(raw.LEDGER_ENTRY_TYPES)],
      ["TransactionResult", makeEnum(raw.TRANSACTION_RESULTS)],
      [
        "PermissionValue",
        makeEnum({ ...GRANULAR_PERMISSIONS, ...Object.fromEntries(Object.entries(raw.TRANSACTION_TYPES).map(([k, v]) => [k, v + 1])) }),
      ],
    ]),
  };
};

export const XRPL_DEFINITIONS: Definitions = makeDefinitions(xrplRaw);

/** UInt64 fields rippled shows as decimal rather than hex. */
export const decimalUInt64Fields: ReadonlySet<string> = new Set([
  "MaximumAmount",
  "OutstandingAmount",
  "MPTAmount",
  "LockedAmount",
  "ConfidentialOutstandingAmount",
]);
