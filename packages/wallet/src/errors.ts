import { Data } from "effect";

export class WalletError extends Data.TaggedError("WalletError")<{
  readonly reason: "bad_seed" | "bad_entropy" | "bad_secret_numbers" | "bad_checksum" | "bad_key" | "bad_prf" | "bad_message" | "bad_tx" | "refused" | "destroyed";
  readonly message: string;
  /** 1-based group for `bad_checksum`. */
  readonly position?: number;
}> {}
