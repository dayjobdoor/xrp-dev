/**
 * x402 v2 exact-scheme gate for Hono.
 *
 * Wire-compatible with x402-xrpl 0.3.3 (headers, invoice match, facilitator /verify and /settle).
 * `fetch` is always called as a free function: workerd rejects a method extracted from globalThis.
 * The `upto` scheme is refused; it needs to patch the response after the handler, which this gate does not do.
 */
import type { Context, MiddlewareHandler } from "hono";

export const X402_PROTOCOL = { version: 2, scheme: "exact", library: "x402-xrpl@0.3.3" } as const;

export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

const X402_SECURE = "x402Secure";

export type JsonRecord = { [key: string]: JsonValue };
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonRecord;

export type PaymentRequirements = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /** Same bag the ledger stores: any JSON object, not only the fields this gate writes. */
  extra?: { [key: string]: unknown } | null;
};

export type InvoiceStore = {
  put(invoiceId: string, reqs: PaymentRequirements[], params: { ttlSeconds: number }): Promise<void> | void;
  get(invoiceId: string): Promise<PaymentRequirements[] | undefined> | PaymentRequirements[] | undefined;
  consume(invoiceId: string): Promise<void> | void;
};

export type PaymentOption = {
  asset: string;
  amount: string;
  issuer?: string;
  extra?: JsonRecord;
};

type VerifyResult = {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
  extensions?: JsonRecord;
};

type Settlement = {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
  extensions?: JsonRecord;
  paymentResponseHeader?: string;
};

export type X402SettlementContext = {
  invoiceId: string;
  paymentRequirements: PaymentRequirements;
  settlement: Settlement;
  payer?: string;
};

export type Facilitator = {
  verify(params: { paymentHeader: string; paymentRequirements: PaymentRequirements }): Promise<VerifyResult>;
  settle(params: {
    paymentHeader: string;
    paymentRequirements: PaymentRequirements;
    extensions?: JsonRecord;
  }): Promise<Settlement>;
  createX402SecureRequirements?(params: {
    resource: { url: string; description: string; mimeType: string };
    paymentRequirements: PaymentRequirements[];
    merchant?: JsonRecord;
    requestedPolicyId?: string;
  }): Promise<JsonRecord>;
};

export type RequirePaymentOptions = {
  price: string | number;
  payToAddress: string;
  path?: string | string[];
  scheme?: string;
  network?: string;
  asset?: string;
  issuer?: string;
  maxTimeoutSeconds?: number;
  resource?: string;
  description?: string;
  mimeType?: string;
  extra?: JsonRecord;
  paymentOptions?: PaymentOption[];
  facilitatorIdentity?: { id: string; name?: string };
  sourceTag?: number;
  facilitatorUrl?: string;
  facilitatorHeaders?: Record<string, string>;
  facilitator?: Facilitator;
  invoiceStore?: InvoiceStore;
  invoiceTtlSeconds?: number;
  invoiceIdFactory?: () => string;
  settle?: boolean;
  x402SecurePolicyId?: string;
  merchantId?: string;
  origin?: string;
  routeId?: string;
};

type GateEnv = { Variables: { x402?: X402SettlementContext } };

export type PaymentGate<E extends GateEnv = GateEnv> = MiddlewareHandler<E> & {
  /** Verify and match the invoice, then call next. Does not settle. */
  verifyOnly: MiddlewareHandler<E>;
};

const verifiedContexts = new WeakSet<object>();
const inflight = new Map<string, object>();

/** One request at a time per invoice (per process). The owner context may re-enter; a duplicate gets 409. */
async function withClaim<T>(invoiceId: string | undefined, c: Context<any>, run: () => Promise<T>): Promise<T | Response> {
  if (!invoiceId) return run();
  const owner = inflight.get(invoiceId);
  if (owner === c) return run();
  if (owner) return c.json({ error: "payment_in_progress" }, 409);
  inflight.set(invoiceId, c);
  try {
    return await run();
  } finally {
    inflight.delete(invoiceId);
  }
}

// ponytail: process-local cap; a shared deployment should pass its own `invoiceStore` with real eviction.
const MAX_MEMORY_INVOICES = 10_000;

