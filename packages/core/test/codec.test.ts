import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { sha512 } from "@noble/hashes/sha2.js";
import { Effect } from "effect";
import fc from "fast-check";
import { decodeAccountID, encodeAccountID } from "ripple-address-codec";
import * as oracle from "ripple-binary-codec";
import { describe, expect, it } from "vite-plus/test";
import { decode, encode, encodeForMultisigning, encodeForSigning, hashTransaction, type TxJson } from "../src/codec.js";
import { definitions } from "../src/codec/definitions.js";
import { bytesToHex } from "../src/crypto/hex.js";
import { CodecError } from "../src/errors.js";

const run = Effect.runPromise;
const fails = async (e: Effect.Effect<unknown, CodecError>) => {
  const err = await run(Effect.flip(e));
  expect(err).toBeInstanceOf(CodecError);
  return err;
};
const tryOracle = <A>(f: () => A): A | undefined => {
  try {
    return f();
  } catch {
    return undefined;
  }
};

const ALICE = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const BOB = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const PUBKEY = `02${"AB".repeat(32)}`;
const payment = (extra: TxJson = {}): TxJson => ({
  TransactionType: "Payment",
  Account: ALICE,
  Destination: BOB,
  Amount: "1000000",
  Fee: "12",
  Sequence: 7,
  SigningPubKey: PUBKEY,
  ...extra,
});

const fixtures = JSON.parse(readFileSync(new URL("./vectors/codec-fixtures.json", import.meta.url), "utf8")) as Record<string, { binary: string; json: TxJson }[]>;

// Fixtures whose JSON has a Number or Int32 field or an MPT amount/issue: the ones an earlier codec could not handle.
const fieldTypes = new Map<string, string>((definitions.FIELDS as unknown as [string, { type: string }][]).map(([n, f]) => [n, f.type]));
const usesNumberOrMpt = (x: unknown): boolean =>
  Array.isArray(x)
    ? x.some(usesNumberOrMpt)
    : typeof x === "object" && x !== null
      ? Object.entries(x).some(([k, v]) => k === "mpt_issuance_id" || ["Number", "Int32"].includes(fieldTypes.get(k) ?? "") || usesNumberOrMpt(v))
      : false;

describe("W-K01 codec fixtures", () => {
  const entries = [...fixtures.transactions!, ...fixtures.accountState!];

  it("encodes every fixture byte-for-byte and decodes it back", async () => {
    for (const f of entries) {
      expect(await run(encode(f.json))).toBe(f.binary);
      expect(await run(decode(f.binary))).toEqual(f.json);
    }
  });

  it("counts: all 302 fixtures, 6 of them with MPT amounts, Number or Int32 fields", () => {
    expect(entries.length).toBe(302);
    expect(entries.filter((f) => usesNumberOrMpt(f.json)).length).toBe(6);
  });
});

// ---- W-K02 generators

const account = fc.uint8Array({ minLength: 20, maxLength: 20 }).map((b) => encodeAccountID(b));
const hex = (min: number, max: number) => fc.uint8Array({ minLength: min, maxLength: max }).map((b) => bytesToHex(b));
const u32 = fc.integer({ min: 0, max: 0xffffffff });
const xrp = fc.bigInt({ min: 0n, max: 10n ** 17n }).map(String);
const ISO_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789?!@#$%^&*(){}[]|";
const currency = fc.oneof(
  fc.string({ unit: fc.constantFrom(...ISO_CHARS), minLength: 3, maxLength: 3 }).filter((c) => c !== "XRP"),
  hex(20, 20).filter((h) => h !== "0".repeat(40)),
);
const iouValue = fc.oneof(
  fc.constant("0"),
  fc.tuple(fc.boolean(), fc.bigInt({ min: 1n, max: 10n ** 16n - 1n }), fc.integer({ min: -80, max: 60 })).map(([neg, m, e]) => `${neg ? "-" : ""}${m}e${e}`),
  fc.tuple(fc.integer({ min: 0, max: 999999 }), fc.integer({ min: 1, max: 999999 })).map(([i, f]) => `${i}.${f}`),
);
const iou = fc.record({ currency, issuer: account, value: iouValue });
const mptId = hex(24, 24);
const mpt = fc.record({ mpt_issuance_id: mptId, value: fc.bigInt({ min: 0n, max: 2n ** 63n - 1n }).map(String) });
const amount = fc.oneof(xrp, iou, mpt);
const issue = fc.oneof(fc.constant({ currency: "XRP" }), fc.record({ currency, issuer: account }), fc.record({ mpt_issuance_id: mptId }));
const bridge = fc.record({ LockingChainDoor: account, LockingChainIssue: issue, IssuingChainDoor: account, IssuingChainIssue: issue });
const u8 = fc.integer({ min: 0, max: 0xff });
const u16 = fc.integer({ min: 0, max: 0xffff });
const u64Decimal = fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }).map(String); // MaximumAmount and friends are decimal strings
const int32 = fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 });
const digits = (max: number) => fc.string({ unit: fc.constantFrom(..."0123456789"), minLength: 1, maxLength: max });
// Digit runs near the int64 / 10^18 / 10^19 limits (plus a tail that decides rounding), or just long runs.
const mantissa = fc.oneof(
  digits(30),
  fc
    .tuple(fc.constantFrom(2n ** 63n, 10n ** 18n, 10n ** 19n), fc.integer({ min: -25, max: 25 }), fc.oneof(fc.constant(""), digits(2)))
    .map(([base, delta, tail]) => `${base + BigInt(delta)}${tail}`),
);
/** Every shape the Number parser takes: sign, integer part, fraction, exponent. */
const numberString = (exponent: fc.Arbitrary<number>) =>
  fc
    .tuple(fc.constantFrom("", "-", "+"), mantissa, fc.option(digits(10), { nil: undefined }), fc.option(fc.tuple(fc.constantFrom("e", "E"), exponent), { nil: undefined }))
    .map(([sign, int, frac, exp]) => `${sign}${int}${frac === undefined ? "" : `.${frac}`}${exp === undefined ? "" : `${exp[0]}${exp[1] >= 0 && exp[1] % 2 ? "+" : ""}${exp[1]}`}`);
