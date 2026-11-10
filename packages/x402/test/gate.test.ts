import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { X402_PROTOCOL, chargeOnDelivery, requirePayment, type Facilitator, type InvoiceStore, type PaymentRequirements, type RequirePaymentOptions, type X402SettlementContext } from "../src/index.js";

type Env = { Variables: { x402?: X402SettlementContext } };

const b64 = (value: unknown) => btoa(JSON.stringify(value));
const NET = "xrpl:1";
const SIG = "PAYMENT-SIGNATURE";

/** `requirePayment` with the options every test repeats; `over` may carry options the types no longer allow. */
const gateFor = (facilitator: Facilitator, over: Record<string, unknown> = {}) =>
  requirePayment({ price: "1", payToAddress: "rPay", network: NET, facilitator, ...over } as RequirePaymentOptions);

/** An invoice store shared by gates; with `atomic` it has `claim`/`release` and logs them like a Redis-backed store would. */
function sharedStore(atomic = false) {
  const rows = new Map<string, PaymentRequirements[]>();
  const claims = new Set<string>();
  const log: string[] = [];
  const store: InvoiceStore = {
    put: (id, reqs) => void rows.set(id, reqs),
    get: (id) => rows.get(id),
    consume: (id) => void rows.delete(id),
    ...(atomic
      ? {
          claim: (id: string, { ttlSeconds }: { ttlSeconds: number }) => {
            log.push(`claim:${ttlSeconds}`);
            if (claims.has(id)) return false;
            claims.add(id);
            return true;
          },
          release: (id: string) => {
            log.push("release");
            claims.delete(id);
          },
        }
      : {}),
  };
  return { store, rows, claims, log };
}

function stub(over: Partial<Facilitator> = {}) {
  const calls = { verify: 0, settle: 0 };
  const facilitator: Facilitator = {
    verify: async () => {
      calls.verify++;
      return { isValid: true, payer: "rPayer" };
    },
    settle: async () => {
      calls.settle++;
      return { success: true, transaction: "TX", payer: "rPayer" };
    },
    ...over,
  };
  return { facilitator, calls };
}

/** An invoice from a header-less request, and the PAYMENT-SIGNATURE that pays it. */
async function pay(app: Hono<Env>, path: string, extensions?: unknown) {
  const res = await app.request(path);
  const accepted = ((await res.json()) as { accepts: PaymentRequirements[] }).accepts[0]!;
  const invoiceId = (accepted.extra as { invoiceId: string }).invoiceId;
  return b64({ x402Version: 2, accepted, payload: { invoiceId }, ...(extensions ? { extensions } : {}) });
}

