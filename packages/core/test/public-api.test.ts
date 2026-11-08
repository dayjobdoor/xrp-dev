import { Cause, Effect, Exit } from "effect";
import { encode as oracleEncode } from "ripple-binary-codec";
import { describe, expect, it } from "vite-plus/test";
import {
  AddressError,
  ClientError,
  CodecError,
  CryptoError,
  autofill,
  base58CheckDecode,
  bytesToHex,
  classicToXAddress,
  createRpcClient,
  decode,
  decodeAccountId,
  ed25519,
  encode,
  encodeAccountId,
  encodeForSigning,
  hashTransaction,
  isValidClassicAddress,
  publicKeyToAddress,
  secp256k1,
  sha256,
  sha512Half,
  signerMatchesAccount,
  submit,
  verifyTransaction,
  xAddressToClassic,
  type RpcClient,
  type TxJson,
} from "../src/index.js";
import { decodeAccountId as decodeAccountIdFx } from "../src/effect/address.js";
import { lift, liftTotal } from "../src/effect/lift.js";

const GENESIS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const utf8 = (s: string) => new TextEncoder().encode(s);

const privateKey = new Uint8Array(32).fill(7);
const signedPayment = (): TxJson => {
  const publicKey = "ED" + bytesToHex(ed25519.getPublicKey(privateKey));
  const tx: TxJson = {
    TransactionType: "Payment",
    Account: publicKeyToAddress(publicKey),
    Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
    Amount: "1000000",
    Fee: "12",
    Sequence: 7,
    SigningPubKey: publicKey,
  };
  return { ...tx, TxnSignature: bytesToHex(ed25519.sign(encodeForSigning(tx), privateKey)) };
};

describe("sync API: values come back, failures are thrown", () => {
  it("addresses: X-address round trip and validation, no await", () => {
    const x = classicToXAddress(GENESIS, 12345, false);
    expect(x).toBe("XVPcpSm47b1CZkf5AkKM9a84dQHe3mTAxgxfLw2qYoe7Boa");
    expect(xAddressToClassic(x)).toEqual({ classicAddress: GENESIS, tag: 12345, test: false });
    expect(isValidClassicAddress(GENESIS)).toBe(true);
    expect(isValidClassicAddress(GENESIS.slice(0, -1) + "x")).toBe(false);
    expect(encodeAccountId(decodeAccountId(GENESIS))).toBe(GENESIS);
  });

  it("a failure throws the exported error class, so instanceof narrows it", () => {
    let caught: unknown;
    try {
      decodeAccountId("not an address");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AddressError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as AddressError).reason).toBeTypeOf("string");
    expect(() => decode("zz")).toThrow(CodecError);
    expect(() => base58CheckDecode("0OIl")).toThrow(CryptoError);
    expect(() => secp256k1.sign(new Uint8Array(32), new Uint8Array(32))).toThrow(CryptoError);
  });

  it("digests match the published vectors", () => {
    expect(bytesToHex(sha256(utf8("abc")))).toBe("BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD");
    expect(bytesToHex(sha512Half(utf8("abc")))).toBe("DDAF35A193617ABACC417349AE20413112E6FA4E89A97EA20A9EEEE64B55D39A");
  });

  it("codec: bytes equal ripple-binary-codec, round trip, and the transaction id is the hash of the blob", () => {
    const tx = signedPayment();
    const blob = encode(tx);
    expect(blob).toBe(oracleEncode(tx));
    expect(encode(decode(blob))).toBe(blob);
    expect(hashTransaction(blob)).toMatch(/^[0-9A-F]{64}$/);
    expect(hashTransaction(blob)).not.toBe(hashTransaction(encode({ ...tx, Sequence: 8 })));
  });

  it("signatures: a signed blob verifies, a changed one does not, the key matches the account", () => {
    const blob = encode(signedPayment());
    expect(verifyTransaction(blob)).toBe(true);
    expect(signerMatchesAccount(blob)).toBe(true);
    expect(verifyTransaction(encode({ ...decode(blob), Amount: "2000000" }))).toBe(false);
  });
});

const json = (b: unknown, init?: ResponseInit) => new Response(JSON.stringify(b), init);
const fakeFetch = (f: () => Response) => (() => Promise.resolve(f())) as unknown as typeof globalThis.fetch;
const rejection = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