const number = numberString(fc.integer({ min: -300, max: 300 })); // always normalises, so transactions built from it encode
const wideNumber = numberString(fc.integer({ min: -40000, max: 40000 })); // reaches the exponent limits, so some are rejected
const hop = fc.record({ account, currency, issuer: account }, { requiredKeys: [] }).filter((h) => Object.keys(h).length > 0);
const memo = fc
  .record({ MemoType: hex(0, 10), MemoData: hex(0, 300), MemoFormat: hex(0, 10) }, { requiredKeys: [] })
  .filter((m) => Object.keys(m).length > 0)
  .map((Memo) => ({ Memo }));
const common = (type: string) => ({
  TransactionType: fc.constant(type),
  Account: account,
  Fee: xrp,
  Sequence: u32,
  Flags: u32,
  SigningPubKey: hex(33, 33),
  LastLedgerSequence: u32,
  SourceTag: u32,
  TxnSignature: hex(64, 72),
  Memos: fc.array(memo, { maxLength: 3 }),
});
const tx = (type: string, required: string[], more: Record<string, fc.Arbitrary<unknown>>) =>
  fc.record({ ...common(type), ...more }, { requiredKeys: ["TransactionType", "Account", "Fee", "Sequence", ...required] as never });

const txs = fc.oneof(
  tx("Payment", ["Destination", "Amount"], {
    Destination: account,
    Amount: amount,
    DestinationTag: u32,
    InvoiceID: hex(32, 32),
    SendMax: amount,
    DeliverMin: amount,
    Paths: fc.array(fc.array(hop, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 3 }),
  }),
  tx("AccountSet", [], {
    SetFlag: fc.integer({ min: 0, max: 16 }),
    ClearFlag: fc.integer({ min: 0, max: 16 }),
    Domain: hex(0, 40),
    EmailHash: hex(16, 16),
    MessageKey: hex(0, 40),
    TransferRate: u32,
    TickSize: fc.integer({ min: 0, max: 15 }),
  }),
  tx("TrustSet", ["LimitAmount"], { LimitAmount: iou, QualityIn: u32, QualityOut: u32 }),
  tx("OfferCreate", ["TakerGets", "TakerPays"], { TakerGets: amount, TakerPays: amount, Expiration: u32, OfferSequence: u32 }),
  tx("OfferCancel", ["OfferSequence"], { OfferSequence: u32 }),
  tx("SignerListSet", ["SignerQuorum", "SignerEntries"], {
    SignerQuorum: u32,
    SignerEntries: fc.array(
      fc.record({ Account: account, SignerWeight: fc.integer({ min: 0, max: 0xffff }) }).map((SignerEntry) => ({ SignerEntry })),
      { minLength: 1, maxLength: 8 },
    ),
  }),
  tx("Payment", ["Destination", "Amount"], { Destination: account, Amount: mpt, SendMax: mpt, DeliverMin: mpt }),
  tx("VaultCreate", ["Asset"], { Asset: issue, AssetsMaximum: number, Data: hex(0, 40), MPTokenMetadata: hex(0, 40), WithdrawalPolicy: u8, DomainID: hex(32, 32) }),
  tx("VaultDeposit", ["VaultID", "Amount"], { VaultID: hex(32, 32), Amount: amount }),
  tx("LoanSet", ["LoanBrokerID", "PrincipalRequested"], {
    LoanBrokerID: hex(32, 32),
    Counterparty: account,
    PrincipalRequested: number,
    LoanOriginationFee: number,
    LoanServiceFee: number,
    LatePaymentFee: number,
    ClosePaymentFee: number,
    InterestRate: u32,
    LateInterestRate: u32,
    CloseInterestRate: u32,
    OverpaymentInterestRate: u32,
    OverpaymentFee: u32,
    PaymentTotal: u32,
    PaymentInterval: u32,
    GracePeriod: u32,
    Data: hex(0, 40),
    CounterpartySignature: fc.record({ SigningPubKey: hex(33, 33), TxnSignature: hex(64, 72) }),
  }),
  tx("MPTokenIssuanceCreate", [], { AssetScale: u8, TransferFee: u16, MaximumAmount: u64Decimal, MPTokenMetadata: hex(0, 100) }),
  tx("AMMDeposit", ["Asset", "Asset2"], { Asset: issue, Asset2: issue, Amount: amount, Amount2: amount }),
  tx("XChainCreateBridge", ["XChainBridge", "SignatureReward"], { XChainBridge: bridge, SignatureReward: xrp, MinAccountCreateAmount: xrp }),
  // ledger objects: Number and Int32 fields
  fc.record(
    {
      LedgerEntryType: fc.constant("Loan"),
      Flags: u32,
      LoanScale: int32,
      RemainingOwnerCountDelta: int32,
      PrincipalOutstanding: number,
      PeriodicPayment: number,
      TotalValueOutstanding: number,
      ManagementFeeOutstanding: number,
    },
    { requiredKeys: ["LedgerEntryType"] },
  ),
  fc.record(
    { LedgerEntryType: fc.constant("Vault"), Flags: u32, Asset: issue, ShareMPTID: mptId, AssetsTotal: number, AssetsAvailable: number, AssetsMaximum: number, LossUnrealized: number },
    { requiredKeys: ["LedgerEntryType"] },
  ),
);