class MemoryInvoices implements InvoiceStore {
  private readonly map = new Map<string, { expiresAtMs: number; reqs: PaymentRequirements[] }>();

  put(invoiceId: string, reqs: PaymentRequirements[], params: { ttlSeconds: number }): void {
    const now = Date.now();
    if (this.map.size >= MAX_MEMORY_INVOICES) {
      for (const [id, item] of this.map) if (item.expiresAtMs <= now) this.map.delete(id);
      // Still full: drop the oldest (Map keeps insertion order) so unauthenticated 402s cannot grow memory without bound.
      while (this.map.size >= MAX_MEMORY_INVOICES) this.map.delete(this.map.keys().next().value as string);
    }
    this.map.set(invoiceId, { expiresAtMs: now + params.ttlSeconds * 1000, reqs });
  }

  get(invoiceId: string): PaymentRequirements[] | undefined {
    const item = this.map.get(invoiceId);
    if (!item) return undefined;
    if (item.expiresAtMs <= Date.now()) {
      this.map.delete(invoiceId);
      return undefined;
    }
    return item.reqs;
  }

  consume(invoiceId: string): void {
    this.map.delete(invoiceId);
  }
}

export class FacilitatorHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;

  constructor(status: number, body: unknown, headers: Headers) {
    super(`facilitator_http_error:${status}`);
    this.name = "FacilitatorHttpError";
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/** Calls `fetch` as a function, never as a method. */
export function createFacilitator(baseUrl: string, headers: Record<string, string> = {}): Facilitator {
  const root = baseUrl.replace(/\/+$/, "");
  const call = (input: string, init: RequestInit) => fetch(input, init);

  const requestJson = async (path: string, init: RequestInit): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await call(root + path, { ...init, signal: controller.signal });
      const text = await response.text();
      let json: unknown;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      if (!response.ok) throw new FacilitatorHttpError(response.status, json, response.headers);
      return json;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async verify(params) {
      const json = await requestJson("/verify", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: canonical(paymentVerifyBody(params.paymentHeader, params.paymentRequirements)),
      });
      return verifyFromWire(json);
    },
    async settle(params) {
      const body = {
        ...paymentVerifyBody(params.paymentHeader, params.paymentRequirements),
        ...(params.extensions ? { extensions: params.extensions } : {}),
      };
      const json = await requestJson("/settle", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: canonical(body),
      });
      return settlementFromWire(json);
    },
    async createX402SecureRequirements(params) {
      const body = {
        resource: params.resource,
        paymentRequirements: params.paymentRequirements,
        ...(params.merchant ? { merchant: params.merchant } : {}),
        ...(params.requestedPolicyId ? { requestedPolicyId: params.requestedPolicyId } : {}),
      };
      const json = await requestJson("/verifiable-intent/requirements", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: canonical(body),
      });
      if (!isRecord(json)) throw new Error("invalid_x402_secure_requirements_response");
      return json;
    },
  };
}

type Verified = {
  invoiceId: string;
  selected: PaymentRequirements;
  verify: VerifyResult;
  paymentSignature: string;
};

