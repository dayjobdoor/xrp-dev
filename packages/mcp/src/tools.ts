import {
  autofill,
  decode,
  encode,
  hashTransaction,
  isValidClassicAddress,
  classicToXAddress,
  NETWORKS,
  type Network,
  publicKeyToAddress,
  type RpcClient,
  type TxJson,
  xAddressToClassic,
} from "xrp-dev";
import { Effect, Result, Schema as S } from "effect";

/** `client(undefined)` is the transport's default network (testnet for the agent, `--network` for stdio). */
export interface Deps {
  client(network?: Network): RpcClient;
}

export interface ToolFailure {
  readonly message: string;
}

export interface Tool<D = Deps> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean };
  /** Schema check; the handler never sees input that fails it. */
  validate(input: unknown): { readonly args: unknown } | { readonly error: string };
  /** A string is returned as is, anything else as JSON. */
  handler(args: unknown, deps: D): Effect.Effect<unknown, ToolFailure>;
}

export const defineTool = <A, I, D = Deps>(def: {
  name: string;
  description: string;
  schema: S.Codec<A, I>;
  annotations?: Tool["annotations"];
  handler: (args: A, deps: D) => Effect.Effect<unknown, ToolFailure>;
}): Tool<D> => {
  const decodeArgs = S.decodeUnknownResult(def.schema);
  return {
    name: def.name,
    description: def.description,
    inputSchema: S.toJsonSchemaDocument(def.schema).schema as Record<string, unknown>,
    annotations: def.annotations ?? { readOnlyHint: true },
    validate: (input) => {
      const r = decodeArgs(input ?? {});
      return Result.isSuccess(r) ? { args: r.success } : { error: `Invalid arguments: ${r.failure.message}` };
    },
    // validate() produced `args` from this schema, so the cast only restores the type the registry erased.
    handler: (args, deps) => def.handler(args as A, deps),
  };
};

const d = (description: string) => ({ description });
// The `u` flag is required: Effect's JSON Schema export silently drops a RegExp without it, so the pattern would not reach the model.
const Address = S.String.check(S.isPattern(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/u)).annotate(d("Classic address (r...)"));
// 2 MiB of bytes as hex: twice rippled's 1 MiB transaction limit. The cap also bounds the regex scan.
const MAX_HEX = 4_194_304;
const Hex = (description: string, length?: number) =>
  S.String.check(S.isPattern(new RegExp(length ? `^[0-9A-Fa-f]{${length}}$` : "^(?:[0-9A-Fa-f]{2})+$", "u")), S.isMaxLength(length ?? MAX_HEX)).annotate(d(description));
// Free-form strings (currency, decimal values, X-addresses) are short; an unbounded one is only a way to make the server buffer.
const Text = S.String.check(S.isMaxLength(128));
const Hash = Hex("Transaction hash (64 hex digits)", 64);
const TxBlob = Hex("Signed or unsigned transaction as hex");
const NetworkArg = S.optionalKey(S.Literals(NETWORKS).annotate(d("XRPL network; defaults to testnet (stdio: the --network flag)")));
const UInt32 = S.Int.check(S.isBetween({ minimum: 0, maximum: 4294967295 }));
const Amount = S.Union([
  S.String.check(S.isPattern(/^\d+$/u)).annotate(d("XRP as a string of drops (1 XRP = 1000000)")),
  S.Struct({ currency: Text, issuer: Address, value: Text.annotate(d("Decimal string")) }).annotate(d("Issued currency amount")),
]).annotate(d("XRP drops (string) or { currency, issuer, value }"));

// No signingData/signingHash: tx_json lacks SigningPubKey (a signing field), so a hash of it never matches what a signer signs.
const PREPARE_NOTE =
  "Fills Fee, Sequence and LastLedgerSequence from the network and returns { tx_json }, unsigned and without SigningPubKey; the signer adds its key and signs with a wallet library. Nothing is signed or sent.";

// encode: the address regex has no checksum and IOU currency/value are free text, so only the codec knows whether the result can be signed.
const prepare = (tx: TxJson, network: Network | undefined, deps: Deps) =>
  autofill(deps.client(network), tx).pipe(Effect.tap(encode), Effect.map((tx_json) => ({ tx_json })));