describe("W-K02 random transactions agree with ripple-binary-codec", () => {
  it("encode equals the oracle and decode equals the oracle's decode (3000 runs)", async () => {
    await fc.assert(
      fc.asyncProperty(txs, async (generated) => {
        const json = JSON.parse(JSON.stringify(generated)) as TxJson; // fc.record makes null-prototype objects the oracle cannot stringify
        const mine = await run(encode(json));
        expect(mine).toBe(oracle.encode(json));
        const decoded = await run(decode(mine));
        expect(decoded).toEqual(oracle.decode(mine));
        expect(await run(encode(decoded))).toBe(mine); // what verifyTransaction relies on
      }),
      { numRuns: 3000 },
    );
  }, 180_000);
});

describe("W-K03 key order", () => {
  const reverse = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(reverse) : typeof x === "object" && x !== null ? Object.fromEntries(Object.entries(x).reverse().map(([k, v]) => [k, reverse(v)])) : x;

  it("does not change the output", async () => {
    const json = payment({ Memos: [{ Memo: { MemoType: "AA", MemoData: "BB" } }], Flags: 1 });
    expect(await run(encode(reverse(json) as TxJson))).toBe(await run(encode(json)));
    for (const f of fixtures.transactions!)
      expect(await run(encode(reverse(f.json) as TxJson))).toBe(f.binary);
  });
});

describe("W-K04 variable-length prefix", () => {
  const blob = (n: number): TxJson => ({ SigningPubKey: "AB".repeat(n) });
  it.each([
    [192, 1],
    [193, 2],
    [12480, 2],
    [12481, 3],
    [918744, 3],
  ])("%i bytes take a %i-byte prefix", async (n, prefix) => {
    const out = await run(encode(blob(n)));
    expect(out.length / 2).toBe(1 /* field id */ + prefix + n);
    expect(out).toBe(oracle.encode(blob(n)));
    expect(await run(decode(out))).toEqual(blob(n));
  });

  it("rejects 918745 bytes", async () => {
    expect((await fails(encode(blob(918745)))).reason).toBe("bad_length");
  });
});

describe("W-K05 XRP amounts", () => {
  const fee = (Fee: unknown): TxJson => ({ Fee });
  it.each(["0", "100000000000000000", "1", "12"])("accepts %s", async (v) => {
    expect(await run(encode(fee(v)))).toBe(oracle.encode(fee(v)));
    expect(await run(decode(await run(encode(fee(v)))))).toEqual(fee(v));
  });
  it.each(["100000000000000001", "-1", "-0", "1.5", "1e3", "", "abc", " 1"])("rejects %j", async (v) => {
    await fails(encode(fee(v)));
  });
  it("rejects over-limit as out_of_range and a number as bad_type", async () => {
    expect((await fails(encode(fee("100000000000000001")))).reason).toBe("out_of_range");
    expect((await fails(encode(fee(1000)))).reason).toBe("bad_type");
  });
  it("decode rejects a negative or oversized XRP amount", async () => {
    await fails(decode("6000000000000001"));
    await fails(decode("4163457D3C7B9400")); // > 1e17 drops
  });
});

describe("W-K06 issued-currency amounts", () => {
  const iouTx = (value: string): TxJson => ({ TakerGets: { currency: "USD", issuer: ALICE, value } });

  it.each(["1", "0", "-0", "-1.5", "1e80", "1e-96", "0.000", "123.456", "9999999999999999e80", "1000000000000000e-96", "-9999999999999999e-81", "12345678901234567", "1e81", "1e96", "1e-97", "abc", "1e", ""])(
    "%j matches the oracle",
    async (value) => {
      const expected = tryOracle(() => oracle.encode(iouTx(value)));
      if (expected === undefined) return void (await fails(encode(iouTx(value))));
      const mine = await run(encode(iouTx(value)));
      expect(mine).toBe(expected);
      expect(await run(decode(mine))).toEqual(oracle.decode(mine));
    },
  );

  it("known edges", async () => {
    expect(await run(encode(iouTx("0")))).toBe(`658000000000000000${"00".repeat(12)}555344${"00".repeat(5)}B5F762798A53D543A014CAF8B297CFF8F2F937E8`);
    expect((await run(decode(await run(encode(iouTx("1e80")))))).TakerGets).toEqual({ currency: "USD", issuer: ALICE, value: `1${"0".repeat(80)}` });
    await fails(encode(iouTx("1e-96"))); // normalized exponent -111
    await fails(encode(iouTx("12345678901234567"))); // 17 significant digits
    await fails(encode(iouTx("1e96"))); // normalized exponent 81
  });

  it("rejects extra or missing members and non-string values", async () => {
    await fails(encode({ TakerGets: { currency: "USD", value: "1" } }));
    await fails(encode({ TakerGets: { currency: "USD", issuer: ALICE, value: 1 } }));
    await fails(encode({ TakerGets: { currency: "USD", issuer: ALICE, value: "1", extra: 1 } }));
  });

  it.each(["C000000000000000", "8040000000000000", "FFC0000000000000"])("decode rejects the non-canonical zero %s", async (v) => {
    await fails(decode(`65${v}${"00".repeat(40)}`));
  });

  it("a canonical IOU zero round-trips", async () => {
    const blob = `658000000000000000${"00".repeat(12)}555344${"00".repeat(5)}B5F762798A53D543A014CAF8B297CFF8F2F937E8`;
    expect((await run(decode(blob))).TakerGets).toMatchObject({ value: "0" });
    expect(await run(encode(await run(decode(blob))))).toBe(blob.toUpperCase());
  });

  it("decode rejects an unnormalized mantissa", async () => {
    const v = (0xc0n << 56n) | (97n << 54n) | 1n; // positive, exponent 0, mantissa 1 (< 10^15)
    await fails(decode(`65${v.toString(16).padStart(16, "0")}${"00".repeat(40)}`));
  });
});