export function requirePayment<E extends GateEnv>(params: RequirePaymentOptions): PaymentGate<E> {
  if (!params.facilitator && !params.facilitatorUrl) {
    throw new Error("facilitator or facilitatorUrl is required");
  }
  const facilitator = params.facilitator ?? createFacilitator(params.facilitatorUrl ?? "", params.facilitatorHeaders);
  const invoices = params.invoiceStore ?? new MemoryInvoices();
  const ttl = params.invoiceTtlSeconds ?? 900;
  const scheme = params.scheme ?? "exact";
  const network = params.network ?? "xrpl:1";
  const asset = params.asset ?? "XRP";
  const maxTimeoutSeconds = params.maxTimeoutSeconds ?? 600;
  const paths = params.path == null ? undefined : new Set(typeof params.path === "string" ? [params.path] : params.path);
  const cache = new WeakMap<object, Verified>();

  const handle =
    (settle: boolean): MiddlewareHandler<E> =>
    async (c, next) => {
      if (scheme === "upto") {
        return c.json({ error: "x402_scheme_unsupported", message: "upto scheme is not supported" }, 500);
      }
      if (!params.payToAddress) {
        return c.json({ error: "x402_not_configured", message: "X402_PAY_TO is required" }, 503);
      }
      if (c.req.method === "OPTIONS") return next();
      if (paths && !paths.has(c.req.path)) return next();

      const signature = c.req.header(HEADER_PAYMENT_SIGNATURE);
      if (!signature) return challenge(c, params, facilitator, invoices, ttl, scheme, network, asset, maxTimeoutSeconds);

      const cached = cache.get(c);
      if (cached && settle) return finishSettle(c, next, facilitator, invoices, params, cached);

      let payload: ReturnType<typeof decodeSignature>;
      try {
        payload = decodeSignature(signature);
      } catch (err) {
        return c.json({ error: `invalid_payment_signature_header:${messageOf(err)}` }, 400);
      }
      const invoiceId = typeof payload.payload.invoiceId === "string" ? payload.payload.invoiceId : undefined;
      if (!invoiceId) return c.json({ error: "missing_invoiceId" }, 400);
      return withClaim(invoiceId, c, async () => {
        const stored = await invoices.get(invoiceId);
        if (!stored?.length) return c.json({ error: "unknown_invoice_id" }, 400);
        const selected = stored.find((row) => requirementsMatch(row, payload.accepted));
        if (!selected) return c.json({ error: "payment_requirements_mismatch" }, 402);

        const paidSecure = isRecord(payload.extensions) ? payload.extensions[X402_SECURE] : undefined;
        if (params.x402SecurePolicyId && !isRecord(paidSecure)) {
          return challenge(c, params, facilitator, invoices, ttl, scheme, network, asset, maxTimeoutSeconds, stored, "x402_secure_extension_required");
        }

        let verify: VerifyResult;
        try {
          verify = await facilitator.verify({ paymentHeader: signature, paymentRequirements: selected });
        } catch (err) {
          const transient = transientVerify(err);
          if (transient) {
            c.header("Retry-After", String(transient.retryAfter));
            if (transient.correlationId) c.header("X-Correlation-ID", transient.correlationId);
            return c.json(transient, 503);
          }
          return c.json({ error: `verify_http_error:${messageOf(err)}` }, 502);
        }
        if (!verify.isValid) {
          return challenge(c, params, facilitator, invoices, ttl, scheme, network, asset, maxTimeoutSeconds, stored, `verify_failed:${verify.invalidReason ?? ""}`);
        }
        // With a secure policy the facilitator's decision token is the proof the policy ran: no token, no settle.
        if (params.x402SecurePolicyId && !decisionToken(verify)) {
          return challenge(c, params, facilitator, invoices, ttl, scheme, network, asset, maxTimeoutSeconds, stored, "x402_secure_decision_token_missing");
        }
        const verified = { invoiceId, selected, verify, paymentSignature: signature };
        cache.set(c, verified);
        verifiedContexts.add(c);
        if (!settle) return next();
        return finishSettle(c, next, facilitator, invoices, params, verified);
      });
    };

  const gate = handle(params.settle ?? true) as PaymentGate<E>;
  gate.verifyOnly = handle(false);
  return gate;
}

/**
 * With a payment, verify first. Run `produce` only after that. Settle only when `produce` returns a
 * JSON object, then attach `PAYMENT-RESPONSE`. A `Response` from `produce` is returned unsettled.
 */
export async function chargeOnDelivery<E extends GateEnv>(
  c: Context<E>,
  gate: PaymentGate<E>,
  produce: () => Promise<JsonRecord | Response>,
): Promise<Response> {
  const signature = c.req.header(HEADER_PAYMENT_SIGNATURE);
  if (!signature) {
    return (await gate(c, async () => {})) ?? c.json({}, 402);
  }
  // Hold the invoice across verify, produce and settle so a duplicate request cannot run produce() a second time.
  let claimId: string | undefined;
  try {
    claimId = decodeSignature(signature).payload.invoiceId as string | undefined;
  } catch {
    /* the gate answers a malformed header with 400 */
  }
  return withClaim(typeof claimId === "string" ? claimId : undefined, c, async () => {
    let passed = false;
    const refused = await gate.verifyOnly(c, async () => {
      passed = true;
    });
    // `passed` alone is not proof: the gate also calls next for OPTIONS and for paths outside `path`, unverified.
    if (!passed || !verifiedContexts.has(c)) return refused ?? c.json({}, 402);
    const delivered = await produce();
    if (delivered instanceof Response) return delivered;
    let settled = false;
    const after = await gate(c, async () => {
      settled = true;
    });
    return settled ? c.json(delivered) : (after ?? c.json({}, 402));
  });
}