describe("client API: Promises that reject with ClientError", () => {
  it("request resolves to the result and rejects with the tagged error", async () => {
    const ok = createRpcClient({ url: "http://x/", fetch: fakeFetch(() => json({ result: { status: "success", a: 1 } })) });
    expect(await ok.request("ping")).toEqual({ status: "success", a: 1 });

    const down = createRpcClient({ url: "http://x/", fetch: fakeFetch(() => json({}, { status: 503 })) });
    const e = await rejection(down.request("ping"));
    expect(e).toBeInstanceOf(ClientError);
    expect((e as ClientError).reason).toBe("http");

    const refused = createRpcClient({ url: "http://x/", fetch: fakeFetch(() => json({ result: { status: "error", error: "actNotFound" } })) });
    expect((await rejection(refused.request("account_info")) as ClientError).reason).toBe("rippled_error");
  });

  const stub = (handlers: Record<string, unknown>): RpcClient => ({
    request: (async (method: string) => handlers[method]) as RpcClient["request"],
  });

  it("autofill fills the missing fields from a client written with plain Promises", async () => {
    const client = stub({ fee: { drops: { open_ledger_fee: "12" }, ledger_current_index: 100 }, account_info: { account_data: { Sequence: 7 } } });
    expect(await autofill(client, { Account: "rA", TransactionType: "Payment" })).toEqual({
      Account: "rA",
      TransactionType: "Payment",
      Fee: "12",
      Sequence: 7,
      LastLedgerSequence: 120,
    });
  });

  it("a client that rejects with a plain Error surfaces as ClientError, a ClientError is kept", async () => {
    const plain: RpcClient = { request: () => Promise.reject(new Error("socket hang up")) };
    const e = await rejection(autofill(plain, { Account: "rA" }));
    expect(e).toBeInstanceOf(ClientError);
    expect((e as ClientError).reason).toBe("http");
    expect((e as ClientError).message).toContain("socket hang up");

    const timeout = new ClientError({ reason: "timeout", message: "slow" });
    const kept = await rejection(submit({ request: () => Promise.reject(timeout) }, "AB"));
    expect((kept as ClientError).reason).toBe("timeout");
  });

  it("submit sends the blob and resolves to the engine result", async () => {
    let seen: unknown;
    const client: RpcClient = {
      request: (async (method: string, params?: object) => ((seen = { method, params }), { engine_result: "tesSUCCESS", engine_result_message: "ok" })) as RpcClient["request"],
    };
    expect((await submit(client, "1200")).engine_result).toBe("tesSUCCESS");
    expect(seen).toEqual({ method: "submit", params: { tx_blob: "1200" } });
  });
});