describe("W-K07 currency codes", () => {
  const withCurrency = (c: string): TxJson => ({ TakerGets: { currency: c, issuer: ALICE, value: "1" } });
  const currencyHex = (out: string) => out.slice(2 + 16, 2 + 16 + 40); // after field id (1 byte) and amount (8 bytes)

  it("puts a 3-character code at bytes 12-14", async () => {
    const out = await run(encode(withCurrency("USD")));
    expect(currencyHex(out)).toBe(`${"00".repeat(12)}555344${"00".repeat(5)}`);
    expect((await run(decode(out))).TakerGets).toMatchObject({ currency: "USD" });
  });

  it("passes a 40-digit hex code through", async () => {
    const code = "0158415500000000C1F76FF6ECB0BAC600000000";
    const out = await run(encode(withCurrency(code)));
    expect(currencyHex(out)).toBe(code);
    expect(out).toBe(oracle.encode(withCurrency(code)));
    expect((await run(decode(out))).TakerGets).toMatchObject({ currency: code });
  });

  it("rejects XRP (any spelling) as an issued currency", async () => {
    await fails(encode(withCurrency("XRP")));
    await fails(encode(withCurrency("0".repeat(40))));
  });

  it("rejects malformed codes", async () => {
    await fails(encode(withCurrency("US")));
    await fails(encode(withCurrency("USDX")));
    await fails(encode(withCurrency("U~D")));
    await fails(encode(withCurrency("Z".repeat(40))));
    await fails(encode(withCurrency(1 as never)));
  });

  it("XRP is fine where there is no issuer (Issue field) and decodes back", async () => {
    const asset = { Asset: { currency: "XRP" } };
    const out = await run(encode(asset));
    expect(out).toBe(oracle.encode(asset));
    expect(await run(decode(out))).toEqual(asset);
    await fails(encode({ Asset: { currency: "USD" } }));
  });

  it("a lower-case 'xrp' is an ordinary code", async () => {
    expect(await run(encode(withCurrency("xrp")))).toBe(oracle.encode(withCurrency("xrp")));
  });
});

describe("W-K08 errors", () => {
  it("unknown field → unknown_field, never silently dropped", async () => {
    const e = await fails(encode(payment({ NotAField: 1 })));
    expect(e).toMatchObject({ reason: "unknown_field", field: "NotAField" });
    expect((await fails(encode(payment({ lowercase: 1 })))).reason).toBe("unknown_field");
    expect((await fails(encode(payment({ Memos: [{ Memo: { Bogus: "AA" } }] })))).reason).toBe("unknown_field");
    expect((await fails(encode(payment({ Memos: [{ Nope: {} }] })))).reason).toBe("unknown_field");
  });

  it.each([
    ["TransactionType", 9999],
    ["LedgerEntryType", 9999],
  ])("encode rejects a %s code that decode would reject", async (field, code) => {
    const e = await fails(encode({ [field]: code }));
    expect(e).toMatchObject({ reason: "bad_type", field });
    expect(await run(encode({ TransactionType: 0 }))).toBe("120000");
  });

  it.each(["ObjectEndMarker", "ArrayEndMarker"])("encode rejects the %s pseudo-field", async (name) => {
    expect((await fails(encode({ [name]: {} }))).reason).toBe("bad_type");
  });

  it("wrong JSON type → bad_type", async () => {
    for (const bad of [
      payment({ Sequence: "7" }),
      payment({ Sequence: 1.5 }),
      payment({ Account: 5 }),
      payment({ Account: "not an address" }),
      payment({ Account: BOB.slice(0, -1) + "x" }),
      payment({ SigningPubKey: "XYZ" }),
      payment({ SigningPubKey: "ABC" }),
      payment({ Amount: null }),
      payment({ Memos: {} }),
      payment({ Memos: [{ Memo: "AA" }] }),
      payment({ Memos: [{ Memo: {}, Extra: {} }] }),
      payment({ Memos: [{ Account: ALICE }] }), // not an object field
      payment({ TransactionType: "Nonsense" }),
    ])
      expect((await fails(encode(bad))).reason).toBe("bad_type");
    expect((await fails(encode(null as never))).reason).toBe("bad_type");
  });

  it("out-of-range integers and wrong-size hashes", async () => {
    expect((await fails(encode(payment({ Sequence: 2 ** 32 })))).reason).toBe("out_of_range");
    expect((await fails(encode(payment({ Sequence: -1 })))).reason).toBe("out_of_range");
    expect((await fails(encode(payment({ TransferRate: 2 ** 32 })))).reason).toBe("out_of_range");
    expect((await fails(encode(payment({ InvoiceID: "AA" })))).reason).toBe("bad_length");
    expect((await fails(encode({ LedgerEntryType: "Payment" }))).reason).toBe("bad_type");
  });

  it("decode errors", async () => {
    expect((await fails(decode("zz"))).reason).toBe("bad_type");
    expect((await fails(decode("2200"))).reason).toBe("bad_length"); // truncated UInt32
    expect((await fails(decode("0F63"))).reason).toBe("unknown_field");
    expect((await fails(decode("22000000012200000002"))).reason).toBe("bad_type"); // duplicate
    expect((await fails(decode("2400000001220000000"))).reason).toBe("bad_type"); // odd hex
    expect((await fails(decode("2400000001" + "2200000002"))).reason).toBe("bad_type"); // out of order
    expect((await fails(decode("E1"))).reason).toBe("bad_type"); // stray object end
    expect((await fails(decode("7305AA"))).reason).toBe("bad_length"); // VL longer than the data
  });

  it("deeply nested objects fail fast", async () => {
    expect(await fails(decode("EA".repeat(1000)))).toMatchObject({ reason: "bad_length", message: expect.stringContaining("nested too deeply") });
  });

  it("messages name the field", async () => {
    expect((await fails(encode(payment({ Flags: { tfPartialPayment: true } })))).message).toMatch(/^Flags: /);
  });

  it("path hops ignore rippled's type / type_hex", async () => {
    const hop = { account: ALICE };
    const plain = await run(encode(payment({ Paths: [[hop]] })));
    expect(await run(encode(payment({ Paths: [[{ ...hop, type: 1, type_hex: "0000000000000001" }]] })))).toBe(plain);
    expect((await fails(encode(payment({ Paths: [[{ type: 1 }]] })))).reason).toBe("bad_type");
  });

  it("skips defined-but-not-serialized fields like rippled", async () => {
    expect(await run(encode(payment({ hash: "AA".repeat(32) })))).toBe(await run(encode(payment())));
  });
});