describe("requirePayment", () => {
  it("names the wire and refuses to start without a facilitator", () => {
    expect(X402_PROTOCOL).toEqual({ version: 2, scheme: "exact", library: "x402-xrpl@0.3.3" });
    expect(() => requirePayment({ price: "1", payToAddress: "r", network: NET })).toThrow(/facilitator/);
  });

  it("chargeOnDelivery never delivers when the gate skips verification (CORS preflight)", async () => {
    const { facilitator, calls } = stub();
    const gate = gateFor(facilitator);
    let produced = 0;
    const app = new Hono<Env>();
    app.all("/r", (c) => chargeOnDelivery(c, gate, async () => ({ produced: ++produced })));
    const preflight = { "PAYMENT-SIGNATURE": "x", Origin: "https://a.example", "Access-Control-Request-Method": "GET" };
    const res = await app.request("/r", { method: "GET", headers: { "PAYMENT-SIGNATURE": "x" } });
    const options = await app.request("/r", { method: "OPTIONS", headers: preflight });
    expect([res.status, options.status]).toEqual([400, 402]);
    expect({ produced, ...calls }).toEqual({ produced: 0, verify: 0, settle: 0 });
  });

  it("with a secure policy, settles only when verify returned a decisionToken", async () => {
    let token: string | undefined;
    const { facilitator, calls } = stub({
      createX402SecureRequirements: async () => ({ x402Secure: { policy: "p" } }),
      verify: async () => ({ isValid: true, ...(token ? { extensions: { x402Secure: { decisionToken: token } } } : {}) }),
    });
    const app = new Hono<Env>();
    app.use("/r", requirePayment({ price: "1", network: NET, payToAddress: "rPay", facilitator, x402SecurePolicyId: "p" }));
    app.get("/r", (c) => c.text("ok"));
    const header = await pay(app, "/r", { x402Secure: {} });
    const refused = await app.request("/r", { headers: { "PAYMENT-SIGNATURE": header } });
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as { error: string }).error).toBe("x402_secure_decision_token_missing");
    expect(calls.settle).toBe(0);
    token = "T";
    const paid = await app.request("/r", { headers: { "PAYMENT-SIGNATURE": header } });
    expect(paid.status).toBe(200);
    expect(calls.settle).toBe(1);
  });

  it("answers a duplicate in-flight payment with 409 and produces once", async () => {
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => (release = r));
    const { facilitator, calls } = stub({
      verify: async () => {
        await gateOpen;
        return { isValid: true };
      },
    });
    const gate = requirePayment({ price: "1", network: NET, payToAddress: "rPay", facilitator });
    let produced = 0;
    const app = new Hono<Env>();
    app.get("/r", (c) => chargeOnDelivery(c, gate, async () => ({ n: ++produced })));
    const header = await pay(app, "/r");
    const first = app.request("/r", { headers: { "PAYMENT-SIGNATURE": header } });
    const second = await app.request("/r", { headers: { "PAYMENT-SIGNATURE": header } });
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect({ produced, settle: calls.settle }).toEqual({ produced: 1, settle: 1 });
  });

  it("bounds the default invoice store: the oldest unpaid invoice is evicted", async () => {
    const { facilitator } = stub();
    let n = 0;
    const app = new Hono<Env>();
    app.use("/r", requirePayment({ price: "1", network: NET, payToAddress: "rPay", facilitator, invoiceIdFactory: () => `INV${n++}` }));
    app.get("/r", (c) => c.text("ok"));
    const first = await pay(app, "/r");
    for (let i = 0; i < 10_000; i++) await app.request("/r");
    const res = await app.request("/r", { headers: { "PAYMENT-SIGNATURE": first } });
    expect(((await res.json()) as { error: string }).error).toBe("unknown_invoice_id");
  });

  it("requires network, payToAddress and price at construction", () => {
    const { facilitator } = stub();
    expect(() => requirePayment({ price: "1", payToAddress: "rPay", facilitator } as unknown as RequirePaymentOptions)).toThrow(/network is required/);
    expect(() => gateFor(facilitator, { network: "" })).toThrow(/network is required/);
    expect(() => gateFor(facilitator, { payToAddress: "" })).toThrow(/payToAddress and price/);
    expect(() => gateFor(facilitator, { price: undefined })).toThrow(/payToAddress and price/);
    expect(gateFor(facilitator)).toBeTypeOf("function");
  });

  it("refuses the upto scheme at construction, not on every request", () => {
    const { facilitator } = stub();
    expect(() => gateFor(facilitator, { scheme: "upto" })).toThrow(/`upto` scheme is not supported/);
  });

  it("answers 402 with the configured network, never a default", async () => {
    const { facilitator } = stub();
    const app = new Hono<Env>();
    app.use("/r", gateFor(facilitator, { network: "xrpl:0" }));
    const res = await app.request("/r");
    expect(((await res.json()) as { accepts: PaymentRequirements[] }).accepts[0]!.network).toBe("xrpl:0");
  });
});

