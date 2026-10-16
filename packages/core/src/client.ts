import { Effect } from "effect";
import { ClientError } from "./errors.js";
import type { TxJson } from "./codec.js";

export { ClientError };

// Long enough for a loaded public node, short enough that a dead one does not stall a UI.
const DEFAULT_TIMEOUT_MS = 10_000;
// Above any legitimate rippled reply this client reads (account_tx pages are the largest).
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
// 0.1 XRP, about 10,000x the 10-drop reference fee: a hostile node can burn at most this much.
const DEFAULT_MAX_FEE_DROPS = 100_000n;
// ~3-5 s per ledger, so a signed transaction stays valid for roughly a minute and then can never apply.
const LAST_LEDGER_OFFSET = 20;

export const NETWORKS = ["mainnet", "testnet", "devnet"] as const;
export type Network = (typeof NETWORKS)[number];

/**
 * Public JSON-RPC nodes. mainnet and testnet answer the CORS preflight, so browsers can use them. rippled's own
 * s1.ripple.com / s.altnet.rippletest.net answer it with 400 and were rejected for that reason. devnet has no
 * CORS-enabled public JSON-RPC: in a browser use `createWsClient` (WebSocket is not subject to CORS) or a
 * same-origin proxy.
 */
export const PUBLIC_RPC_URLS: Record<Network, string> = {
  mainnet: "https://xrplcluster.com/",
  testnet: "https://testnet.xrpl-labs.com/",
  devnet: "https://s.devnet.rippletest.net:51234/",
};

export interface RpcClient {
  request<T = unknown>(method: string, params?: object): Effect.Effect<T, ClientError>;
}

export interface SubmitResult {
  engine_result: string;
  engine_result_message: string;
  tx_json?: TxJson;
  accepted?: boolean;
  applied?: boolean;
  broadcast?: boolean;
  [key: string]: unknown;
}

const err = (reason: ClientError["reason"], message: string) => new ClientError({ reason, message });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Maps a rippled result object (HTTP `result` or WS message) to success or a ClientError. */
const unwrap = (method: string, result: unknown, outer?: Record<string, unknown>): Record<string, unknown> => {
  if (!isObject(result)) {
    if (outer && (outer.status === "error" || outer.error !== undefined)) return fail(method, outer);
    throw err("no_result", `${method}: response has no result`);
  }
  if (result.status === "error" || result.error !== undefined) return fail(method, result);
  if (outer && outer.status === "error") return fail(method, outer);
  return result;
};

const fail = (method: string, r: Record<string, unknown>): never => {
  throw err("rippled_error", `${method}: ${String(r.error_message ?? r.error)}`);
};

const asClientError = (e: unknown, signal?: AbortSignal): ClientError =>
  e instanceof ClientError
    ? e
    : signal?.aborted
      ? err("timeout", "request timed out")
      : err("http", e instanceof Error ? e.message : "request failed");