describe("W-K09 encodeForSigning", () => {
  const signed = payment({ TxnSignature: "AA".repeat(64), Signers: [{ Signer: { Account: BOB, TxnSignature: "BB", SigningPubKey: PUBKEY } }] });

  it("is STX\\0 + signing fields only and matches the oracle", async () => {
    const out = await run(encodeForSigning(signed));
    expect(bytesToHex(out.slice(0, 4))).toBe("53545800");
    expect(bytesToHex(out)).toBe(oracle.encodeForSigning(signed));
    expect(bytesToHex(out)).not.toContain("AA".repeat(64));
    expect(bytesToHex(out)).toBe(bytesToHex(await run(encodeForSigning(payment()))));
  });

  it("matches the oracle on every fixture transaction", async () => {
    for (const f of fixtures.transactions!) expect(bytesToHex(await run(encodeForSigning(f.json)))).toBe(oracle.encodeForSigning(f.json));
  });
});

describe("W-K10 encodeForMultisigning", () => {
  it("is SMT\\0 + signing fields (empty SigningPubKey) + signer AccountID, equal to the oracle", async () => {
    const json = payment();
    const out = await run(encodeForMultisigning(json, BOB));
    expect(bytesToHex(out.slice(0, 4))).toBe("534D5400");
    expect(bytesToHex(out.slice(-20))).toBe(bytesToHex(decodeAccountID(BOB)));
    expect(bytesToHex(out)).toBe(oracle.encodeForMultisigning({ ...json, SigningPubKey: "" }, BOB));
    expect(bytesToHex(await run(encodeForMultisigning({ ...json, SigningPubKey: "" }, BOB)))).toBe(bytesToHex(out));
  });

  it("rejects a bad signer account", async () => {
    expect((await fails(encodeForMultisigning(payment(), "nope"))).reason).toBe("bad_type");
  });
});

describe("W-K11 hashTransaction", () => {
  it("is sha512Half(TXN\\0 + blob)", async () => {
    const blobs = [...fixtures.transactions!.map((f) => f.binary), await run(encode(payment()))];
    for (const blob of blobs) {
      const expected = bytesToHex(sha512(Uint8Array.from([0x54, 0x58, 0x4e, 0x00, ...Buffer.from(blob, "hex")])).slice(0, 32));
      expect(await run(hashTransaction(blob))).toBe(expected);
    }
  });

  it("rejects non-hex input", async () => {
    expect((await fails(hashTransaction("xyz"))).reason).toBe("bad_type");
  });
});

describe("W-K12 definitions snapshot", () => {
  it("definitions.json is the pinned version", () => {
    const file = readFileSync(new URL("../src/codec/definitions.json", import.meta.url));
    // Update only when deliberately refreshing with scripts/definitions.ts.
    expect(createHash("sha256").update(file).digest("hex")).toBe("fde3c253d21e10f2507b8c0062763cd04c94abb2aab01e0e18db83fe51cc46e7");
  });

  it("every field, enum value and result code of the pinned ripple-binary-codec is in definitions.json", () => {
    const theirs = createRequire(import.meta.url)("ripple-binary-codec/dist/enums/definitions.json") as Record<string, any>;
    const ours = definitions as unknown as Record<string, any>;
    // Fields of an amendment that is not live on the node definitions.json was taken from (all UInt32, serialized).
    const notLiveOnOurNode = new Set(["IssuerKeyEpoch", "AuditorKeyEpoch", "IssuerKeyMirrorEpoch", "AuditorKeyMirrorEpoch"]);
    const ourFields = new Map<string, unknown>(ours.FIELDS);
    const missing = (theirs.FIELDS as [string, unknown][]).map(([n]) => n).filter((n) => !ourFields.has(n) && !notLiveOnOurNode.has(n));
    for (const table of ["TYPES", "TRANSACTION_TYPES", "LEDGER_ENTRY_TYPES", "TRANSACTION_RESULTS"])
      for (const [name, code] of Object.entries(theirs[table] as Record<string, number>)) if (ours[table][name] !== code) missing.push(`${table}.${name}`);
    expect(missing).toEqual([]);
  });
});

describe("W-K13 every serialized field type", () => {
  const ID = `0000002A${"AB".repeat(20)}`; // MPT issuance id: sequence 42, then the issuer
  const samples: Record<string, unknown[]> = {
    UInt8: [1],
    UInt16: [2],
    UInt32: [3],
    UInt64: ["0000000000000004"],
    Int32: [0, -5, 2 ** 31 - 1, -(2 ** 31)],
    Hash128: ["AB".repeat(16)],
    Hash160: ["AB".repeat(20)],
    Hash192: ["AB".repeat(24)],
    Hash256: ["AB".repeat(32)],
    Amount: ["10", { currency: "USD", issuer: BOB, value: "1.5" }, { mpt_issuance_id: "AB".repeat(24), value: "7" }],
    Number: ["0", "-1.5e-3", "123456789012345678901234567890"],
    Blob: ["ABCD"],
    AccountID: [ALICE],
    Currency: ["USD"],
    Issue: [{ currency: "XRP" }, { currency: "USD", issuer: BOB }, { mpt_issuance_id: ID }],
    XChainBridge: [
      { LockingChainDoor: ALICE, LockingChainIssue: { currency: "XRP" }, IssuingChainDoor: BOB, IssuingChainIssue: { currency: "USD", issuer: BOB } },
      { LockingChainDoor: ALICE, LockingChainIssue: { mpt_issuance_id: ID }, IssuingChainDoor: BOB, IssuingChainIssue: { mpt_issuance_id: ID } },
    ],
    PathSet: [[[{ account: ALICE, currency: "USD", issuer: BOB }]]],
    STArray: [[{ Memo: { MemoData: "AA" } }]],
    STObject: [{}],
    Vector256: [["AB".repeat(32)]],
  };
  // Enum-valued fields take a name; FeeAmountDelta is a signed-XRP field to the oracle, so it only takes drops.
  const named: Record<string, unknown> = { TransactionType: "Payment", LedgerEntryType: "AccountRoot", TransactionResult: "tesSUCCESS", PermissionValue: "Payment", FeeAmountDelta: "10" };
  // `Generic` is a placeholder with an Unknown type, not a field on the wire.
  const fields = (definitions.FIELDS as unknown as [string, { type: string; isSerialized: boolean }][]).filter(([name, f]) => f.isSerialized && f.type !== "Unknown" && !name.endsWith("EndMarker"));

  it("the definitions use exactly the types these samples cover", () => {
    expect(new Set(fields.map(([, f]) => f.type))).toEqual(new Set(Object.keys(samples)));
  });

  it("every field encodes and decodes like the oracle with a sample of its type", async () => {
    for (const [name, f] of fields)
      for (const value of name in named ? [named[name]] : samples[f.type]!) {
        const json = { [name]: value };
        const blob = oracle.encode(json);
        expect(await run(encode(json)), name).toBe(blob);
        expect(await run(decode(blob)), name).toEqual(oracle.decode(blob));
      }
  });
});