export const tools: readonly Tool[] = [
  defineTool({
    name: "encode",
    description: "Encode a transaction JSON object to its binary (hex) form.",
    schema: S.Struct({ tx_json: S.Record(S.String, S.Unknown).annotate(d("Transaction in rippled JSON form")) }),
    handler: ({ tx_json }) => encode(tx_json),
  }),
  defineTool({
    name: "decode",
    description: "Decode a transaction blob (hex) to JSON.",
    schema: S.Struct({ tx_blob: TxBlob }),
    handler: ({ tx_blob }) => decode(tx_blob),
  }),
  defineTool({
    name: "hash_transaction",
    description: "Transaction ID (hash) of a signed transaction blob.",
    schema: S.Struct({ tx_blob: TxBlob }),
    handler: ({ tx_blob }) => hashTransaction(tx_blob),
  }),
  defineTool({
    name: "derive_address",
    description: "Classic address of a public key (33 bytes, hex; ed25519 keys start with ED).",
    schema: S.Struct({ public_key: Hex("Public key, 66 hex digits", 66) }),
    handler: ({ public_key }) => publicKeyToAddress(public_key),
  }),
  defineTool({
    name: "classic_to_x_address",
    description: "Classic address and optional destination tag to an X-address.",
    schema: S.Struct({
      address: Address,
      tag: S.optionalKey(UInt32.annotate(d("Destination tag"))),
      test: S.optionalKey(S.Boolean.annotate(d("Test network (T... prefix); default false"))),
    }),
    handler: ({ address, tag, test }) => classicToXAddress(address, tag ?? false, test ?? false),
  }),
  defineTool({
    name: "x_address_to_classic",
    description: "X-address to { classicAddress, tag, test }.",
    schema: S.Struct({ x_address: Text.check(S.isMinLength(1)).annotate(d("X-address")) }),
    handler: ({ x_address }) => xAddressToClassic(x_address),
  }),
  defineTool({
    name: "is_valid_address",
    description: "Whether a string is a valid classic address (checksum included).",
    schema: S.Struct({ address: Text }),
    handler: ({ address }) => isValidClassicAddress(address),
  }),
  defineTool({
    name: "prepare_payment",
    description: `Build a Payment. ${PREPARE_NOTE}`,
    schema: S.Struct({
      account: Address,
      destination: Address,
      amount: Amount,
      destination_tag: S.optionalKey(UInt32),
      network: NetworkArg,
    }),
    handler: ({ account, destination, amount, destination_tag, network }, deps) =>
      prepare(
        { TransactionType: "Payment", Account: account, Destination: destination, Amount: amount, ...(destination_tag === undefined ? {} : { DestinationTag: destination_tag }) },
        network,
        deps,
      ),
  }),
  defineTool({
    name: "prepare_trust_set",
    description: `Build a TrustSet. ${PREPARE_NOTE}`,
    schema: S.Struct({
      account: Address,
      currency: Text.annotate(d("Currency code, e.g. USD")),
      issuer: Address,
      limit: Text.annotate(d("Trust limit, decimal string")),
      network: NetworkArg,
    }),
    handler: ({ account, currency, issuer, limit, network }, deps) =>
      prepare({ TransactionType: "TrustSet", Account: account, LimitAmount: { currency, issuer, value: limit } }, network, deps),
  }),
  defineTool({
    name: "prepare_offer_create",
    description: `Build an OfferCreate. ${PREPARE_NOTE}`,
    schema: S.Struct({
      account: Address,
      taker_gets: Amount.annotate(d("What the offer owner gives")),
      taker_pays: Amount.annotate(d("What the offer owner wants")),
      expiration: S.optionalKey(UInt32.annotate(d("Offer expiry, seconds since 2000-01-01 (Ripple epoch)"))),
      network: NetworkArg,
    }),
    handler: ({ account, taker_gets, taker_pays, expiration, network }, deps) =>
      prepare(
        { TransactionType: "OfferCreate", Account: account, TakerGets: taker_gets, TakerPays: taker_pays, ...(expiration === undefined ? {} : { Expiration: expiration }) },
        network,
        deps,
      ),
  }),
  defineTool({
    name: "account_info",
    description: "Account root of an account: Balance (drops), Sequence, Flags, OwnerCount.",
    schema: S.Struct({
      account: Address,
      ledger_index: S.optionalKey(
        S.Union([S.Literals(["validated", "closed", "current"]), S.Int.check(S.isGreaterThanOrEqualTo(1))]).annotate(d("'validated' (default), 'closed', 'current' or a ledger sequence (>= 1)")),
      ),
      network: NetworkArg,
    }),
    handler: ({ account, ledger_index, network }, deps) => deps.client(network).request("account_info", { account, ledger_index: ledger_index ?? "validated" }),
  }),
  defineTool({
    name: "tx",
    description: "Look up one transaction by hash.",
    schema: S.Struct({ transaction: Hash, network: NetworkArg }),
    handler: ({ transaction, network }, deps) => deps.client(network).request("tx", { transaction }),
  }),
];