describe("client API: failures reach the caller as ClientError", () => {
  const reasonOf = async (p: Promise<unknown>) => ((await rejection(p)) as ClientError).reason;
  // Like a real fetch: never answers, but rejects when its request is aborted.
  const hang = ((_url: string, init: RequestInit) =>
    new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof globalThis.fetch;

  it("times out, rejects a body that is not JSON, and rejects an oversized body", async () => {
    expect(await reasonOf(createRpcClient({ url: "http://x/", fetch: hang, timeoutMs: 20 }).request("ping"))).toBe("timeout");
    expect(await reasonOf(createRpcClient({ url: "http://x/", fetch: fakeFetch(() => new Response("nope")) }).request("ping"))).toBe("bad_json");
    const big = fakeFetch(() => new Response("x".repeat(100)));
    expect(await reasonOf(createRpcClient({ url: "http://x/", fetch: big, maxBodyBytes: 10 }).request("ping"))).toBe("too_large");
  });

  it("a custom client that rejects with a non-Error, or throws synchronously, becomes an http ClientError", async () => {
    const nonError: RpcClient = { request: () => Promise.reject("nope") };
    const e = (await rejection(submit(nonError, "AB"))) as ClientError;
    expect([e.reason, e.message]).toEqual(["http", "request failed"]);
    const throws: RpcClient = { request: () => { throw new Error("sync boom"); } };
    const e2 = (await rejection(submit(throws, "AB"))) as ClientError;
    expect([e2.reason, e2.message]).toEqual(["http", "sync boom"]);
  });

  it("a ClientError from a custom client comes back as the very same instance", async () => {
    const original = new ClientError({ reason: "closed", message: "gone" });
    expect(await rejection(submit({ request: () => Promise.reject(original) }, "AB"))).toBe(original);
  });
});

describe("client API: abort and timeout", () => {
  const reasonOf = async (p: Promise<unknown>) => ((await rejection(p)) as ClientError).reason;
  const abortAware = (seen: { aborted?: boolean }) =>
    ((_url: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => {
          seen.aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }),
      )) as unknown as typeof globalThis.fetch;

  it("aborting a request rejects with `aborted` and aborts the fetch", async () => {
    const seen: { aborted?: boolean } = {};
    const ac = new AbortController();
    const pending = createRpcClient({ url: "http://x/", fetch: abortAware(seen) }).request("ping", undefined, { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    expect(await reasonOf(pending)).toBe("aborted");
    expect(seen.aborted).toBe(true);
  });

  it("a signal that is already aborted rejects with `aborted`", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await reasonOf(createRpcClient({ url: "http://x/", fetch: abortAware({}) }).request("ping", undefined, { signal: ac.signal }))).toBe("aborted");
  });

  it("a custom client is handed the signal, and it fires on abort and on timeout", async () => {
    const seen: AbortSignal[] = [];
    const slow: RpcClient = { request: ((_m: string, _p?: object, o?: { signal?: AbortSignal }) => (o?.signal && seen.push(o.signal), new Promise(() => {}))) as RpcClient["request"] };
    const ac = new AbortController();
    const pending = submit(slow, "AB", { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    expect(await reasonOf(pending)).toBe("aborted");
    expect(seen[0]?.aborted).toBe(true);
    expect(await reasonOf(submit(slow, "AB", { timeoutMs: 20 }))).toBe("timeout");
    expect(seen[1]?.aborted).toBe(true);
  });

  it("timeoutMs bounds all the requests of an autofill together", async () => {
    let calls = 0;
    const slowEach: RpcClient = { request: (() => (calls++, new Promise<unknown>((r) => setTimeout(() => r({ drops: { open_ledger_fee: "10" }, ledger_current_index: 5, account_data: { Sequence: 1 } }), 40)))) as RpcClient["request"] };
    expect(await reasonOf(autofill(slowEach, { Account: "rA", TransactionType: "Payment" }, { timeoutMs: 60 }))).toBe("timeout");
    expect(calls).toBeLessThan(3);
  });
});

describe("Effect adapters over the plain functions", () => {
  it("fail with the error class the plain function throws, and catchTag matches it", async () => {
    const failed = await Effect.runPromise(Effect.flip(decodeAccountIdFx("not an address")));
    expect(failed).toBeInstanceOf(AddressError);
    const recovered = decodeAccountIdFx("not an address").pipe(Effect.catchTag("AddressError", (e) => Effect.succeed(`caught ${e.reason}`)));
    expect(await Effect.runPromise(recovered)).toMatch(/^caught bad_/);
  });

  const exitOf = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromiseExit(e);

  it("lift: a known error is a typed failure, a throw that is not ours is a defect", async () => {
    const typed = await exitOf(lift(AddressError)(() => { throw new AddressError({ reason: "bad_key", message: "m" }); })());
    const buggy = await exitOf(lift(AddressError)(() => { throw new TypeError("boom"); })());
    expect(Exit.isFailure(typed) && Cause.hasFails(typed.cause) && !Cause.hasDies(typed.cause)).toBe(true);
    expect(Exit.isFailure(buggy) && Cause.hasDies(buggy.cause) && !Cause.hasFails(buggy.cause)).toBe(true);
  });

  it("lift: an error of another of our classes is a defect, so the declared error type is true", async () => {
    const wrongClass = await exitOf(lift(CodecError)(() => { throw new AddressError({ reason: "bad_key", message: "m" }); })());
    expect(Exit.isFailure(wrongClass) && Cause.hasDies(wrongClass.cause) && !Cause.hasFails(wrongClass.cause)).toBe(true);
  });

  it("liftTotal: a throw is a defect, never a failure", async () => {
    const exit = await exitOf(liftTotal(() => { throw new RangeError("boom"); })());
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause)).toBe(true);
  });

  it("is lazy and re-evaluates: building the Effect does not call the function, running it twice calls it twice", async () => {
    let calls = 0;
    const effect = lift(CodecError)(() => ++calls)();
    expect(calls).toBe(0);
    expect([await Effect.runPromise(effect), await Effect.runPromise(effect)]).toEqual([1, 2]);
  });
});

describe("errors keep the cause", () => {
  it("an address failure from base58 has the CryptoError as its cause", () => {
    let thrown: unknown;
    try {
      decodeAccountId("0OIl");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AddressError);
    expect((thrown as AddressError).cause).toBeInstanceOf(CryptoError);
  });
});