describe("W-K14 Number", () => {
  const num = (Number: unknown): TxJson => ({ Number });
  const matchesOracle = async (value: string) => {
    const expected = tryOracle(() => oracle.encode(num(value)));
    if (expected === undefined) {
      expect((await fails(encode(num(value)))).reason).toBe("out_of_range");
    } else {
      const mine = await run(encode(num(value)));
      expect(mine).toBe(expected);
      const decoded = await run(decode(mine));
      expect(decoded).toEqual(oracle.decode(mine));
      expect(await run(encode(decoded))).toBe(mine);
    }
  };
  const blobOf = (mantissa: bigint, exponent: number) => {
    const body = new Uint8Array(12);
    new DataView(body.buffer).setBigInt64(0, mantissa);
    new DataView(body.buffer).setInt32(8, exponent);
    return `91${bytesToHex(body)}`; // field Number
  };
  /** The value a Number string stands for (digits and a power of ten), so strings compare whatever their notation. */
  const valueOf = (shown: string) => {
    const [, sign, int, frac = "", exp = "0"] = /^(-?)(\d+)(?:\.(\d+))?(?:e(-?\d+))?$/.exec(shown)!;
    const all = (int! + frac).replace(/^0+/, "");
    const digits = all.replace(/0+$/, "");
    return digits === "" ? "0" : `${sign}${digits}e${Number(exp) - frac.length + all.length - digits.length}`;
  };

  it("any decimal string encodes like the oracle, and fails where the oracle throws (3000 runs)", async () => {
    await fc.assert(fc.asyncProperty(wideNumber, matchesOracle), { numRuns: 3000 });
  }, 120_000);

  it("canonical mantissas (|m| >= 10^17, or zero) decode like the oracle (3000 runs)", async () => {
    const mantissas = fc.oneof(
      fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }).filter((m) => m >= 10n ** 17n || m <= -(10n ** 17n)),
      fc.bigInt({ min: 10n ** 17n, max: 10n ** 18n }),
      fc.constant(0n),
    );
    const exponents = fc.oneof(fc.integer({ min: -40, max: 20 }), fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }), fc.constantFrom(-(2 ** 31), 0, 32768, -32768));
    await fc.assert(
      fc.asyncProperty(mantissas, exponents, async (mantissa, exponent) => {
        const blob = blobOf(mantissa, exponent);
        expect(await run(decode(blob))).toEqual(oracle.decode(blob));
      }),
      { numRuns: 3000 },
    );
  }, 120_000);

  it("every mantissa and exponent decode to their own value, even where the oracle prints a smaller mantissa wrongly (3000 runs)", async () => {
    // ripple-binary-codec's plain-decimal branch assumes 19 digits: mantissa -1, exponent -7 prints as -10000000000 there.
    const mantissas = fc.oneof(fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }), fc.bigInt({ min: -100000n, max: 100000n }));
    const exponents = fc.oneof(fc.integer({ min: -40, max: 20 }), fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }));
    await fc.assert(
      fc.asyncProperty(mantissas, exponents, async (mantissa, exponent) => {
        const shown = (await run(decode(blobOf(mantissa, exponent)))).Number as string;
        expect(valueOf(shown)).toBe(valueOf(`${mantissa}e${exponent}`));
      }),
      { numRuns: 3000 },
    );
  }, 120_000);

  it.each([
    "0", "-0", "0.000", "1", "-1", "+7", "007.50", "123.456", "0.001", "1.5e3", "1e17", "1e18", "1e19", "1e40", "-1e-40",
    "9223372036854775807", "9223372036854775808", "92233720368547758075", "9999999999999999999", "99999999999999999995", "10000000000000000000",
    "1e32786", "1e32787", "1e-32750", "1e-32751",
  ])("%s matches the oracle", matchesOracle);

  it("a 30000-digit string matches the oracle", () => matchesOracle("1".repeat(30000)));

  it("formats like rippled: plain decimals for exponents -28..-8 and 0, scientific otherwise", async () => {
    for (const [input, shown] of [
      ["0", "0"],
      ["-0", "0"],
      ["+7", "7"],
      ["007.50", "7.5"],
      ["123.456", "123.456"],
      ["-1.5e3", "-1500"],
      ["0.001", "0.001"],
      ["1e18", "1000000000000000000"],
      ["1e19", "1e19"],
      ["1e40", "1e40"],
      ["-1e-40", "-1e-40"],
    ] as const)
      expect((await run(decode(await run(encode(num(input)))))).Number, input).toBe(shown);
  });

  it("zero is a zero mantissa with the lowest exponent; the rest is a 10^18..2^63-1 mantissa", async () => {
    expect(await run(encode(num("0")))).toBe("91000000000000000080000000");
    expect(await run(encode(num("1")))).toBe("910DE0B6B3A7640000FFFFFFEE");
  });

  it("rejects non-strings, malformed strings and out-of-range exponents, naming the field", async () => {
    for (const bad of [1, 1n, null, "", " 1", "1 ", ".5", "1.", "1e", "e5", "0x10", "NaN", "Infinity", "--1", "1_000"]) {
      const e = await fails(encode(num(bad)));
      expect(e).toMatchObject({ reason: "bad_type", field: "Number" });
      expect(e.message).toMatch(/^Number: /);
    }
    for (const big of ["1e32787", "1e40000", "1e-32751", "1e-40000", "9".repeat(40000)]) expect((await fails(encode(num(big)))).reason).toBe("out_of_range");
  });

  it("decode needs 12 bytes", async () => {
    expect((await fails(decode(`91${"00".repeat(11)}`))).reason).toBe("bad_length");
  });
});

