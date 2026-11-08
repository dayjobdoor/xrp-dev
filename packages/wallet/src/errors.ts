// A plain `Error`, so importing it pulls in no Effect. `_tag` is what `Effect.catchTag` matches.
export type WalletReason = "bad_seed" | "bad_entropy" | "bad_secret_numbers" | "bad_checksum" | "bad_key" | "bad_prf" | "bad_message" | "bad_tx" | "refused" | "destroyed";

export class WalletError extends Error {
  readonly _tag = "WalletError";
  readonly reason: WalletReason;
  /** 1-based group for `bad_checksum`. */
  readonly position?: number;
  constructor(p: { reason: WalletReason; message: string; position?: number; cause?: unknown }) {
    super(p.message, p.cause === undefined ? undefined : { cause: p.cause });
    this.name = "WalletError";
    this.reason = p.reason;
    if (p.position !== undefined) this.position = p.position;
  }
}
