import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { ClientError } from "../src/errors.js";
import { autofill, createRpcClient, createWsClient, submit, type RpcClient } from "../src/effect/client.js";
import { Client, createWsClient as createWsPromiseClient } from "../src/client.js";

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(e));
const json = (b: unknown, init?: ResponseInit) => new Response(JSON.stringify(b), init);
const fakeFetch = (f: (url: string, init: RequestInit) => Response | Promise<Response>) =>
  ((url: string, init: RequestInit) => Promise.resolve(f(url, init))) as unknown as typeof globalThis.fetch;

describe("rpc client", () => {
  it("W-R01 posts method and [params]", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const c = createRpcClient({
      url: "http://x/",
      fetch: fakeFetch((url, init) => ((seen = { url, init }), json({ result: { status: "success", a: 1 } }))),
    });
    expect(await Effect.runPromise(c.request("ping", { b: 2 }))).toEqual({ status: "success", a: 1 });
    expect(seen!.url).toBe("http://x/");
    expect(seen!.init.method).toBe("POST");
    expect(JSON.parse(seen!.init.body as string)).toEqual({ method: "ping", params: [{ b: 2 }] });
    await Effect.runPromise(c.request("ping"));
    expect(JSON.parse(seen!.init.body as string).params).toEqual([{}]);
  });

  it("uses the global fetch looked up at call time", async () => {
    const orig = globalThis.fetch;
    const c = createRpcClient({ url: "http://x/" });
    globalThis.fetch = fakeFetch(() => json({ result: { ok: 1 } }));
    try {
      expect(await Effect.runPromise(c.request("m"))).toEqual({ ok: 1 });
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("W-R02 maps errors", async () => {
    const mk = (r: () => Response) => createRpcClient({ url: "http://x/", fetch: fakeFetch(r) });
    const reason = async (c: RpcClient) => (await run(c.request("m"))).reason;
    expect(await reason(mk(() => json({}, { status: 503 })))).toBe("http");
    expect(await reason(mk(() => new Response("nope")))).toBe("bad_json");
    expect(await reason(mk(() => json({ result: { status: "error", error: "actNotFound" } })))).toBe("rippled_error");
    expect(await reason(mk(() => json({ result: { error: "x" } })))).toBe("rippled_error");
    expect(await reason(mk(() => json({})))).toBe("no_result");
    expect(await reason(mk(() => json({ result: "str" })))).toBe("no_result");
    expect(await reason(mk(() => json(null)))).toBe("no_result");
    const e = await run(mk(() => json({ result: { status: "error", error: "e", error_message: "Account not found." } })).request("account_info"));
    expect(e.message).toBe("account_info: Account not found.");
  });

  it("W-R03 times out via AbortSignal", async () => {
    const f = ((_u: string, init: RequestInit) =>
      new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof globalThis.fetch;
    const c = createRpcClient({ url: "http://x/", fetch: f, timeoutMs: 20 });
    expect((await run(c.request("m"))).reason).toBe("timeout");
  });

  it("timeout starts when the effect runs, and interruption aborts the fetch", async () => {
    const signals: AbortSignal[] = [];
    const f = ((_u: string, init: RequestInit) => (signals.push(init.signal!), Promise.resolve(json({ result: { status: "success" } })))) as unknown as typeof globalThis.fetch;
    const c = createRpcClient({ url: "http://x/", fetch: f, timeoutMs: 500 });
    const eff = c.request("m");
    await new Promise((r) => setTimeout(r, 600)); // longer than the timeout, so an eagerly created signal would be aborted by now
    expect(await Effect.runPromise(eff)).toEqual({ status: "success" });
    expect(signals[0]!.aborted).toBe(false);

    const hang = ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("x"))))) as unknown as typeof globalThis.fetch;
    const fiber = Effect.runFork(createRpcClient({ url: "http://x/", fetch: (u, i) => ((signals.push(i!.signal!), hang(u as string, i!))) as never, timeoutMs: 5000 }).request("m"));
    await tick();
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(signals[1]!.aborted).toBe(true);
  });

  it("never follows a redirect with a signed request", async () => {
    let seen: RequestInit | undefined;
    const c = createRpcClient({ url: "http://x/", fetch: fakeFetch((_u, init) => ((seen = init), json({ result: { ok: 1 } }))) });
    await Effect.runPromise(c.request("m"));
    expect(seen!.redirect).toBe("error");
  });

  it("W-R03 oversize body fails before fully read", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(ctl) {
        pulled++;
        ctl.enqueue(chunk);
      },
    });
    const c = createRpcClient({ url: "http://x/", fetch: fakeFetch(() => new Response(body)) });
    expect((await run(c.request("m"))).reason).toBe("too_large");
    expect(pulled).toBeLessThan(10);
  });
});