describe("W-K15 Int32", () => {
  const scale = (LoanScale: unknown): TxJson => ({ LoanScale });

  it("encodes and decodes like the oracle (2000 runs)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(int32, fc.constantFrom(-(2 ** 31), 2 ** 31 - 1, 0, -1, 1)), async (n) => {
        const mine = await run(encode(scale(n)));
        expect(mine).toBe(oracle.encode(scale(n)));
        expect(await run(decode(mine))).toEqual(scale(n));
      }),
      { numRuns: 2000 },
    );
  });

  it("is two's complement, big-endian", async () => {
    expect(await run(encode(scale(-1)))).toBe("A1FFFFFFFF");
    expect(await run(encode(scale(-(2 ** 31))))).toBe("A180000000");
    expect(await run(decode("A17FFFFFFF"))).toEqual(scale(2 ** 31 - 1));
  });

  it("rejects out-of-range values and non-integers", async () => {
    for (const bad of [2 ** 31, -(2 ** 31) - 1, 2 ** 32]) expect((await fails(encode(scale(bad)))).reason).toBe("out_of_range");
    for (const bad of [1.5, NaN, "5", null, 5n]) expect(await fails(encode(scale(bad)))).toMatchObject({ reason: "bad_type", field: "LoanScale" });
    expect((await fails(decode("A100"))).reason).toBe("bad_length");
  });
});

describe("W-K18 FeeAmountDelta is a signed XRP delta (oracle SignedAmount)", () => {
  it.each(["-1", "-100000000000000000", "0", "-0", "25"])("%s matches the oracle and decodes back", async (value) => {
    const mine = await run(encode({ FeeAmountDelta: value }));
    expect(mine).toBe(oracle.encode({ FeeAmountDelta: value }));
    expect(await run(decode(mine))).toEqual({ FeeAmountDelta: value === "-0" ? "0" : value });
  });
  it("stays unsigned elsewhere and rejects out-of-range or negative-zero bytes", async () => {
    await fails(encode({ Fee: "-1" }));
    await fails(encode({ FeeAmountDelta: "-100000000000000001" }));
    const negativeZero = (await run(encode({ FeeAmountDelta: "0" }))).replace(/40(0{14})$/, "00$1");
    await fails(decode(negativeZero));
  });
});

describe("W-K16 MPT amounts and issues", () => {
  const ID = `0000012A${bytesToHex(decodeAccountID(ALICE))}`; // sequence 298, issuer ALICE
  const SEQUENCE_LE = "2A010000";
  const amountTx = (value: unknown, mpt_issuance_id: unknown = ID): TxJson => ({ Amount: { mpt_issuance_id, value } });

  it.each(["0", "1", "1000", "007", "9223372036854775807"])("amount %s matches the oracle and decodes back", async (value) => {
    const mine = await run(encode(amountTx(value)));
    expect(mine).toBe(oracle.encode(amountTx(value)));
    expect(await run(decode(mine))).toEqual(oracle.decode(mine));
  });

  it("an MPT amount is a 0x60 flag byte, the 8-byte value, then the 24-byte id", async () => {
    expect(await run(encode(amountTx("255")))).toBe(`6160${"00".repeat(7)}FF${ID}`);
  });

  it("rejects malformed values, naming the field", async () => {
    for (const bad of ["-1", "-0", "1.5", "1e3", "", "abc", " 1", "0x10", 1, null]) expect(await fails(encode(amountTx(bad)))).toMatchObject({ reason: "bad_type", field: "Amount" });
    const e = await fails(encode(amountTx("9223372036854775808")));
    expect(e.reason).toBe("out_of_range");
    expect(e.message).toMatch(/^Amount: /);
  });

  it("rejects wrong members and ids", async () => {
    for (const bad of [
      { mpt_issuance_id: ID },
      { value: "1" },
      { mpt_issuance_id: ID, value: "1", currency: "USD" },
      { mpt_issuance_id: ID, value: "1", issuer: ALICE },
      { mpt_issuance_id: "AB".repeat(23), value: "1" },
      { mpt_issuance_id: "AB".repeat(25), value: "1" },
      { mpt_issuance_id: "ZZ".repeat(24), value: "1" },
      { mpt_issuance_id: 5, value: "1" },
    ])
      await fails(encode({ Amount: bad }));
  });

  it("decode rejects negative, flagged and oversized MPT amounts and short data", async () => {
    const amount = (lead: string, value: string) => `61${lead}${value}${"AB".repeat(24)}`;
    expect((await fails(decode(amount("20", "0000000000000001")))).reason).toBe("bad_type"); // negative
    expect((await fails(decode(amount("61", "0000000000000001")))).reason).toBe("bad_type"); // stray flag
    expect((await fails(decode(amount("70", "0000000000000001")))).reason).toBe("bad_type");
    expect((await fails(decode(amount("60", "8000000000000000")))).reason).toBe("out_of_range");
    expect((await fails(decode(`6160${"00".repeat(8)}`))).reason).toBe("bad_length");
    expect(await run(decode(amount("60", "7FFFFFFFFFFFFFFF")))).toEqual({ Amount: { value: "9223372036854775807", mpt_issuance_id: "AB".repeat(24) } });
  });

  it("an MPT issue is the issuer, the no-account marker, then the sequence little-endian", async () => {
    const asset = { Asset: { mpt_issuance_id: ID } };
    const out = await run(encode(asset));
    expect(out).toBe(oracle.encode(asset));
    expect(out.slice(-88)).toBe(`${bytesToHex(decodeAccountID(ALICE))}${"00".repeat(19)}01${SEQUENCE_LE}`);
    expect(await run(decode(out))).toEqual(asset);
  });

  it("XRP and issued-currency issues are unchanged and rejected shapes still fail", async () => {
    for (const asset of [{ currency: "XRP" }, { currency: "USD", issuer: BOB }]) {
      const out = await run(encode({ Asset: asset }));
      expect(out).toBe(oracle.encode({ Asset: asset }));
      expect(await run(decode(out))).toEqual({ Asset: asset });
    }
    for (const bad of [{ mpt_issuance_id: ID, currency: "USD" }, { mpt_issuance_id: "AB".repeat(23) }, { mpt_issuance_id: 5 }, {}]) await fails(encode({ Asset: bad }));
    expect((await fails(decode(`03${"18"}${"AB".repeat(20)}${"00".repeat(19)}01AABB`))).reason).toBe("bad_length"); // sequence cut short
  });
});

