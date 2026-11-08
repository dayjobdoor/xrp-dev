import { describe, expect, it } from "vite-plus/test";
import {
  Client,
  ClientError,
  autofill,
  submit,
  PUBLIC_RPC_URLS,
  bytesToHex,
  ed25519,
  encode,
  encodeForSigning,
  hashTransaction,
  publicKeyToAddress,
  submitAndWait,
  type RpcClient,
  type TxJson,
} from "../src/index.js";

const key = new Uint8Array(32).fill(7);
const publicKey = "ED" + bytesToHex(ed25519.getPublicKey(key));
const signedBlob = (extra: TxJson = {}) => {
  const tx: TxJson = {
    TransactionType: "Payment",
    Account: publicKeyToAddress(publicKey),
    Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
    Amount: "1",
    Fee: "10",
    Sequence: 1,
    LastLedgerSequence: 100,
    SigningPubKey: publicKey,
    ...extra,
  };
  return encode({ ...tx, TxnSignature: bytesToHex(ed25519.sign(encodeForSigning(tx), key)) });
};

// A node stand-in: `answers[method]` is a value, or a function of the call number.
type Answer = unknown | ((n: number) => unknown);
const node = (answers: Record<string, Answer>) => {
  const calls: string[] = [];
  const counts: Record<string, number> = {};
  const client: RpcClient = {
    request: (async (method: string) => {
      calls.push(method);
      counts[method] = (counts[method] ?? 0) + 1;
      const a = answers[method];
      const v = typeof a === "function" ? (a as (n: number) => unknown)(counts[method]!) : a;
      if (v instanceof Error) throw v;
      return v;
    }) as RpcClient["request"],
  };
  return { client, calls };
};
const notFound = new ClientError({ reason: "rippled_error", message: "tx: Transaction not found." });
const reasonOf = async (p: Promise<unknown>) => ((await p.then(() => undefined, (e: unknown) => e)) as ClientError).reason;
const fast = { intervalMs: 5 };