async function finishSettle<E extends GateEnv>(
  c: Context<E>,
  next: () => Promise<void>,
  facilitator: Facilitator,
  invoices: InvoiceStore,
  params: RequirePaymentOptions,
  verified: Verified,
): Promise<Response | void> {
  const token = decisionToken(verified.verify);
  let settlement: Settlement;
  try {
    settlement = await facilitator.settle({
      paymentHeader: verified.paymentSignature,
      paymentRequirements: verified.selected,
      ...(token ? { extensions: { [X402_SECURE]: { decisionToken: token } } } : {}),
    });
  } catch (err) {
    if (err instanceof FacilitatorHttpError && isRecord(err.body) && err.body.settlementAttempted === true) {
      return settlementUnknown(c, err);
    }
    return c.json(
      { error: `settle_http_error:${messageOf(err)}`, reason: "settlement_status_unknown", retryable: false, phase: "settle", settlementAttempted: true },
      502,
    );
  }
  if (!settlement.success) {
    if (legacyUnknown(settlement.errorReason)) return settlementUnknown(c);
    return challenge(
      c,
      params,
      facilitator,
      invoices,
      params.invoiceTtlSeconds ?? 900,
      params.scheme ?? "exact",
      params.network ?? "xrpl:1",
      params.asset ?? "XRP",
      params.maxTimeoutSeconds ?? 600,
      [verified.selected],
      `settle_failed:${settlement.errorReason ?? ""}`,
    );
  }
  await invoices.consume(verified.invoiceId);
  const header =
    settlement.paymentResponseHeader ??
    base64Utf8(
      canonical({
        success: true,
        transaction: settlement.transaction ?? "",
        network: settlement.network ?? verified.selected.network,
        payer: settlement.payer ?? "",
        ...(settlement.extensions ? { extensions: settlement.extensions } : {}),
      }),
    );
  c.header(HEADER_PAYMENT_RESPONSE, header);
  c.set("x402", {
    invoiceId: verified.invoiceId,
    paymentRequirements: verified.selected,
    settlement,
    ...(verified.verify.payer ?? settlement.payer ? { payer: verified.verify.payer ?? settlement.payer } : {}),
  });
  await next();
}