/** Reads the body as text, throwing too_large as soon as the byte cap is passed. */
const readText = async (res: Response, max: number): Promise<string> => {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw err("too_large", `response body exceeds ${max} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
};

export const createRpcClient = (opts: {
  url: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
}): RpcClient => {
  const { url, timeoutMs = DEFAULT_TIMEOUT_MS, maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = opts;
  return {
    request: <T = unknown>(method: string, params: object = {}) =>
      // Built per run, so a retried or late-run Effect gets a fresh timeout.
      Effect.suspend(() => {
        const timeout = AbortSignal.timeout(timeoutMs);
        return Effect.tryPromise({
          try: async (interrupt) => {
            const send = opts.fetch ?? globalThis.fetch;
            const res = await send(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ method, params: [params] }),
              signal: AbortSignal.any([interrupt, timeout]),
              redirect: "error", // a node must not bounce a signed request to another host
            });
            if (!res.ok) throw err("http", `${method}: HTTP ${res.status}`);
            const text = await readText(res, maxBodyBytes);
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              throw err("bad_json", `${method}: response is not valid JSON`);
            }
            return unwrap(method, isObject(body) ? body.result : undefined) as T;
          },
          catch: (e) => asClientError(e, timeout),
        });
      }),
  };
};

interface Pending {
  resolve(v: unknown): void;
  reject(e: ClientError): void;
}

export const createWsClient = (opts: {
  url: string;
  WebSocket?: typeof globalThis.WebSocket;
  timeoutMs?: number;
}): RpcClient & { close(): Effect.Effect<void> } => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let socket: Promise<WebSocket> | undefined;
  let current: WebSocket | undefined;

  const failAll = (message: string) => {
    socket = undefined;
    current = undefined;
    const all = [...pending.values()];
    pending.clear();
    for (const p of all) p.reject(err("closed", message));
  };

  // Also the timeout path: a silent half-open socket would otherwise be reused, and time out, forever.
  const recycle = () => {
    const ws = current;
    failAll("websocket closed");
    ws?.close();
  };

  const connect = (): Promise<WebSocket> =>
    (socket ??= new Promise<WebSocket>((resolve, reject) => {
      const WS = opts.WebSocket ?? globalThis.WebSocket;
      const ws = new WS(opts.url);
      current = ws;
      ws.addEventListener("open", () => resolve(ws));
      ws.addEventListener("message", (ev) => {
        let msg: unknown;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (!isObject(msg) || typeof msg.id !== "number") return;
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        p.resolve(msg);
      });
      const down = () => {
        // A stale socket (replaced after close()) must not tear down its successor.
        if (current === ws) failAll("websocket closed");
        reject(err("closed", "websocket closed"));
      };
      ws.addEventListener("error", down);
      ws.addEventListener("close", down);
    }));

  return {
    request: <T = unknown>(method: string, params: object = {}) =>
      Effect.tryPromise({
        try: async (interrupt) => {
          const id = nextId++;
          // The timer covers connecting too, so a socket that never opens cannot hang the request.
          const msg = await new Promise<Record<string, unknown>>((resolve, reject) => {
            const settle = () => (clearTimeout(timer), pending.delete(id));
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(err("timeout", `${method}: request timed out`));
              recycle();
            }, timeoutMs);
            pending.set(id, {
              resolve: (v) => (clearTimeout(timer), resolve(v as Record<string, unknown>)),
              reject: (e) => (clearTimeout(timer), reject(e)),
            });
            interrupt.addEventListener("abort", settle, { once: true });
            connect()
              // The request may have timed out or been interrupted while connecting; sending then would broadcast a submit the caller was told failed.
              .then((ws) => pending.has(id) && ws.send(JSON.stringify({ ...params, id, command: method })))
              .catch((e) => (settle(), reject(e)));
          });
          return unwrap(method, msg.result, msg) as T;
        },
        catch: (e) => asClientError(e),
      }),
    close: () => Effect.sync(recycle),
  };
};

const isLedgerIndex = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/**
 * Fills only missing Fee, Sequence and LastLedgerSequence. A Fee above `maxFeeDrops` (default 100000 drops = 0.1 XRP,
 * about 10,000x the reference fee) fails rather than clamps, whether the caller or the node supplied it, so a hostile
 * node can burn at most the cap.
 */
export const autofill = (client: RpcClient, tx: TxJson, opts: { maxFeeDrops?: bigint } = {}): Effect.Effect<TxJson, ClientError> =>
  Effect.gen(function* () {
    const maxFee = opts.maxFeeDrops ?? DEFAULT_MAX_FEE_DROPS;
    const out: TxJson = { ...tx };
    const needFee = out.Fee === undefined;
    const needLls = out.LastLedgerSequence === undefined;
    let ledger: number | undefined;
    if (needFee || needLls) {
      const fee = yield* client.request<{ drops?: { open_ledger_fee?: string }; ledger_current_index?: number }>("fee");
      if (needFee) {
        const f = fee.drops?.open_ledger_fee;
        if (typeof f !== "string" || !/^\d+$/.test(f)) return yield* Effect.fail(err("no_result", "fee: missing drops.open_ledger_fee"));
        out.Fee = f;
      }
      ledger = fee.ledger_current_index;
    }
    const finalFee = String(out.Fee);
    if (/^\d+$/.test(finalFee) && BigInt(finalFee) > maxFee)
      return yield* Effect.fail(err("fee_too_high", `fee: ${finalFee} drops exceeds the ${maxFee} drop cap`));
    if (needLls) {
      if (!isLedgerIndex(ledger)) {
        const lc = yield* client.request<{ ledger_current_index?: number }>("ledger_current");
        ledger = lc.ledger_current_index;
      }
      if (!isLedgerIndex(ledger)) return yield* Effect.fail(err("no_result", "missing or invalid ledger_current_index"));
      out.LastLedgerSequence = ledger + LAST_LEDGER_OFFSET;
    }
    if (out.Sequence === undefined) {
      if (out.TicketSequence !== undefined) {
        out.Sequence = 0; // a ticketed tx must carry Sequence 0
      } else {
        const info = yield* client.request<{ account_data?: { Sequence?: number } }>("account_info", {
          account: out.Account,
          ledger_index: "current",
        });
        const seq = info.account_data?.Sequence;
        if (typeof seq !== "number") return yield* Effect.fail(err("no_result", "account_info: missing Sequence"));
        out.Sequence = seq;
      }
    }
    return out;
  });

/** Submits an already signed hex blob; does not sign. */
export const submit = (client: RpcClient, txBlob: string): Effect.Effect<SubmitResult, ClientError> =>
  /^(?:[0-9a-fA-F]{2})+$/.test(txBlob)
    ? client.request<SubmitResult>("submit", { tx_blob: txBlob })
    : Effect.fail(err("bad_input", "submit: tx_blob must be a non-empty even-length hex string"));
