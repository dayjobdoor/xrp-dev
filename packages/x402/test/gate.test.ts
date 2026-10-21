import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { X402_PROTOCOL, chargeOnDelivery, requirePayment, type Facilitator, type PaymentRequirements, type X402SettlementContext } from "../src/index.js";

type Env = { Variables: { x402?: X402SettlementContext } };

const b64 = (value: unknown) => btoa(JSON.stringify(value));

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
    expect(() => requirePayment({ price: "1", payToAddress: "r" })).toThrow(/facilitator/);
  });

  it("chargeOnDelivery never delivers when the gate skips verification (OPTIONS, ungated path)", async () => {
    const { facilitator, calls } = stub();
    const gate = requirePayment({ price: "1", payToAddress: "rPay", facilitator, path: "/other" });
    let produced = 0;
    const app = new Hono<Env>();
    app.all("/r", (c) => chargeOnDelivery(c, gate, async () => ({ produced: ++produced })));
    const res = await app.request("/r", { method: "GET", headers: { "PAYMENT-SIGNATURE": "x" } });
    const options = await app.request("/r", { method: "OPTIONS", headers: { "PAYMENT-SIGNATURE": "x" } });
    expect([res.status, options.status]).toEqual([402, 402]);
    expect({ produced, ...calls }).toEqual({ produced: 0, verify: 0, settle: 0 });
  });

  it("with a secure policy, settles only when verify returned a decisionToken", async () => {
    let token: string | undefined;
    const { facilitator, calls } = stub({
      createX402SecureRequirements: async () => ({ x402Secure: { policy: "p" } }),
      verify: async () => ({ isValid: true, ...(token ? { extensions: { x402Secure: { decisionToken: token } } } : {}) }),
    });
    const app = new Hono<Env>();
    app.use("/r", requirePayment({ price: "1", payToAddress: "rPay", facilitator, x402SecurePolicyId: "p" }));
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
    const gate = requirePayment({ price: "1", payToAddress: "rPay", facilitator });
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
    app.use("/r", requirePayment({ price: "1", payToAddress: "rPay", facilitator, invoiceIdFactory: () => `INV${n++}` }));
    app.get("/r", (c) => c.text("ok"));
    const first = await pay(app, "/r");
    for (let i = 0; i < 10_000; i++) await app.request("/r");
    const res = await app.request("/r", { headers: { "PAYMENT-SIGNATURE": first } });
    expect(((await res.json()) as { error: string }).error).toBe("unknown_invoice_id");
  });
});
