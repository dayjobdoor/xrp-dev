# xrp-dev/x402

A Hono gate for x402 v2 `exact` payments on XRPL. Source of the `xrp-dev/x402` entry. It needs the optional `hono` peer; it has no Express and no xrpl.js dependency.

```ts
import { Hono } from "hono";
import { chargeOnDelivery, requirePayment } from "xrp-dev/x402";

const gate = requirePayment({
  network: "xrpl:1", // required: "xrpl:0" mainnet, "xrpl:1" testnet, "xrpl:2" devnet. There is no default.
  payToAddress: "rYourAddress...",
  price: "1000000", // amount in the asset's smallest unit, as the facilitator expects it
  facilitatorUrl: "https://facilitator.example",
});

const app = new Hono();
app.use("/api/premium", gate); // the gate is plain middleware: it gates what `app.use` mounts it on
app.get("/api/premium", (c) => c.json({ ok: true }));

// Produce first, charge after: verify -> produce -> settle. Nothing is settled when produce() fails.
app.get("/api/report", (c) => chargeOnDelivery(c, gate, async () => ({ report: "..." })));
```

`requirePayment` throws at construction when `network`, `payToAddress`, `price` or a facilitator is missing.

## Mounting

Mount the gate with `app.use(path, gate)`. It works the same under `app.route("/api", sub)`.

The `path` option is gone: it compared against the full request path, so a gate configured with `path: "/premium"` and mounted in a sub-app under `/api` never matched and let every request through. `requirePayment` now throws if it sees `path`.

## What the gate does

- **Invoice binding.** An invoice is stored with a fingerprint (SHA-256 of network, asset and issuer, amount, `payTo` and resource URL). A payment is accepted only when the fingerprint matches what this gate asks of this request now. An invoice issued by a cheap route cannot open a dear route, even when both gates share one `InvoiceStore`. A refused invoice stays valid for the gate that issued it. The fingerprint is kept in the stored rows' `extra` and is never sent to clients; a store must therefore persist `extra` (any JSON store does). An invoice stored without a fingerprint is refused.
- **OPTIONS.** Only a genuine CORS preflight (`OPTIONS` with both `Origin` and `Access-Control-Request-Method`) skips the gate. Every other `OPTIONS` is gated like a `GET`. Put `cors()` before the gate and do not serve content from an `OPTIONS` handler: anyone can send the two preflight headers.
- **Always settles.** There is no verify-only mode: a gate that verified and never settled would deliver for free for ever. `chargeOnDelivery` is the one place that verifies, produces and then settles.
- **Settlement result.** The gate delivers only when the facilitator answers `success` with a non-empty string `transaction` and, if it names a `network`, the gate's own. Anything else is a failed settlement (`402`, `settle_failed:...`) and nothing is delivered.
- **Caching.** `402` responses, gate errors and paid responses carry `Cache-Control: no-store` and `Vary: PAYMENT-SIGNATURE`.

## The facilitator is the trust boundary

The gate checks that the facilitator answered for this payment. It does not look at the ledger. That the transaction paid the right destination, the right amount and the right asset, and that it is in a validated ledger, is what the facilitator's `/verify` and `/settle` promise. Use a facilitator you trust, and run your own for anything that matters.

## Invoice stores

The default store keeps invoices in memory (at most 10,000; the oldest unpaid one is evicted) and is for one process. For several processes or a restart, pass `invoiceStore`:

```ts
type InvoiceStore = {
  put(invoiceId, reqs, { ttlSeconds }): void | Promise<void>;
  get(invoiceId): PaymentRequirements[] | undefined | Promise<...>;
  consume(invoiceId): void | Promise<void>;
  claim?(invoiceId, { ttlSeconds }): boolean | Promise<boolean>; // atomic
  release?(invoiceId): void | Promise<void>;
};
```

A store shared by several processes **must implement `claim`**. It is an atomic test-and-set: the first caller for an id gets `true`, every other caller gets `false` until the claim is released or its TTL ends. With Redis that is `SET claim:<id> 1 NX EX <ttlSeconds>`. The gate calls it for each paid request, in addition to its in-process lock, and answers `409 payment_in_progress` when it returns `false`. Without `claim`, two processes can both verify, produce and deliver the same payment.

Implement `release` too (`DEL claim:<id>`): the gate calls it when the request ends, so a failed attempt can be retried at once instead of after the claim's TTL. A claim also ends with `consume`.