describe("W-K17 real transactions of the newer families", () => {
  const ID = `0000012A${bytesToHex(decodeAccountID(ALICE))}`;
  const HASH = "CAFEBABE".repeat(8);
  const base = { Account: ALICE, Fee: "10", Sequence: 5, Flags: 0, SigningPubKey: PUBKEY };
  const mptAmount = (value: string) => ({ mpt_issuance_id: ID, value });
  const families: [string, TxJson][] = [
    ["VaultCreate, MPT asset", { ...base, TransactionType: "VaultCreate", Asset: { mpt_issuance_id: ID }, AssetsMaximum: "1000000", Data: "7B226E616D65223A227661756C74227D", MPTokenMetadata: "ABCD", WithdrawalPolicy: 1, DomainID: HASH }],
    ["VaultCreate, XRP asset", { ...base, TransactionType: "VaultCreate", Asset: { currency: "XRP" }, AssetsMaximum: "0.5", Flags: 0x10000 }],
    ["VaultCreate, IOU asset", { ...base, TransactionType: "VaultCreate", Asset: { currency: "USD", issuer: BOB }, AssetsMaximum: "1e30" }],
    ["VaultDeposit, MPT", { ...base, TransactionType: "VaultDeposit", VaultID: HASH, Amount: mptAmount("250") }],
    ["VaultDeposit, XRP", { ...base, TransactionType: "VaultDeposit", VaultID: HASH, Amount: "1000000" }],
    [
      "LoanSet",
      {
        ...base,
        TransactionType: "LoanSet",
        LoanBrokerID: HASH,
        Counterparty: BOB,
        PrincipalRequested: "100000.25",
        InterestRate: 500,
        PaymentTotal: 12,
        PaymentInterval: 2592000,
        GracePeriod: 604800,
        LoanOriginationFee: "250",
        LoanServiceFee: "1.5",
        LatePaymentFee: "10",
        ClosePaymentFee: "5",
        OverpaymentFee: 100,
        LateInterestRate: 300,
        CloseInterestRate: 200,
        OverpaymentInterestRate: 100,
        Data: "AA",
        CounterpartySignature: { SigningPubKey: PUBKEY, TxnSignature: "CC".repeat(64) },
      },
    ],
    ["MPTokenIssuanceCreate", { ...base, TransactionType: "MPTokenIssuanceCreate", Flags: 0x7e, AssetScale: 2, TransferFee: 314, MaximumAmount: "100000000", MPTokenMetadata: "7B7D" }],
    ["Payment, MPT", { ...base, TransactionType: "Payment", Destination: BOB, Amount: mptAmount("1000"), SendMax: mptAmount("1010"), DeliverMin: mptAmount("900") }],
    ["OfferCreate, MPT for XRP", { ...base, TransactionType: "OfferCreate", TakerGets: mptAmount("5"), TakerPays: "1000" }],
    [
      "Loan entry (Int32, Number)",
      {
        LedgerEntryType: "Loan",
        Flags: 0,
        LoanScale: -3,
        RemainingOwnerCountDelta: 2,
        PrincipalOutstanding: "99999.5",
        PeriodicPayment: "8333.33",
        TotalValueOutstanding: "100500",
        ManagementFeeOutstanding: "0",
        PreviousTxnID: HASH,
        PreviousTxnLgrSeq: 100,
      },
    ],
    [
      "Vault entry (Hash192, Number)",
      { LedgerEntryType: "Vault", Flags: 0, Asset: { mpt_issuance_id: ID }, ShareMPTID: "0000002B".padEnd(48, "AB"), AssetsTotal: "1e30", AssetsAvailable: "5000.123456789", AssetsMaximum: "0", LossUnrealized: "-0.5", WithdrawalPolicy: 1 },
    ],
  ];

  it.each(families)("%s encodes and signs like the oracle and decodes back", async (_name, json) => {
    const blob = await run(encode(json));
    expect(blob).toBe(oracle.encode(json));
    expect(await run(decode(blob))).toEqual(json);
    expect(await run(decode(blob))).toEqual(oracle.decode(blob));
    if (json.TransactionType !== undefined) expect(bytesToHex(await run(encodeForSigning(json)))).toBe(oracle.encodeForSigning(json));
  });
});