class FakeWS {
  static last: FakeWS;
  sent: any[] = [];
  closed = false;
  private l: Record<string, ((e: any) => void)[]> = {};
  constructor(public url: string) {
    FakeWS.last = this;
    queueMicrotask(() => this.emit("open", {}));
  }
  addEventListener(t: string, f: (e: any) => void) {
    (this.l[t] ??= []).push(f);
  }
  emit(t: string, e: any) {
    this.l[t]?.forEach((f) => f(e));
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.closed = true;
    this.emit("close", {});
  }
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const ws = (timeoutMs?: number) =>
  createWsClient({ url: "ws://x", WebSocket: FakeWS as unknown as typeof WebSocket, ...(timeoutMs ? { timeoutMs } : {}) });

describe("ws client", () => {
  it("W-R04 matches out-of-order ids", async () => {
    const c = ws();
    const a = Effect.runPromise(c.request("a", { p: 1 }));
    const b = Effect.runPromise(c.request("b"));
    await tick();
    const [m1, m2] = FakeWS.last.sent;
    expect(m1).toMatchObject({ command: "a", p: 1 });
    FakeWS.last.emit("message", { data: JSON.stringify({ id: m2.id, status: "success", result: { v: "b" } }) });
    FakeWS.last.emit("message", { data: JSON.stringify({ id: m1.id, status: "success", result: { v: "a" } }) });
    expect(await a).toEqual({ v: "a" });
    expect(await b).toEqual({ v: "b" });
  });

  it("maps rippled errors", async () => {
    const c = ws();
    const p = run(c.request("a"));
    await tick();
    FakeWS.last.emit("message", { data: JSON.stringify({ id: FakeWS.last.sent[0].id, status: "error", error: "bad", error_message: "Bad." }) });
    expect(await p).toMatchObject({ reason: "rippled_error", message: "a: Bad." });
  });

  it("W-R04 close fails pending as closed", async () => {
    const c = ws();
    const p = run(c.request("a"));
    await tick();
    await Effect.runPromise(c.close());
    expect((await p).reason).toBe("closed");
    expect(FakeWS.last.closed).toBe(true);
  });

  it("a stale socket's close does not break its successor", async () => {
    const c = ws();
    const first = run(c.request("a"));
    await tick();
    const stale = FakeWS.last;
    stale.close = () => {
      stale.closed = true; // real sockets fire `close` later
    };
    await Effect.runPromise(c.close());
    expect((await first).reason).toBe("closed");
    const p = Effect.runPromise(c.request("b"));
    await tick();
    const fresh = FakeWS.last;
    expect(fresh).not.toBe(stale);
    stale.emit("close", {});
    fresh.emit("message", { data: JSON.stringify({ id: fresh.sent[0].id, status: "success", result: { v: 1 } }) });
    expect(await p).toEqual({ v: 1 });
  });

  it("params cannot override id or command", async () => {
    const c = ws();
    const p = Effect.runPromise(c.request("account_info", { command: "submit", id: 99 }));
    await tick();
    const sent = FakeWS.last.sent[0];
    expect(sent.command).toBe("account_info");
    expect(sent.id).not.toBe(99);
    FakeWS.last.emit("message", { data: JSON.stringify({ id: sent.id, status: "success", result: {} }) });
    await p;
  });

  it("times out when the socket never opens", async () => {
    class Silent extends FakeWS {
      constructor(url: string) {
        super(url);
        this.emit = () => {};
      }
    }
    const c = createWsClient({ url: "ws://x", WebSocket: Silent as unknown as typeof WebSocket, timeoutMs: 20 });
    expect((await run(c.request("a"))).reason).toBe("timeout");
  });

  // Opens only when the test says so, like a socket still connecting.
  class Gated extends FakeWS {
    gated = true;
    emit(t: string, e: any) {
      if (t === "open" && this.gated) return;
      super.emit(t, e);
    }
    release() {
      this.gated = false;
      this.emit("open", {});
    }
  }
  const gatedWs = (timeoutMs: number) => createWsClient({ url: "ws://x", WebSocket: Gated as unknown as typeof WebSocket, timeoutMs });

  it("does not send a request that was interrupted while connecting", async () => {
    const c = gatedWs(5000);
    const fiber = Effect.runFork(c.request("submit", { tx_blob: "AB" }));
    await tick();
    const sock = FakeWS.last as Gated;
    await Effect.runPromise(Fiber.interrupt(fiber));
    sock.release();
    await tick();
    expect(sock.sent).toEqual([]);
  });

  it("does not send a request that timed out while connecting", async () => {
    const c = gatedWs(20);
    const p = run(c.request("submit", { tx_blob: "AB" }));
    const sock = FakeWS.last as Gated;
    sock.close = () => {
      sock.closed = true; // real sockets fire `close` later, after the connect callback can still run
    };
    expect((await p).reason).toBe("timeout");
    sock.release();
    await tick();
    expect(sock.sent).toEqual([]);
  });

  it("opens a fresh socket after three requests in a row timed out on a silent one", async () => {
    const c = gatedWs(15);
    const first = run(c.request("a"));
    const dead = FakeWS.last;
    expect((await first).reason).toBe("timeout");
    expect((await run(c.request("b"))).reason).toBe("timeout");
    expect(dead.closed).toBe(false);
    expect(FakeWS.last).toBe(dead);
    expect((await run(c.request("c"))).reason).toBe("timeout");
    expect(dead.closed).toBe(true);
    const next = run(c.request("d"));
    expect(FakeWS.last).not.toBe(dead);
    expect((await next).reason).toBe("timeout");
  });

  it("a timeout fails only its own request and keeps the socket", async () => {
    const c = ws(60);
    const slow = run(c.request("slow"));
    await new Promise((r) => setTimeout(r, 30));
    const fast = Effect.runPromise(c.request("fast"));
    const sock = FakeWS.last;
    expect((await slow).reason).toBe("timeout");
    expect(sock.closed).toBe(false);
    // "fast" has 30 ms of its own budget left; the node answers inside it.
    sock.emit("message", { data: JSON.stringify({ id: sock.sent.find((m) => m.command === "fast").id, status: "success", result: { ok: 1 } }) });
    expect(await fast).toEqual({ ok: 1 });
    expect(sock.closed).toBe(false);
  });

  it("a late answer to a request that timed out is ignored, and shows the node is alive", async () => {
    const c = ws(15);
    const reply = (sock: FakeWS, id: number) => sock.emit("message", { data: JSON.stringify({ id, status: "success", result: {} }) });
    const a = run(c.request("a"));
    expect((await a).reason).toBe("timeout");
    const sock = FakeWS.last;
    // Two more timeouts would make three in a row; the late answer in between starts the count again.
    const b = run(c.request("b"));
    expect((await b).reason).toBe("timeout");
    reply(sock, sock.sent[0].id);
    const d = run(c.request("d"));
    expect((await d).reason).toBe("timeout");
    const e = run(c.request("e"));
    expect((await e).reason).toBe("timeout");
    expect(sock.closed).toBe(false);
    expect((await run(c.request("f"))).reason).toBe("timeout");
    expect(sock.closed).toBe(true);
  });

  it("any message at all, even one for nobody, counts as a sign of life", async () => {
    const c = ws(15);
    expect((await run(c.request("a"))).reason).toBe("timeout");
    const sock = FakeWS.last;
    expect((await run(c.request("b"))).reason).toBe("timeout");
    sock.emit("message", { data: JSON.stringify({ type: "ledgerClosed" }) });
    expect((await run(c.request("c"))).reason).toBe("timeout");
    expect((await run(c.request("d"))).reason).toBe("timeout");
    expect(sock.closed).toBe(false);
    // Text that is not JSON proves nothing.
    sock.emit("message", { data: "not json" });
    expect((await run(c.request("e"))).reason).toBe("timeout");
    expect(sock.closed).toBe(true);
  });

  it("recycling a dead socket fails the other requests waiting on it as closed", async () => {
    const c = ws(30);
    const sockPromises = [run(c.request("a")), run(c.request("b"))];
    await new Promise((r) => setTimeout(r, 10));
    const sock = FakeWS.last;
    expect((await sockPromises[0]).reason).toBe("timeout");
    expect((await sockPromises[1]).reason).toBe("timeout");
    expect((await run(c.request("c"))).reason).toBe("timeout");
    expect(sock.closed).toBe(true);
    const waiting = run(c.request("w"));
    const w = FakeWS.last;
    expect(w).not.toBe(sock);
    await Effect.runPromise(c.close());
    expect((await waiting).reason).toBe("closed");
  });

  it("a message from a replaced socket is ignored", async () => {
    const c = ws();
    const first = run(c.request("a"));
    await tick();
    const old = FakeWS.last;
    old.close = () => {
      old.closed = true;
    };
    await Effect.runPromise(c.close());
    expect((await first).reason).toBe("closed");
    const p = Effect.runPromise(c.request("b"));
    await tick();
    const fresh = FakeWS.last;
    old.emit("message", { data: JSON.stringify({ id: fresh.sent[0].id, status: "success", result: { from: "old" } }) });
    fresh.emit("message", { data: JSON.stringify({ id: fresh.sent[0].id, status: "success", result: { from: "fresh" } }) });
    expect(await p).toEqual({ from: "fresh" });
  });

  describe("message size cap", () => {
    const capped = (maxBodyBytes: number) =>
      createWsClient({ url: "ws://x", WebSocket: FakeWS as unknown as typeof WebSocket, maxBodyBytes, timeoutMs: 1000 });
    const reply = (sock: FakeWS, id: number, v: string) => sock.emit("message", { data: JSON.stringify({ id, status: "success", result: { v } }) });

    it("a message over the cap fails the socket with too_large and closes it", async () => {
      const c = capped(100);
      const a = run(c.request("a"));
      const b = run(c.request("b"));
      await tick();
      const sock = FakeWS.last;
      reply(sock, sock.sent[0].id, "x".repeat(200));
      expect(await a).toMatchObject({ reason: "too_large" });
      expect(await b).toMatchObject({ reason: "too_large" });
      expect(sock.closed).toBe(true);
      // The next request opens a new socket.
      const next = Effect.runPromise(c.request("c"));
      await tick();
      expect(FakeWS.last).not.toBe(sock);
      reply(FakeWS.last, FakeWS.last.sent[0].id, "ok");
      expect(await next).toEqual({ v: "ok" });
    });

    it("a message at the cap is accepted; the cap counts bytes, not characters", async () => {
      const body = (v: string) => JSON.stringify({ id: 1, status: "success", result: { v } });
      const cap = body("x".repeat(50)).length;
      const c = capped(cap);
      const ok = Effect.runPromise(c.request("a"));
      await tick();
      FakeWS.last.emit("message", { data: body("x".repeat(50)) });
      expect(await ok).toEqual({ v: "x".repeat(50) });

      const c2 = capped(cap);
      const wide = run(c2.request("a"));
      await tick();
      // 50 two-byte characters: as many UTF-16 units as before, twice the bytes.
      FakeWS.last.emit("message", { data: body("é".repeat(50)) });
      expect(await wide).toMatchObject({ reason: "too_large" });
    });

    it("binary messages are measured too", async () => {
      const c = capped(10);
      const p = run(c.request("a"));
      await tick();
      FakeWS.last.emit("message", { data: new ArrayBuffer(11) });
      expect(await p).toMatchObject({ reason: "too_large" });
    });

    it("the Promise client and Client take the cap as well", async () => {
      const c = createWsPromiseClient({ url: "ws://x", WebSocket: FakeWS as unknown as typeof WebSocket, maxBodyBytes: 100 });
      const p = c.request("a").catch((e: unknown) => e);
      await tick();
      reply(FakeWS.last, FakeWS.last.sent[0].id, "x".repeat(200));
      expect(await p).toMatchObject({ reason: "too_large" });

      const client = new Client("wss://x", { WebSocket: FakeWS as unknown as typeof WebSocket, maxBodyBytes: 100 });
      const q = client.request("a").catch((e: unknown) => e);
      await tick();
      reply(FakeWS.last, FakeWS.last.sent[0].id, "x".repeat(200));
      expect(await q).toMatchObject({ reason: "too_large" });
    });

    it("by default a normal reply is far below the cap", async () => {
      const c = ws();
      const p = Effect.runPromise(c.request("a"));
      await tick();
      reply(FakeWS.last, FakeWS.last.sent[0].id, "x".repeat(100_000));
      expect(((await p) as { v: string }).v).toHaveLength(100_000);
    });
  });

  it("times out per request", async () => {
    const c = ws(20);
    expect((await run(c.request("a"))).reason).toBe("timeout");
  });
});

const stub = (handlers: Record<string, unknown>) => {
  const calls: { method: string; params: unknown }[] = [];
  const client: RpcClient = {
    request: ((method: string, params?: object) => {
      calls.push({ method, params });
      return Effect.succeed(handlers[method]);
    }) as RpcClient["request"],
  };
  return { client, calls };
};

describe("autofill / submit", () => {
  const h = {
    fee: { drops: { open_ledger_fee: "12" }, ledger_current_index: 100 },
    account_info: { account_data: { Sequence: 7 } },
  };
  it("W-R05 fills missing fields", async () => {
    const { client, calls } = stub(h);
    const out = await Effect.runPromise(autofill(client, { Account: "rA", TransactionType: "Payment" }));
    expect(out).toEqual({ Account: "rA", TransactionType: "Payment", Fee: "12", Sequence: 7, LastLedgerSequence: 120 });
    expect(calls.find((c) => c.method === "account_info")!.params).toEqual({ account: "rA", ledger_index: "current" });
  });

  it("W-R05 never overwrites and skips needless calls", async () => {
    const { client, calls } = stub(h);
    const tx = { Account: "rA", Fee: "99", Sequence: 1, LastLedgerSequence: 5 };
    expect(await Effect.runPromise(autofill(client, tx))).toEqual(tx);
    expect(calls).toEqual([]);
  });

  it("falls back to ledger_current", async () => {
    const { client } = stub({ ...h, fee: { drops: { open_ledger_fee: "12" } }, ledger_current: { ledger_current_index: 50 } });
    const out = await Effect.runPromise(autofill(client, { Account: "rA" }));
    expect(out.LastLedgerSequence).toBe(70);
  });

  it("TicketSequence: Sequence 0, no account_info", async () => {
    const { client, calls } = stub(h);
    const out = await Effect.runPromise(autofill(client, { Account: "rA", TicketSequence: 3 }));
    expect(out.Sequence).toBe(0);
    expect(calls.map((c) => c.method)).not.toContain("account_info");
  });

  it("fails when the node's fee exceeds the cap, overridable", async () => {
    const { client } = stub({ ...h, fee: { drops: { open_ledger_fee: "100001" }, ledger_current_index: 100 } });
    expect((await run(autofill(client, { Account: "rA" }))).reason).toBe("fee_too_high");
    expect((await Effect.runPromise(autofill(client, { Account: "rA" }, { maxFeeDrops: 200_000n }))).Fee).toBe("100001");
  });

  it("caps a caller-supplied Fee too, and keeps one within the cap", async () => {
    const { client } = stub(h);
    const base = { Account: "rA", Sequence: 1, LastLedgerSequence: 5 };
    expect((await run(autofill(client, { ...base, Fee: "99999000000" }))).reason).toBe("fee_too_high");
    expect((await Effect.runPromise(autofill(client, { ...base, Fee: "100000" }))).Fee).toBe("100000");
  });

  it.each([NaN, Infinity, 2 ** 60, 0, -5, 1.5, "100", 4_294_967_276, 2 ** 32, 2 ** 32 - 1])("rejects ledger_current_index %s from the node", async (bad) => {
    const { client } = stub({ ...h, fee: { drops: { open_ledger_fee: "12" }, ledger_current_index: bad }, ledger_current: { ledger_current_index: bad } });
    expect((await run(autofill(client, { Account: "rA" }))).reason).toBe("no_result");
  });

  it("accepts the highest ledger that keeps LastLedgerSequence a UInt32, from either call", async () => {
    const top = 2 ** 32 - 1 - 20;
    const viaFee = stub({ ...h, fee: { drops: { open_ledger_fee: "12" }, ledger_current_index: top } });
    expect((await Effect.runPromise(autofill(viaFee.client, { Account: "rA" }))).LastLedgerSequence).toBe(2 ** 32 - 1);
    const viaCurrent = stub({ ...h, fee: { drops: { open_ledger_fee: "12" } }, ledger_current: { ledger_current_index: top } });
    expect((await Effect.runPromise(autofill(viaCurrent.client, { Account: "rA" }))).LastLedgerSequence).toBe(2 ** 32 - 1);
  });

  it("rejects a ledger_current answer that would overflow LastLedgerSequence", async () => {
    const { client } = stub({ ...h, fee: { drops: { open_ledger_fee: "12" } }, ledger_current: { ledger_current_index: 2 ** 32 - 20 } });
    const e = await run(autofill(client, { Account: "rA" }));
    expect(e).toMatchObject({ reason: "no_result", message: expect.stringContaining("ledger_current_index") });
  });

  it("a caller-supplied LastLedgerSequence is left untouched, whatever the node says about the ledger", async () => {
    for (const ledger of [100, 2 ** 32, "junk"]) {
      const { client, calls } = stub({ ...h, fee: { drops: { open_ledger_fee: "12" }, ledger_current_index: ledger }, ledger_current: { ledger_current_index: ledger } });
      const out = await Effect.runPromise(autofill(client, { Account: "rA", LastLedgerSequence: 2 ** 32 - 1 }));
      expect(out).toMatchObject({ Fee: "12", Sequence: 7, LastLedgerSequence: 2 ** 32 - 1 });
      expect(calls.map((c) => c.method)).not.toContain("ledger_current");
    }
    const { client } = stub(h);
    expect((await Effect.runPromise(autofill(client, { Account: "rA", LastLedgerSequence: 5 }))).LastLedgerSequence).toBe(5);
  });

  it("submit sends tx_blob and rejects non-hex without calling", async () => {
    const { client, calls } = stub({ submit: { engine_result: "tesSUCCESS", engine_result_message: "ok" } });
    expect((await Effect.runPromise(submit(client, "AB12"))).engine_result).toBe("tesSUCCESS");
    expect(calls).toEqual([{ method: "submit", params: { tx_blob: "AB12" } }]);
    for (const bad of ["", "xyz", "ABC"]) expect((await run(submit(client, bad))).reason).toBe("bad_input");
    expect(calls).toHaveLength(1);
  });
});

describe("websocket client, Promise API", () => {
  it("close() resolves and a pending request rejects with `closed`", async () => {
    const c = createWsPromiseClient({ url: "ws://x", WebSocket: FakeWS as unknown as typeof WebSocket });
    const pending = c.request("a").then(() => undefined, (e: unknown) => e as { reason: string });
    await tick();
    await c.close();
    expect((await pending)?.reason).toBe("closed");
    expect(FakeWS.last.closed).toBe(true);
  });

  it("request resolves to the result", async () => {
    const c = createWsPromiseClient({ url: "ws://x", WebSocket: FakeWS as unknown as typeof WebSocket });
    const p = c.request("ping");
    await tick();
    FakeWS.last.emit("message", { data: JSON.stringify({ id: FakeWS.last.sent[0].id, status: "success", result: { v: 1 } }) });
    expect(await p).toEqual({ v: 1 });
    await c.close();
  });
});

describe("a Promise client where an Effect client is expected", () => {
  const promiseClient = (handlers: Record<string, unknown>): { request: <T>(m: string) => Promise<T> } => ({
    request: (async (method: string) => (method in handlers ? handlers[method] : Promise.reject(new Error(`${method}: no answer`)))) as never,
  });

  it("autofill and submit accept it", async () => {
    const c = promiseClient({
      fee: { drops: { open_ledger_fee: "12" }, ledger_current_index: 100 },
      account_info: { account_data: { Sequence: 7 } },
      submit: { engine_result: "tesSUCCESS", engine_result_message: "ok" },
    });
    expect(await Effect.runPromise(autofill(c, { Account: "rA", TransactionType: "Payment" }))).toMatchObject({ Fee: "12", Sequence: 7, LastLedgerSequence: 120 });
    expect((await Effect.runPromise(submit(c, "1200"))).engine_result).toBe("tesSUCCESS");
  });

  it("a rejection that is not a ClientError, a synchronous throw, and a ClientError", async () => {
    const reasonOf = async (c: { request: (...a: never[]) => unknown }) => (await run(submit(c as never, "1200"))).reason;
    expect(await reasonOf(promiseClient({}))).toBe("http");
    expect(await reasonOf({ request: () => { throw new Error("sync"); } })).toBe("http");
    const timeout = new ClientError({ reason: "timeout", message: "slow" });
    expect(await reasonOf({ request: () => Promise.reject(timeout) })).toBe("timeout");
  });

  it("an Effect client still runs as it is", async () => {
    const c: RpcClient = { request: (() => Effect.succeed({ engine_result: "tesSUCCESS", engine_result_message: "ok" })) as RpcClient["request"] };
    expect((await Effect.runPromise(submit(c, "1200"))).engine_result).toBe("tesSUCCESS");
  });
});
