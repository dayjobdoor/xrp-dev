import { Effect } from "effect";
import * as fx from "./effect/client.js";
import { decode, hashTransaction, type TxJson } from "./codec.js";
import { ClientError } from "./errors.js";

export { ClientError };
export { NETWORKS, NETWORK_PRESETS, PUBLIC_RPC_URLS } from "./effect/client.js";
export type { Network, NetworkKey, NetworkPreset, RequestOptions, SubmitResult } from "./effect/client.js";

/** Anything that can send a rippled request. A failure rejects with `ClientError`. `options.signal` aborts the request. */
export interface RpcClient {
  request<T = unknown>(method: string, params?: object, options?: fx.RequestOptions): Promise<T>;
}

/** `signal` aborts the call (it rejects with `ClientError` reason `aborted`); `timeoutMs` bounds the whole call (reason `timeout`). */
export interface CallOptions extends fx.RequestOptions {
  timeoutMs?: number;
}

const run = async <A>(effect: Effect.Effect<A, ClientError>, { signal, timeoutMs }: CallOptions = {}): Promise<A> => {
  const bounded =
    timeoutMs === undefined
      ? effect
      : effect.pipe(Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(new ClientError({ reason: "timeout", message: `timed out after ${timeoutMs} ms` })) }));
  try {
    return await Effect.runPromise(bounded, signal === undefined ? undefined : { signal });
  } catch (e) {
    if (signal?.aborted) throw new ClientError({ reason: "aborted", message: "request aborted", cause: e });
    throw e;
  }
};

// Effect -> Promise. A typed failure rejects with the ClientError itself. This entry runs Effects, so it (and `xrp-dev`, which
// re-exports it) is the one plain entry that depends on `effect`.
const toPromiseClient = (client: fx.RpcClient): RpcClient => ({
  request: <T = unknown>(method: string, params?: object, options?: fx.RequestOptions) => run(client.request<T>(method, params), options),
});

export const createRpcClient = (opts: Parameters<typeof fx.createRpcClient>[0]): RpcClient => toPromiseClient(fx.createRpcClient(opts));

export const createWsClient = (opts: Parameters<typeof fx.createWsClient>[0]): RpcClient & { close(): Promise<void> } => {
  const client = fx.createWsClient(opts);
  return { ...toPromiseClient(client), close: () => Effect.runPromise(client.close()) };
};

/**
 * Fills only missing Fee, Sequence, LastLedgerSequence and, on a network whose id is above 1024 (Xahau), NetworkID. A
 * Fee above `maxFeeDrops` (default 100000 drops = 0.1 XRP) rejects with `ClientError` (`fee_too_high`) rather than clamps,
 * whether the caller or the node supplied it, so a hostile node can burn at most the cap. With `definitions` the fee is asked
 * for this very transaction (`fee` with `tx_blob`). It makes up to three requests; `timeoutMs` bounds all of them together.
 */
export const autofill = (client: RpcClient, tx: TxJson, opts: NonNullable<Parameters<typeof fx.autofill>[2]> & CallOptions = {}): Promise<TxJson> =>
  run(fx.autofill(client, tx, opts), opts);

/** Submits an already signed hex blob; does not sign. */
export const submit = (client: RpcClient, txBlob: string, options?: CallOptions): Promise<fx.SubmitResult> => run(fx.submit(client, txBlob), options);

export interface SubmitAndWaitOptions extends fx.RequestOptions {
  /** Gives up after this long (reason `timeout`). Default 90 s, about the life of a `LastLedgerSequence` that `autofill` sets. */
  timeoutMs?: number;
  /** Time between looks at the ledger. Default 1 s. */
  intervalMs?: number;
}

export interface SubmitAndWaitResult {
  hash: string;
  /** The node's first answer to `submit` (`tesSUCCESS`: in the open ledger only; `terQUEUED`: queued). */
  engine_result: string;
  /** The result in the validated ledger: `tesSUCCESS`, or a `tec...` code (applied, the fee is spent, no effect). */
  transaction_result: string;
  /** The node's `tx` answer for the validated transaction. */
  tx: Record<string, unknown>;
}