describe("invoice binding", () => {
  it("an invoice from /cheap does not open /dear when both share one store", async () => {
    const { facilitator, calls } = stub();
    const { store } = sharedStore();
    const app = new Hono<Env>();
    app.use("/cheap", gateFor(facilitator, { price: "1", invoiceStore: store }));
    app.use("/dear", gateFor(facilitator, { price: "100000000", invoiceStore: store }));
    app.get("/cheap", (c) => c.text("cheap"));
    app.get("/dear", (c) => c.text("dear"));
    const header = await pay(app, "/cheap");
    const refused = await app.request("/dear", { headers: { [SIG]: header } });
    const body = (await refused.json()) as { error: string; accepts: PaymentRequirements[] };
    expect(refused.status).toBe(402);
    expect(body.error).toBe("invoice_not_for_this_resource");
    expect(body.accepts[0]!.amount).toBe("100000000");
    expect(calls).toEqual({ verify: 0, settle: 0 });
    // The refusal does not burn the invoice: it still pays the gate it came from.
    const paid = await app.request("/cheap", { headers: { [SIG]: header } });
    expect([paid.status, await paid.text()]).toEqual([200, "cheap"]);
    expect(calls).toEqual({ verify: 1, settle: 1 });
  });

  it("binds the invoice to the resource and the payee as well as the price", async () => {
    const { facilitator, calls } = stub();
    const { store } = sharedStore();
    const app = new Hono<Env>();
    app.use("/a", gateFor(facilitator, { invoiceStore: store }));
    app.use("/b", gateFor(facilitator, { invoiceStore: store }));
    app.use("/c", gateFor(facilitator, { invoiceStore: store, payToAddress: "rOther" }));
    app.use("/d", gateFor(facilitator, { invoiceStore: store, asset: "USD", issuer: "rIssuer" }));
    app.all("*", (c) => c.text("ok"));
    const header = await pay(app, "/a");
    for (const other of ["/b", "/c", "/d", "/a?x=1"]) {
      const res = await app.request(other, { headers: { [SIG]: header } });
      expect([other, res.status]).toEqual([other, 402]);
    }
    expect(calls).toEqual({ verify: 0, settle: 0 });
  });

  it("does not show the fingerprint to clients, and refuses an invoice stored without one", async () => {
    const { facilitator, calls } = stub();
    const { store, rows } = sharedStore();
    const app = new Hono<Env>();
    app.use("/r", gateFor(facilitator, { invoiceStore: store }));
    app.get("/r", (c) => c.text("ok"));
    const issued = await app.request("/r");
    expect(JSON.stringify(await issued.json())).not.toMatch(/ingerprint/);
    expect(issued.headers.get("PAYMENT-REQUIRED")).not.toMatch(/ingerprint/);
    const legacy: PaymentRequirements = { scheme: "exact", network: NET, amount: "1", asset: "XRP", payTo: "rPay", maxTimeoutSeconds: 600, extra: { invoiceId: "OLD" } };
    rows.set("OLD", [legacy]);
    const header = b64({ x402Version: 2, accepted: legacy, payload: { invoiceId: "OLD" } });
    const res = await app.request("/r", { headers: { [SIG]: header } });
    expect(res.status).toBe(402);
    expect(calls.verify).toBe(0);
  });

  it("an invoice id in the payload does not open another invoice's requirements", async () => {
    const { facilitator, calls } = stub();
    const app = new Hono<Env>();
    app.use("/r", gateFor(facilitator));
    app.get("/r", (c) => c.text("ok"));
    const first = JSON.parse(atob(await pay(app, "/r")));
    const second = JSON.parse(atob(await pay(app, "/r")));
    // Invoice A's id with invoice B's `accepted`: the requirements name another invoice, so nothing reaches the facilitator.
    const res = await app.request("/r", { headers: { [SIG]: b64({ ...first, accepted: second.accepted }) } });
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([402, "payment_requirements_mismatch"]);
    expect(calls).toEqual({ verify: 0, settle: 0 });
  });
});

describe("mounting", () => {
  it("rejects the removed `path` option and gates a sub-app mounted with app.route", async () => {
    const { facilitator } = stub();
    expect(() => gateFor(facilitator, { path: "/paid" })).toThrow(/`path` option was removed/);
    const sub = new Hono<Env>();
    sub.use("/paid", gateFor(facilitator));
    sub.get("/paid", (c) => c.text("paid"));
    sub.get("/free", (c) => c.text("free"));
    const app = new Hono<Env>();
    app.route("/api", sub);
    expect((await app.request("/api/paid")).status).toBe(402);
    expect((await app.request("/api/free")).status).toBe(200);
    const paid = await app.request("/api/paid", { headers: { [SIG]: await pay(app, "/api/paid") } });
    expect([paid.status, await paid.text()]).toEqual([200, "paid"]);
  });
});