async function challenge<E extends GateEnv>(
  c: Context<E>,
  params: RequirePaymentOptions,
  facilitator: Facilitator,
  invoices: InvoiceStore,
  ttl: number,
  scheme: string,
  network: string,
  asset: string,
  maxTimeoutSeconds: number,
  existing?: PaymentRequirements[],
  error = `${HEADER_PAYMENT_SIGNATURE} header is required`,
): Promise<Response> {
  const invoiceId = existing ? invoiceIdOf(existing[0]) : (params.invoiceIdFactory ?? defaultInvoiceId)();
  const reqs =
    existing ??
    (params.paymentOptions?.length ? params.paymentOptions : [{ asset, amount: String(params.price), ...(params.issuer ? { issuer: params.issuer } : {}), ...(params.extra ? { extra: params.extra } : {}) }]).map(
      (opt) => {
        const extra: JsonRecord = { ...(params.extra ?? {}), ...(opt.extra ?? {}) };
        const issuer = opt.issuer ?? params.issuer;
        if (issuer) extra.issuer = issuer;
        if (extra.sourceTag == null && params.sourceTag != null) extra.sourceTag = params.sourceTag;
        if (extra.facilitator == null && params.facilitatorIdentity) extra.facilitator = { ...params.facilitatorIdentity };
        if (invoiceId) extra.invoiceId = invoiceId;
        return { scheme, network, amount: String(opt.amount), asset: String(opt.asset), payTo: params.payToAddress, maxTimeoutSeconds, extra };
      },
    );
  if (!existing && invoiceId) await invoices.put(invoiceId, reqs, { ttlSeconds: ttl });
  const url = new URL(c.req.url);
  const resourceUrl = params.resource ?? url.href;
  let extensions: JsonRecord = {};
  if (params.x402SecurePolicyId) {
    if (!facilitator.createX402SecureRequirements) {
      return c.json({ error: "x402_secure_requirements_error:facilitator_has_no_secure_requirements" }, 502);
    }
    try {
      const merchant: JsonRecord = {};
      if (params.merchantId) merchant.merchantId = params.merchantId;
      if (params.origin) merchant.origin = params.origin;
      if (params.routeId) merchant.routeId = params.routeId;
      const response = await facilitator.createX402SecureRequirements({
        resource: { url: resourceUrl, description: params.description ?? "", mimeType: params.mimeType ?? "application/json" },
        paymentRequirements: reqs,
        merchant,
        requestedPolicyId: params.x402SecurePolicyId,
      });
      const secure = response[X402_SECURE];
      if (!isRecord(secure)) throw new Error("invalid_x402_secure_requirements_response");
      extensions = { [X402_SECURE]: secure };
    } catch (err) {
      return c.json({ error: `x402_secure_requirements_error:${messageOf(err)}` }, 502);
    }
  }
  const body = {
    x402Version: X402_PROTOCOL.version,
    error,
    resource: { url: resourceUrl, description: params.description ?? "", mimeType: params.mimeType ?? "application/json" },
    accepts: reqs,
    extensions,
  };
  c.header(HEADER_PAYMENT_REQUIRED, base64Utf8(canonical(body)));
  return c.json(body, 402);
}

function paymentVerifyBody(paymentHeader: string, paymentRequirements: PaymentRequirements) {
  return { paymentPayload: decodeSignature(paymentHeader).wire, paymentRequirements };
}

function decodeSignature(base64: string): {
  x402Version: number;
  accepted: PaymentRequirements;
  payload: JsonRecord;
  extensions?: JsonRecord;
  wire: JsonRecord;
} {
  const data = JSON.parse(new TextDecoder().decode(base64ToBytes(base64))) as unknown;
  if (!isRecord(data)) throw new Error("invalid_payment_payload");
  const x402Version = asInt(data.x402Version);
  if (x402Version !== 2) throw new Error("invalid_x402_version");
  const accepted = requirementsFromWire(data.accepted);
  if (!isRecord(data.payload)) throw new Error("invalid_payload");
  const extensions = data.extensions == null ? undefined : isRecord(data.extensions) ? data.extensions : undefined;
  return { x402Version, accepted, payload: data.payload, ...(extensions ? { extensions } : {}), wire: data };
}

function requirementsFromWire(data: unknown): PaymentRequirements {
  if (!isRecord(data)) throw new Error("invalid_payment_requirements");
  const scheme = asString(data.scheme);
  const network = asString(data.network);
  const payTo = asString(data.payTo ?? data.pay_to);
  const asset = asString(data.asset ?? data.currency);
  const amount = asString(data.amount ?? data.maxAmountRequired ?? data.max_amount_required);
  const maxTimeoutSeconds = asInt(data.maxTimeoutSeconds ?? data.max_timeout_seconds);
  if (!scheme || !network || !payTo || !asset || !amount || maxTimeoutSeconds == null) throw new Error("invalid_payment_requirements");
  const issuer = asString(data.issuer);
  const invoiceId = asString(data.invoiceId ?? data.invoice_id);
  let extra = isRecord(data.extra) ? { ...data.extra } : data.extra === null ? null : undefined;
  if (issuer || invoiceId) {
    const bag = extra && extra !== null ? { ...extra } : {};
    if (issuer && bag.issuer == null) bag.issuer = issuer;
    if (invoiceId && bag.invoiceId == null) bag.invoiceId = invoiceId;
    extra = bag;
  }
  return { scheme, network, payTo, asset, amount, maxTimeoutSeconds, ...(extra !== undefined ? { extra } : {}) };
}

