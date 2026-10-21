import xahauRaw from "./codec/definitions.xahau.json" with { type: "json" };
import { makeDefinitions } from "./codec/definitions.js";

/** Codec tables for Xahau (hooks, Import, URIToken, ...). Pass as the `defs` argument of encode/decode. */
export const XAHAU_DEFINITIONS = makeDefinitions(xahauRaw);

/** Where `definitions.xahau.json` came from. Change it in the same commit that regenerates the JSON. */
export const XAHAU_PROTOCOL = {
  definitionsSource: "https://xahau.network/",
  definitionsMethod: "server_definitions",
  capturedOn: "2026-10-19",
} as const;

// Transaction shapes for Xahau-only types, after xahau.js `models/transactions` (Flags as numbers: the codec takes numbers).
// `type`, not `interface`, so each is assignable to `TxJson` (`Record<string, unknown>`).

export type XahauAmount = string | { currency: string; issuer: string; value: string };

type Base = {
  Account: string;
  Fee?: string;
  Sequence?: number;
  Flags?: number;
  LastLedgerSequence?: number;
  NetworkID?: number;
  SigningPubKey?: string;
  TxnSignature?: string;
  SourceTag?: number;
  TicketSequence?: number;
  AccountTxnID?: string;
  FirstLedgerSequence?: number;
  Memos?: { Memo: { MemoType?: string; MemoData?: string; MemoFormat?: string } }[];
  Signers?: { Signer: { Account: string; TxnSignature: string; SigningPubKey: string } }[];
  EmitDetails?: Record<string, unknown>;
  /** Hook parameters on the transaction itself (what `Invoke` carries). */
  HookParameters?: HookParameter[];
  HookName?: string;
};

export type HookParameter = { HookParameter: { HookParameterName: string; HookParameterValue?: string } };
export type HookGrant = { HookGrant: { HookHash: string; Authorize?: string } };
export type Hook = {
  Hook: {
    HookHash?: string;
    CreateCode?: string;
    Flags?: number;
    HookOn?: string;
    /** HookOnV2_1 only: pair with `HookOnOutgoing`, differ from it, exclusive with `HookOn`. */
    HookOnIncoming?: string;
    HookOnOutgoing?: string;
    HookCanEmit?: string;
    HookNamespace?: string;
    HookApiVersion?: number;
    HookParameters?: HookParameter[];
    HookGrants?: HookGrant[];
    /** Empty removes the name from the installed hook. */
    HookName?: string;
  };
};
export type Remark = { Remark: { RemarkName: string; RemarkValue?: string; Flags?: number } };
export type MintURIToken = { URI: string; Digest?: string; Flags?: number };
export type AmountEntry = { AmountEntry: { Amount: XahauAmount } };

export type SetHook = Base & { TransactionType: "SetHook"; Hooks: Hook[] };
export type Import = Base & { TransactionType: "Import"; Issuer?: string; Blob?: string };
export type Invoke = Base & { TransactionType: "Invoke"; Destination?: string; Blob?: string };
export type ClaimReward = Base & { TransactionType: "ClaimReward"; Issuer?: string };
export type SetRemarks = Base & { TransactionType: "SetRemarks"; ObjectID: string; Remarks: Remark[] };
export type Cron = Base & { TransactionType: "Cron"; LedgerSequence: number; Owner: string };
export type CronSet = Base & { TransactionType: "CronSet"; RepeatCount?: number; DelaySeconds?: number; StartTime?: number };
export type Remit = Base & {
  TransactionType: "Remit";
  Destination: string;
  DestinationTag?: number;
  Amounts?: AmountEntry[];
  MintURIToken?: MintURIToken;
  URITokenIDs?: string[];
  InvoiceID?: string;
  Blob?: string;
  Inform?: string;
};
export type URITokenMint = Base & { TransactionType: "URITokenMint"; URI: string; Amount?: XahauAmount; Destination?: string; Digest?: string };
export type URITokenBurn = Base & { TransactionType: "URITokenBurn"; URITokenID: string };
export type URITokenBuy = Base & { TransactionType: "URITokenBuy"; URITokenID: string; Amount: XahauAmount };
export type URITokenCancelSellOffer = Base & { TransactionType: "URITokenCancelSellOffer"; URITokenID: string };
export type URITokenCreateSellOffer = Base & { TransactionType: "URITokenCreateSellOffer"; URITokenID: string; Amount: XahauAmount; Destination?: string };

/** Signable Xahau transactions; `Cron` is excluded (the ledger emits it, an account never signs it). */
export type XahauTransaction =
  | SetHook | Import | Invoke | ClaimReward | SetRemarks | CronSet | Remit
  | URITokenMint | URITokenBurn | URITokenBuy | URITokenCancelSellOffer | URITokenCreateSellOffer;
