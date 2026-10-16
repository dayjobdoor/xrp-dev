import raw from "./definitions.json" with { type: "json" };

/** The `server_definitions` snapshot (regenerate with `scripts/definitions.ts`). */
export const definitions = raw;

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

const types: Record<string, number> = raw.TYPES;

const toField = ([name, f]: readonly [string, RawField]): Field => {
  const typeCode = types[f.type] ?? -2;
  return {
    name,
    type: f.type,
    ordinal: typeCode * 65536 + f.nth,
    header: fieldHeader(typeCode, f.nth),
    isVL: f.isVLEncoded,
    isSerialized: f.isSerialized,
    isSigning: f.isSigningField,
  };
};

const fields = (raw.FIELDS as unknown as ReadonlyArray<readonly [string, RawField]>).map(toField);

export const fieldByName: ReadonlyMap<string, Field> = new Map(fields.map((f) => [f.name, f]));
/** Only serialized fields: they are the only ones that appear on the wire. */
export const fieldByOrdinal: ReadonlyMap<number, Field> = new Map(fields.filter((f) => f.isSerialized).map((f) => [f.ordinal, f]));

export interface Enum {
  readonly code: ReadonlyMap<string, number>;
  readonly name: ReadonlyMap<number, string>;
}

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

/** Fields whose integer value is shown by name. */
export const enumByField: ReadonlyMap<string, Enum> = new Map([
  ["TransactionType", makeEnum(raw.TRANSACTION_TYPES)],
  ["LedgerEntryType", makeEnum(raw.LEDGER_ENTRY_TYPES)],
  ["TransactionResult", makeEnum(raw.TRANSACTION_RESULTS)],
  [
    "PermissionValue",
    makeEnum({ ...GRANULAR_PERMISSIONS, ...Object.fromEntries(Object.entries(raw.TRANSACTION_TYPES).map(([k, v]) => [k, v + 1])) }),
  ],
]);

/** UInt64 fields rippled shows as decimal rather than hex. */
export const decimalUInt64Fields: ReadonlySet<string> = new Set([
  "MaximumAmount",
  "OutstandingAmount",
  "MPTAmount",
  "LockedAmount",
  "ConfidentialOutstandingAmount",
]);