describe("OPTIONS", () => {
  const preflight = { Origin: "https://a.example", "Access-Control-Request-Method": "GET" };

  function optionsApp(facilitator: Facilitator) {
    const app = new Hono<Env>();
    app.use("/r", gateFor(facilitator));
    app.options("/r", (c) => c.body(null, 204));
    app.get("/r", (c) => c.text("secret"));
    return app;
  }

  it("lets only a genuine CORS preflight through; every other OPTIONS is gated", async () => {
    const { facilitator, calls } = stub();
    const app = optionsApp(facilitator);
    const statuses: number[] = [];
    const withoutPreflight: Record<string, string>[] = [{}, { Origin: "https://a.example" }, { "Access-Control-Request-Method": "GET" }, { Origin: "", "Access-Control-Request-Method": "GET" }];
    for (const headers of withoutPreflight) {
      statuses.push((await app.request("/r", { method: "OPTIONS", headers })).status);
    }
    expect(statuses).toEqual([402, 402, 402, 402]);
    expect((await app.request("/r", { method: "OPTIONS", headers: preflight })).status).toBe(204);
    // Only OPTIONS is special: a GET carrying the preflight headers is gated.
    expect((await app.request("/r", { headers: preflight })).status).toBe(402);
    expect(calls).toEqual({ verify: 0, settle: 0 });
  });

  it("settles a paid non-preflight OPTIONS like any other method", async () => {
    const { facilitator, calls } = stub();
    const app = optionsApp(facilitator);
    const header = await pay(app, "/r");
    const res = await app.request("/r", { method: "OPTIONS", headers: { [SIG]: header } });
    expect(res.status).toBe(204);
    expect(calls).toEqual({ verify: 1, settle: 1 });
  });
});

describe("settling", () => {
  it("has no settle option and no verify-only gate: a paid request always settles", async () => {
    const { facilitator, calls } = stub();
    expect(() => gateFor(facilitator, { settle: false })).toThrow(/`settle` option was removed/);
    const gate = gateFor(facilitator);
    expect("verifyOnly" in gate).toBe(false);
    const app = new Hono<Env>();
    app.use("/r", gate);
    app.get("/r", (c) => c.text("ok"));
    expect((await app.request("/r", { headers: { [SIG]: await pay(app, "/r") } })).status).toBe(200);
    expect(calls).toEqual({ verify: 1, settle: 1 });
  });

  it("chargeOnDelivery verifies, produces, then settles; a foreign middleware is not a gate", async () => {
    const events: string[] = [];
    const { facilitator } = stub({
      verify: async () => (events.push("verify"), { isValid: true }),
      settle: async () => (events.push("settle"), { success: true, transaction: "TX" }),
    });
    const gate = gateFor(facilitator);
    const app = new Hono<Env>();
    app.get("/r", (c) => chargeOnDelivery(c, gate, async () => (events.push("produce"), { n: 1 })));
    const foreign = async (_c: unknown, next: () => Promise<void>) => next();
    app.get("/free", (c) => chargeOnDelivery(c, foreign as unknown as ReturnType<typeof gateFor>, async () => (events.push("free"), { n: 1 })));
    const res = await app.request("/r", { headers: { [SIG]: await pay(app, "/r") } });
    expect([res.status, await res.json()]).toEqual([200, { n: 1 }]);
    expect(events).toEqual(["verify", "produce", "settle"]);
    expect((await app.request("/free", { headers: { [SIG]: "x" } })).status).toBe(500);
    expect(events).not.toContain("free");
  });

  it("a paid PAYMENT-SIGNATURE cannot be replayed: the settled invoice is consumed", async () => {
    const { facilitator, calls } = stub();
    const app = new Hono<Env>();
    app.use("/r", gateFor(facilitator));
    app.get("/r", (c) => c.text("ok"));
    const header = await pay(app, "/r");
    expect((await app.request("/r", { headers: { [SIG]: header } })).status).toBe(200);
    const replay = await app.request("/r", { headers: { [SIG]: header } });
    expect([replay.status, ((await replay.json()) as { error: string }).error]).toEqual([400, "unknown_invoice_id"]);
    expect(calls).toEqual({ verify: 1, settle: 1 });
  });

  it("settles once when the same gate is mounted twice on a route", async () => {
    const { facilitator, calls } = stub();
    const gate = gateFor(facilitator);
    const app = new Hono<Env>();
    app.use("*", gate);
    app.use("/r", gate);
    app.get("/r", (c) => c.text("ok"));
    const res = await app.request("/r", { headers: { [SIG]: await pay(app, "/r") } });
    expect([res.status, await res.text(), res.headers.has("PAYMENT-RESPONSE")]).toEqual([200, "ok", true]);
    expect(calls).toEqual({ verify: 1, settle: 1 });
  });

  it("chargeOnDelivery on a route the same gate already settled says so instead of reporting an unknown invoice", async () => {
    const { facilitator, calls } = stub();
    const gate = gateFor(facilitator);
    let produced = 0;
    const app = new Hono<Env>();
    app.use("/r", gate);
    app.get("/r", (c) => chargeOnDelivery(c, gate, async () => ({ n: ++produced })));
    app.onError((err, c) => c.text(err.message, 500));
    const res = await app.request("/r", { headers: { [SIG]: await pay(app, "/r") } });
    expect([res.status, await res.text()]).toEqual([500, expect.stringContaining("also mounted as middleware")]);
    expect({ produced, settle: calls.settle }).toEqual({ produced: 0, settle: 1 });
  });
});