const aborted = () => new ClientError({ reason: "aborted", message: "request aborted" });
const withSignal = (signal: AbortSignal | undefined): fx.RequestOptions => (signal === undefined ? {} : { signal });

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    const onAbort = () => (clearTimeout(timer), reject(aborted()));
    const timer = setTimeout(() => (signal?.removeEventListener("abort", onAbort), resolve()), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const transactionResult = (tx: Record<string, unknown>): string => {
  const meta = tx.meta;
  return typeof meta === "object" && meta !== null && "TransactionResult" in meta && typeof meta.TransactionResult === "string" ? meta.TransactionResult : "unknown";
};

// rippled answers `txnNotFound` ("Transaction not found.") until the transaction is in a ledger; `ClientError` keeps the text.
const notFoundYet = (e: unknown) => e instanceof ClientError && e.reason === "rippled_error" && /txnNotFound|not found/i.test(e.message);

// A node that was busy, a connection that dropped, an answer cut short: asking again may work. A caller's abort and a request
// that is wrong in itself will not get better. Anything that is not a ClientError is a bug in a custom client and surfaces.
const retryable = (e: unknown): e is ClientError =>
  e instanceof ClientError && e.reason !== "aborted" && e.reason !== "bad_input" && e.reason !== "rejected" && e.reason !== "expired";

// The node already has this very transaction, or its Sequence is spent: whether that is ours is for the ledger to say.
const resubmitted = (engineResult: string) => engineResult === "tefALREADY" || engineResult === "tefPAST_SEQ";

/**
 * Submits a signed blob and waits until it is in a validated ledger, like xrpl.js' `submitAndWait`. Rejects with
 * `ClientError`: `rejected` when the node refuses it for good (`tem`, `tef`, `tel`), `expired` when the validated ledger
 * passes its `LastLedgerSequence` without it, `timeout` or `aborted`. A blob that does not decode rejects with `CodecError`,
 * before anything is sent. A `tec` code is a validated outcome, so it resolves:
 * check `transaction_result`.
 *
 * `timeoutMs` is one deadline for the whole call: submit, every look at the ledger and every sleep between them. After the
 * submit, an error from the node while looking (a dropped connection, a busy node) is retried until that deadline, so a
 * hiccup does not make the caller resubmit; the `timeout` then carries the last error as its `cause`.
 * A blob that was already submitted (the node answers `tefALREADY` or `tefPAST_SEQ`) is not refused out of hand: the
 * transaction is looked up by hash. In a validated ledger it resolves with the ledger's result (`engine_result` stays the
 * node's `tef` answer); `tefPAST_SEQ` with no such transaction means another one took the Sequence, which is `rejected`.
 */
export const submitAndWait = async (client: RpcClient, txBlob: string, options: SubmitAndWaitOptions = {}): Promise<SubmitAndWaitResult> => {
  const { timeoutMs = 90_000, intervalMs = 1_000, signal } = options;
  const lastLedger = decode(txBlob).LastLedgerSequence;
  const hash = hashTransaction(txBlob);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  const deadlines = new WeakSet<object>();
  const timedOut = () => {
    const e = new ClientError({
      reason: "timeout",
      message: `not validated within ${timeoutMs} ms${lastError instanceof Error ? ` (last error: ${lastError.message})` : ""}`,
      ...(lastError === undefined ? {} : { cause: lastError }),
    });
    deadlines.add(e);
    return e;
  };

  // One request, cut off at the call's deadline even if the client ignores its signal.
  const ask = <T>(method: string, params: object): Promise<T> => {
    if (signal?.aborted) return Promise.reject(aborted());
    const left = deadline - Date.now();
    if (left <= 0) return Promise.reject(timedOut());
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clock = new Promise<never>((_, reject) => {
      timer = setTimeout(() => (reject(timedOut()), stop.abort()), left);
    });
    // `new Promise` turns a synchronous throw of a custom client into a rejection, so the cleanup below still runs.
    return Promise.race([new Promise<T>((resolve) => resolve(client.request<T>(method, params, { signal: stop.signal }))), clock])
      .catch((e: unknown) => {
        throw signal?.aborted ? aborted() : e;
      })
      .finally(() => (clearTimeout(timer), signal?.removeEventListener("abort", onAbort)));
  };

  const sent = await submit(client, txBlob, { ...withSignal(signal), timeoutMs });
  if (/^te[mfl]/.test(sent.engine_result) && !resubmitted(sent.engine_result)) throw new ClientError({ reason: "rejected", message: `${sent.engine_result}: ${sent.engine_result_message}` });
  for (;;) {
    try {
      // The validated ledger index is read before the lookup, so a transaction validated in between is not reported as expired.
      const ledger = await ask<{ ledger_index?: unknown } | undefined>("ledger", { ledger_index: "validated" });
      const found = await ask<Record<string, unknown>>("tx", { transaction: hash }).catch((e: unknown) => {
        if (notFoundYet(e)) return undefined;
        throw e;
      });
      if (found?.validated === true) {
        return { hash, engine_result: sent.engine_result, transaction_result: transactionResult(found), tx: found };
      }
      if (found === undefined && sent.engine_result === "tefPAST_SEQ")
        throw new ClientError({ reason: "rejected", message: `${sent.engine_result}: ${sent.engine_result_message}; the transaction is not in any ledger, so another one used the Sequence` });
      const index = ledger?.ledger_index;
      if (typeof lastLedger === "number" && typeof index === "number" && index > lastLedger)
        throw new ClientError({ reason: "expired", message: `ledger ${index} is past LastLedgerSequence ${lastLedger} and the transaction is not in it` });
      lastError = undefined;
    } catch (e) {
      if (!retryable(e) || deadlines.has(e)) throw e;
      if (Date.now() >= deadline) throw timedOut();
      lastError = e;
    }
    if (Date.now() + intervalMs > deadline) throw timedOut();
    await sleep(intervalMs, signal);
  }
};

export type ClientOptions = Omit<Parameters<typeof fx.createRpcClient>[0], "url"> & Omit<Parameters<typeof fx.createWsClient>[0], "url">;

/**
 * xrpl.js-style entry: one object that holds the connection. `url` is an `https://` JSON-RPC or a `wss://` WebSocket
 * address, or `"mainnet"` / `"testnet"` / `"devnet"` for the public node. It also works wherever an `RpcClient` is expected.
 */
export class Client implements RpcClient {
  readonly #rpc: RpcClient & { close?(): Promise<void> };

  constructor(url: string, options: ClientOptions = {}) {
    const network = fx.NETWORKS.find((n) => n === url);
    const address = network === undefined ? url : fx.PUBLIC_RPC_URLS[network];
    this.#rpc = /^wss?:/i.test(address) ? createWsClient({ url: address, ...options }) : createRpcClient({ url: address, ...options });
  }

  /** Checks that the node answers (a `ping`); a WebSocket client opens its socket here. Requests also connect on their own. */
  async connect(options?: fx.RequestOptions): Promise<void> {
    await this.#rpc.request("ping", undefined, options);
  }

  /** Closes a WebSocket (pending requests reject with `closed`); nothing to do for JSON-RPC. A later request opens a new socket. */
  async disconnect(): Promise<void> {
    await this.#rpc.close?.();
  }

  /** `request("account_info", { account })` or xrpl.js style `request({ command: "account_info", account })`. Resolves to the node's `result`. */
  request<T = unknown>(method: string, params?: object, options?: fx.RequestOptions): Promise<T>;
  request<T = unknown>(req: { command: string } & Record<string, unknown>, options?: fx.RequestOptions): Promise<T>;
  request<T = unknown>(a: string | ({ command: string } & Record<string, unknown>), b?: object | fx.RequestOptions, c?: fx.RequestOptions): Promise<T> {
    if (typeof a === "string") return this.#rpc.request<T>(a, b, c);
    const { command, ...params } = a;
    return this.#rpc.request<T>(command, params, b);
  }

  autofill(tx: TxJson, opts?: Parameters<typeof autofill>[2]): Promise<TxJson> {
    return autofill(this.#rpc, tx, opts);
  }

  submit(txBlob: string, options?: CallOptions): Promise<fx.SubmitResult> {
    return submit(this.#rpc, txBlob, options);
  }

  submitAndWait(txBlob: string, options?: SubmitAndWaitOptions): Promise<SubmitAndWaitResult> {
    return submitAndWait(this.#rpc, txBlob, options);
  }
}