describe("submitAndWait", () => {
  it("polls until the transaction is validated and returns its result", async () => {
    const blob = signedBlob();
    const { client, calls } = node({
      submit: { engine_result: "tesSUCCESS", engine_result_message: "ok" },
      ledger: (n: number) => ({ ledger_index: 50 + n }),
      tx: (n: number) => (n < 3 ? notFound : { validated: true, meta: { TransactionResult: "tesSUCCESS" }, ledger_index: 53 }),
    });
    const r = await submitAndWait(client, blob, fast);
    expect(r).toMatchObject({ hash: hashTransaction(blob), engine_result: "tesSUCCESS", transaction_result: "tesSUCCESS" });
    expect(calls.filter((c) => c === "submit")).toHaveLength(1);
    expect(calls.filter((c) => c === "tx")).toHaveLength(3);
  });

  it("a tec code is a validated outcome: it resolves and says so", async () => {
    const { client } = node({
      submit: { engine_result: "tesSUCCESS", engine_result_message: "ok" },
      ledger: { ledger_index: 60 },
      tx: { validated: true, meta: { TransactionResult: "tecUNFUNDED_PAYMENT" } },
    });
    expect((await submitAndWait(client, signedBlob(), fast)).transaction_result).toBe("tecUNFUNDED_PAYMENT");
  });

  it("is rejected at once when the node refuses it for good, without polling", async () => {
    for (const code of ["temBAD_FEE", "tefPAST_SEQ", "telINSUF_FEE_P"]) {
      const { client, calls } = node({ submit: { engine_result: code, engine_result_message: "no" } });
      expect(await reasonOf(submitAndWait(client, signedBlob(), fast))).toBe("rejected");
      expect(calls).toEqual(["submit"]);
    }
  });

  it("a queued transaction (terQUEUED) is waited for like any other", async () => {
    const { client } = node({
      submit: { engine_result: "terQUEUED", engine_result_message: "queued" },
      ledger: { ledger_index: 60 },
      tx: (n: number) => (n < 2 ? notFound : { validated: true, meta: { TransactionResult: "tesSUCCESS" } }),
    });
    expect((await submitAndWait(client, signedBlob(), fast)).engine_result).toBe("terQUEUED");
  });

  it("expires when the validated ledger passes LastLedgerSequence without the transaction", async () => {
    const { client } = node({ submit: { engine_result: "tesSUCCESS", engine_result_message: "ok" }, ledger: (n: number) => ({ ledger_index: 98 + n }), tx: notFound });
    expect(await reasonOf(submitAndWait(client, signedBlob(), fast))).toBe("expired");
  });

  it("a transaction validated between the two reads is not reported as expired", async () => {
    // The ledger is already past LastLedgerSequence when read, but the tx lookup that follows finds it validated.
    const { client } = node({
      submit: { engine_result: "tesSUCCESS", engine_result_message: "ok" },
      ledger: { ledger_index: 500 },
      tx: { validated: true, meta: { TransactionResult: "tesSUCCESS" } },
    });
    expect((await submitAndWait(client, signedBlob(), fast)).transaction_result).toBe("tesSUCCESS");
  });

  it("any other error from the node is not mistaken for 'not found yet'", async () => {
    const boom = new ClientError({ reason: "rippled_error", message: "tx: Internal error" });
    const { client } = node({ submit: { engine_result: "tesSUCCESS", engine_result_message: "ok" }, ledger: { ledger_index: 1 }, tx: boom });
    expect(await reasonOf(submitAndWait(client, signedBlob(), fast))).toBe("rippled_error");
  });

  it("times out without a LastLedgerSequence, and can be aborted while it waits", async () => {
    const blob = signedBlob({ LastLedgerSequence: undefined });
    const never = node({ submit: { engine_result: "tesSUCCESS", engine_result_message: "ok" }, ledger: { ledger_index: 1 }, tx: notFound });
    expect(await reasonOf(submitAndWait(never.client, blob, { intervalMs: 5, timeoutMs: 40 }))).toBe("timeout");
    const ac = new AbortController();
    const pending = submitAndWait(never.client, blob, { intervalMs: 1_000, timeoutMs: 10_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    expect(await reasonOf(pending)).toBe("aborted");
  });

  it("a blob that does not decode throws CodecError before anything is sent", async () => {
    const { client, calls } = node({});
    await expect(submitAndWait(client, "zz")).rejects.toMatchObject({ _tag: "CodecError" });
    expect(calls).toEqual([]);
  });
});

describe("Client", () => {
  const recorder = () => {
    const seen: { url: string; body: { method: string; params: unknown[] } }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      seen.push({ url, body });
      return Response.json({ result: { status: "success", echoed: body.method } });
    }) as unknown as typeof globalThis.fetch;
    return { seen, fetch };
  };

  it("request takes (method, params) or xrpl.js' { command, ...params }, and resolves to the result", async () => {
    const { seen, fetch } = recorder();
    const client = new Client("http://node.invalid/", { fetch });
    expect(await client.request("account_info", { account: "rA" })).toMatchObject({ echoed: "account_info" });
    expect(await client.request({ command: "account_info", account: "rA", ledger_index: "validated" })).toMatchObject({ echoed: "account_info" });
    expect(seen[0]!.body).toEqual({ method: "account_info", params: [{ account: "rA" }] });
    expect(seen[1]!.body).toEqual({ method: "account_info", params: [{ account: "rA", ledger_index: "validated" }] });
  });

  it("a network name selects the public node, and connect() pings", async () => {
    const { seen, fetch } = recorder();
    await new Client("testnet", { fetch }).connect();
    expect(seen[0]!.url).toBe(PUBLIC_RPC_URLS.testnet);
    expect(seen[0]!.body.method).toBe("ping");
  });

  it("is usable wherever an RpcClient is expected, and has autofill / submit / submitAndWait", async () => {
    const answers: Record<string, unknown> = {
      fee: { drops: { open_ledger_fee: "12" }, ledger_current_index: 100 },
      account_info: { account_data: { Sequence: 7 } },
      submit: { engine_result: "tesSUCCESS", engine_result_message: "ok" },
      ledger: { ledger_index: 60 },
      tx: { validated: true, meta: { TransactionResult: "tesSUCCESS" } },
    };
    const fetch = (async (_url: string, init: RequestInit) => Response.json({ result: { status: "success", ...(answers[JSON.parse(init.body as string).method] as object) } })) as unknown as typeof globalThis.fetch;
    const client = new Client("http://node.invalid/", { fetch });
    expect(await client.autofill({ Account: "rA", TransactionType: "Payment" })).toMatchObject({ Fee: "12", Sequence: 7 });
    expect((await client.submit(signedBlob())).engine_result).toBe("tesSUCCESS");
    expect((await client.submitAndWait(signedBlob(), fast)).transaction_result).toBe("tesSUCCESS");
    await client.disconnect();
  });
});

describe("answers that are not what the type says", () => {
  const tx = { Account: "rA", TransactionType: "Payment" };

  it("autofill rejects with ClientError no_result when an answer is not an object, instead of a TypeError", async () => {
    for (const bad of [null, "x", 5, [], undefined]) {
      expect(await reasonOf(autofill(node({ fee: bad, account_info: { account_data: { Sequence: 1 } } }).client, tx))).toBe("no_result");
      expect(await reasonOf(autofill(node({ fee: { drops: { open_ledger_fee: "10" }, ledger_current_index: 5 }, account_info: bad }).client, tx))).toBe("no_result");
    }
    expect(await reasonOf(autofill(node({ fee: { drops: "oops", ledger_current_index: 5 }, account_info: { account_data: { Sequence: 1 } } }).client, tx))).toBe("no_result");
  });

  it("submit rejects an answer without an engine_result, and fills a missing engine_result_message", async () => {
    for (const bad of [null, {}, { engine_result: 5 }, "tesSUCCESS"]) expect(await reasonOf(submit(node({ submit: bad }).client, "AB"))).toBe("no_result");
    expect(await submit(node({ submit: { engine_result: "tesSUCCESS", applied: true } }).client, "AB")).toEqual({ engine_result: "tesSUCCESS", engine_result_message: "", applied: true });
  });
});