function verifyFromWire(data: unknown): VerifyResult {
  if (!isRecord(data) || typeof data.isValid !== "boolean") throw new Error("invalid_verify_response");
  const invalidReason = asString(data.invalidReason);
  const payer = asString(data.payer);
  const extensions = isRecord(data.extensions) ? data.extensions : undefined;
  return { isValid: data.isValid, ...(invalidReason ? { invalidReason } : {}), ...(payer ? { payer } : {}), ...(extensions ? { extensions } : {}) };
}

function settlementFromWire(data: unknown): Settlement {
  if (!isRecord(data) || typeof data.success !== "boolean") throw new Error("invalid_settlement_response");
  const transaction = asString(data.transaction);
  const network = asString(data.network);
  const payer = asString(data.payer);
  const errorReason = asString(data.errorReason);
  const extensions = isRecord(data.extensions) ? data.extensions : undefined;
  const paymentResponseHeader = asString(data.paymentResponseHeader);
  return {
    success: data.success,
    ...(transaction ? { transaction } : {}),
    ...(network ? { network } : {}),
    ...(payer ? { payer } : {}),
    ...(errorReason ? { errorReason } : {}),
    ...(extensions ? { extensions } : {}),
    ...(paymentResponseHeader ? { paymentResponseHeader } : {}),
  };
}

function requirementsMatch(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return a.scheme === b.scheme && a.network === b.network && a.amount === b.amount && a.asset === b.asset && a.payTo === b.payTo && a.maxTimeoutSeconds === b.maxTimeoutSeconds && invoiceIdOf(a) === invoiceIdOf(b);
}

function invoiceIdOf(reqs: PaymentRequirements | undefined): string | undefined {
  const id = reqs?.extra && isRecord(reqs.extra) ? reqs.extra.invoiceId : undefined;
  return typeof id === "string" && id ? id : undefined;
}

function decisionToken(verify: VerifyResult): string | undefined {
  const secure = verify.extensions?.[X402_SECURE];
  if (!isRecord(secure)) return undefined;
  return typeof secure.decisionToken === "string" && secure.decisionToken ? secure.decisionToken : undefined;
}

function transientVerify(err: unknown): {
  error: string;
  reason: string;
  retryable: true;
  retryAfter: number;
  correlationId: string;
  phase: "verify";
  settlementAttempted: false;
} | undefined {
  if (!(err instanceof FacilitatorHttpError) || !isRecord(err.body)) return undefined;
  if (err.body.retryable !== true || err.body.phase !== "verify" || err.body.settlementAttempted !== false) return undefined;
  const reason = typeof err.body.reason === "string" && err.body.reason ? err.body.reason : "facilitator_unavailable";
  const raw = err.headers.get("Retry-After") ?? err.body.retryAfter ?? 30;
  const parsed = Number(raw);
  const retryAfter = Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 30;
  const correlationId = String(err.headers.get("X-Correlation-ID") ?? err.body.correlationId ?? "");
  return { error: reason, reason, retryable: true, retryAfter, correlationId, phase: "verify", settlementAttempted: false };
}

function legacyUnknown(reason: string | undefined): boolean {
  return typeof reason === "string" && ["submit_failed:", "submit_missing_tx_hash", "validation_failed:"].some((prefix) => reason.startsWith(prefix));
}

function settlementUnknown(c: { header(name: string, value: string): void; json(body: JsonRecord, status: 409): Response }, err?: FacilitatorHttpError): Response {
  const body = err && isRecord(err.body) ? err.body : {};
  const correlationId = String(err?.headers.get("X-Correlation-ID") ?? body.correlationId ?? "");
  if (correlationId) c.header("X-Correlation-ID", correlationId);
  return c.json({ error: "settlement_status_unknown", reason: "settlement_status_unknown", retryable: false, correlationId, phase: "settle", settlementAttempted: true }, 409);
}

function defaultInvoiceId(): string {
  return crypto.randomUUID().replace(/-/g, "").toUpperCase();
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  return undefined;
}

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  const out: JsonRecord = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]) as JsonValue;
  return out;
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