describe("settlement result", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["empty transaction", { success: true, transaction: "" }, "settlement_transaction_missing"],
    ["missing transaction", { success: true }, "settlement_transaction_missing"],
    ["blank transaction", { success: true, transaction: "   " }, "settlement_transaction_missing"],
    ["non-string transaction", { success: true, transaction: 7 }, "settlement_transaction_missing"],
    ["other network", { success: true, transaction: "TX", network: "xrpl:0" }, "settlement_network_mismatch"],
  ];

  for (const [name, settlement, reason] of cases) {
    it(`does not deliver on ${name}`, async () => {
      const { facilitator } = stub({ settle: async () => settlement as never });
      let ran = 0;
      const app = new Hono<Env>();
      app.use("/r", gateFor(facilitator));
      app.get("/r", (c) => (ran++, c.text("ok")));
      const res = await app.request("/r", { headers: { [SIG]: await pay(app, "/r") } });
      expect(res.status).toBe(402);
      expect(((await res.json()) as { error: string }).error).toBe(`settle_failed:${reason}`);
      expect(res.headers.get("PAYMENT-RESPONSE")).toBeNull();
      expect(ran).toBe(0);
    });
  }

  it("does not deliver through chargeOnDelivery either", async () => {
    const { facilitator } = stub({ settle: async () => ({ success: true, transaction: "TX", network: "xrpl:0" }) });
    const gate = gateFor(facilitator);
    const app = new Hono<Env>();
    app.get("/r", (c) => chargeOnDelivery(c, gate, async () => ({ secret: 1 })));
    const res = await app.request("/r", { headers: { [SIG]: await pay(app, "/r") } });
    expect(res.status).toBe(402);
    expect(await res.text()).not.toContain("secret");
  });

  it("delivers when the transaction is set and the network is the gate's, or absent", async () => {
    for (const network of [NET, undefined]) {
      const { facilitator } = stub({ settle: async () => ({ success: true, transaction: "TX1", ...(network ? { network } : {}) }) });
      const app = new Hono<Env>();
      app.use("/r", gateFor(facilitator));
      app.get("/r", (c) => c.text("ok"));
      const res = await app.request("/r", { headers: { [SIG]: await pay(app, "/r") } });
      expect(res.status).toBe(200);
      const receipt = JSON.parse(atob(res.headers.get("PAYMENT-RESPONSE")!)) as { transaction: string; network: string };
      expect(receipt).toMatchObject({ transaction: "TX1", network: NET });
    }
  });
});

