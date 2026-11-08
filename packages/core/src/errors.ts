// Plain `Error`s, so importing them pulls in no Effect. `_tag` is what `Effect.catchTag` matches, and the Effect entries
// (`xrp-dev/effect`) fail with these very classes.

export type CryptoReason = "bad_hex" | "bad_base58" | "bad_checksum" | "bad_length" | "bad_key";
export type AddressReason = "bad_checksum" | "bad_version" | "bad_length" | "bad_tag" | "bad_encoding" | "bad_key";
export type CodecReason = "unknown_field" | "bad_type" | "out_of_range" | "bad_length";
export type ClientReason = "timeout" | "http" | "too_large" | "bad_json" | "rippled_error" | "no_result" | "closed" | "bad_input" | "fee_too_high" | "aborted" | "rejected" | "expired";

export class CryptoError extends Error {
  readonly _tag = "CryptoError";
  readonly reason: CryptoReason;
  constructor(p: { reason: CryptoReason; message: string; cause?: unknown }) {
    super(p.message, p.cause === undefined ? undefined : { cause: p.cause });
    this.name = "CryptoError";
    this.reason = p.reason;
  }
}

export class AddressError extends Error {
  readonly _tag = "AddressError";
  readonly reason: AddressReason;
  constructor(p: { reason: AddressReason; message: string; cause?: unknown }) {
    super(p.message, p.cause === undefined ? undefined : { cause: p.cause });
    this.name = "AddressError";
    this.reason = p.reason;
  }
}

export class CodecError extends Error {
  readonly _tag = "CodecError";
  readonly reason: CodecReason;
  readonly field?: string;
  constructor(p: { reason: CodecReason; message: string; field?: string; cause?: unknown }) {
    super(p.message, p.cause === undefined ? undefined : { cause: p.cause });
    this.name = "CodecError";
    this.reason = p.reason;
    if (p.field !== undefined) this.field = p.field;
  }
}

export class ClientError extends Error {
  readonly _tag = "ClientError";
  readonly reason: ClientReason;
  constructor(p: { reason: ClientReason; message: string; cause?: unknown }) {
    super(p.message, p.cause === undefined ? undefined : { cause: p.cause });
    this.name = "ClientError";
    this.reason = p.reason;
  }
}
