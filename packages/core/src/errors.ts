import { Data } from "effect";

export class CryptoError extends Data.TaggedError("CryptoError")<{
  readonly reason: "bad_hex" | "bad_base58" | "bad_checksum" | "bad_length" | "bad_key" | "bad_signature";
  readonly message: string;
}> {}

export class AddressError extends Data.TaggedError("AddressError")<{
  readonly reason: "bad_checksum" | "bad_version" | "bad_length" | "bad_tag" | "bad_encoding" | "bad_key";
  readonly message: string;
}> {}

export class CodecError extends Data.TaggedError("CodecError")<{
  readonly reason: "unknown_field" | "bad_type" | "out_of_range" | "bad_length";
  readonly message: string;
  readonly field?: string;
}> {}

export class ClientError extends Data.TaggedError("ClientError")<{
  readonly reason: "timeout" | "http" | "too_large" | "bad_json" | "rippled_error" | "no_result" | "closed" | "bad_input" | "fee_too_high";
  readonly message: string;
}> {}