describe("claim", () => {
  it("answers 409 when the store's claim is taken elsewhere, and delivers once it is free", async () => {
    const { facilitator, calls } = stub();
    const { store, rows, claims, log } = sharedStore(true);
    const app = new Hono<Env>();
    app.use("/r", gateFor(facilitator, { invoiceStore: store }));
    app.get("/r", (c) => c.text("ok"));
    const header = await pay(app, "/r");
    const [id] = [...rows.keys()];
    claims.add(id!); // another process holds the invoice
    const busy = await app.request("/r", { headers: { [SIG]: header } });
    expect([busy.status, ((await busy.json()) as { error: string }).error]).toEqual([409, "payment_in_progress"]);
    expect(calls).toEqual({ verify: 0, settle: 0 });
    claims.delete(id!);
    expect((await app.request("/r", { headers: { [SIG]: header } })).status).toBe(200);
    expect(calls).toEqual({ verify: 1, settle: 1 });
    expect(log.map((entry) => entry.replace(/\d+/, "N"))).toEqual(["claim:N", "claim:N", "release"]);
  });

  it("releases the claim when the attempt fails, so the client can retry", async () => {
    let valid = false;
    const { facilitator } = stub({ verify: async () => ({ isValid: valid }) });
    const { store, claims } = sharedStore(true);
    const app = new Hono<Env>();
    app.use("/r", gateFor(facilitator, { invoiceStore: store }));
    app.get("/r", (c) => c.text("ok"));
    const header = await pay(app, "/r");
    expect((await app.request("/r", { headers: { [SIG]: header } })).status).toBe(402);
    expect(claims.size).toBe(0);
    valid = true;
    expect((await app.request("/r", { headers: { [SIG]: header } })).status).toBe(200);
  });

  it("takes the claim once for verify, produce and settle in chargeOnDelivery, and produces once", async () => {
    const { facilitator } = stub();
    const { store, log } = sharedStore(true);
    const gate = gateFor(facilitator, { invoiceStore: store });
    let produced = 0;
    const app = new Hono<Env>();
    app.get("/r", (c) => chargeOnDelivery(c, gate, async () => ({ n: ++produced })));
    const header = await pay(app, "/r");
    expect((await app.request("/r", { headers: { [SIG]: header } })).status).toBe(200);
    expect(produced).toBe(1);
    expect(log.map((entry) => entry.replace(/\d+/, "N"))).toEqual(["claim:N", "release"]);
  });

  it("with a claim-less store, still answers a concurrent duplicate with 409", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { facilitator } = stub({ verify: async () => (await hold, { isValid: true }) });
    const { store } = sharedStore();
    const app = new Hono<Env>();
    app.use("/r", gateFor(facilitator, { invoiceStore: store }));
    app.get("/r", (c) => c.text("ok"));
    const header = await pay(app, "/r");
    const first = app.request("/r", { headers: { [SIG]: header } });
    expect((await app.request("/r", { headers: { [SIG]: header } })).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });
});

describe("caching headers", () => {
  const vary = (res: Response) => (res.headers.get("Vary") ?? "").toLowerCase();

  it("marks the 402, the errors and the paid response no-store and Vary: PAYMENT-SIGNATURE", async () => {
    const { facilitator } = stub();
    const gate = gateFor(facilitator);
    const app = new Hono<Env>();
    app.use("*", gate);
    app.get("/json", (c) => c.json({ ok: 1 }));
    app.get("/raw", () => new Response("raw", { headers: { "Cache-Control": "public, max-age=60", Vary: "Accept-Encoding" } }));
    app.get("/redirect", () => Response.redirect("https://example.com/", 302));
    const challenge = await app.request("/json");
    expect(challenge.status).toBe(402);
    expect([challenge.headers.get("Cache-Control"), vary(challenge)]).toEqual(["no-store", "payment-signature"]);
    const bad = await app.request("/json", { headers: { [SIG]: "not-base64!" } });
    expect([bad.status, bad.headers.get("Cache-Control")]).toEqual([400, "no-store"]);
    for (const path of ["/json", "/raw", "/redirect"]) {
      const res = await app.request(path, { headers: { [SIG]: await pay(app, path) } });
      expect([path, res.status === 402 || res.status === 400]).toEqual([path, false]);
      expect([path, res.headers.get("Cache-Control")]).toEqual([path, "no-store"]);
      expect([path, vary(res).includes("payment-signature")]).toEqual([path, true]);
      expect([path, res.headers.get("PAYMENT-RESPONSE")]).toEqual([path, expect.any(String)]);
    }
    const raw = await app.request("/raw", { headers: { [SIG]: await pay(app, "/raw") } });
    expect(vary(raw)).toContain("accept-encoding");
  });

  it("marks a chargeOnDelivery response the same way", async () => {
    const { facilitator } = stub();
    const gate = gateFor(facilitator);
    const app = new Hono<Env>();
    app.get("/r", (c) => chargeOnDelivery(c, gate, async () => ({ n: 1 })));
    const challenge = await app.request("/r");
    expect([challenge.status, challenge.headers.get("Cache-Control"), vary(challenge)]).toEqual([402, "no-store", "payment-signature"]);
    const paid = await app.request("/r", { headers: { [SIG]: await pay(app, "/r") } });
    expect([paid.status, paid.headers.get("Cache-Control"), vary(paid)]).toEqual([200, "no-store", "payment-signature"]);
    expect(paid.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
  });
});
