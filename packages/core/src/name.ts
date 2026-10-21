import type { LoginFailure } from "./auth.js";

/**
 * One unique name per account, bound when the account is created (passkey sign-up) and shared by every app.
 * This entry is for browsers: the rules and the client half (plain `fetch` and a debounced checker), no `effect`.
 * The server half (store helpers, `loginWithName`, `validateName`) is `xrp-dev/name/server`.
 * Wire codes (stable, for the app to translate): `name_required` (428), `name_invalid` + `reason` (400), `name_taken` (409).
 */

export type NameReason = "required" | "too_short" | "too_long" | "bad_charset" | "bad_edge" | "reserved" | "taken" | "check_failed";
export type NameCode = "name_required" | "name_invalid" | "name_taken" | "name_check_failed";

export const NAME_MIN = 3;
export const NAME_MAX = 20;

/**
 * Names no one can take because they are (or may become) a path, an auth/ops word or a brand. Includes xrpst's list
 * (`/:name` is its Payment Pointer namespace next to `/auth` and `/op`). Apps add their own routes through `rules.reserved`.
 */
export const RESERVED_NAMES: readonly string[] = Object.freeze([
  "about", "account", "accounts", "admin", "administrator", "api", "app", "assets", "auth", "billing", "blog", "callback", "challenge",
  "config", "contact", "dashboard", "docs", "explore", "favicon", "health", "help", "home", "index", "login", "logout", "manifest", "me",
  "null", "offline", "op", "pay", "payment", "payments", "privacy", "profile", "profiles", "public", "register", "robots", "root", "settings",
  "signin", "signup", "sitemap", "static", "status", "support", "sw", "system", "terms", "undefined", "user", "username", "users", "verify",
  "vocab", "wallet", "www", "xrp", "xrpl",
]);

export type NameRules = {
  min?: number;
  max?: number;
  /** Added to `RESERVED_NAMES` (lower case). */
  reserved?: Iterable<string>;
};

/** Case-insensitive uniqueness: trim, lower case. */
export const normalizeName = (raw: string): string => raw.trim().toLowerCase();

/** `{ name }` (normalised) or `{ reason }`. Order: blank, charset `[a-z0-9_]`, length, leading/trailing `_`, reserved. */
export const parseName = (raw: unknown, rules: NameRules = {}): { name: string } | { reason: NameReason } => {
  const name = typeof raw === "string" ? normalizeName(raw) : "";
  if (!name) return { reason: "required" };
  if (!/^[a-z0-9_]+$/.test(name)) return { reason: "bad_charset" };
  if (name.length < (rules.min ?? NAME_MIN)) return { reason: "too_short" };
  if (name.length > (rules.max ?? NAME_MAX)) return { reason: "too_long" };
  if (name.startsWith("_") || name.endsWith("_")) return { reason: "bad_edge" };
  if (RESERVED_NAMES.includes(name) || [...(rules.reserved ?? [])].some((word) => word.toLowerCase() === name)) return { reason: "reserved" };
  return { name };
};

export const NAME_MESSAGES: Record<NameReason | LoginFailure, string> = {
  required: "A name is required.",
  too_short: "The name is too short.",
  too_long: "The name is too long.",
  bad_charset: "Use a-z, 0-9 and _ only.",
  bad_edge: "The name cannot start or end with _.",
  reserved: "This name is reserved.",
  taken: "This name is already taken.",
  check_failed: "Could not check the name.",
  invalid_request: "A signature (or proof) is required.",
  challenge_invalid: "The challenge is invalid or expired.",
  signature_invalid: "The signature is not valid.",
};

/** The wire `code` of a reason. */
export const nameCode = (reason: NameReason): NameCode =>
  reason === "required" ? "name_required" : reason === "taken" ? "name_taken" : reason === "check_failed" ? "name_check_failed" : "name_invalid";

/** Plain `Error` (no Effect, so a browser bundle of this entry stays small). `_tag` keeps it compatible with tagged-error handling. */
export class NameError extends Error {
  readonly _tag = "NameError";
  readonly code: NameCode;
  readonly reason: NameReason;
  constructor(p: { reason: NameReason; message?: string }) {
    super(p.message ?? NAME_MESSAGES[p.reason]);
    this.name = "NameError";
    this.reason = p.reason;
    this.code = nameCode(p.reason);
  }
}

export const nameError = (reason: NameReason, message?: string) => new NameError({ reason, ...(message !== undefined && { message }) });

// ---------------------------------------------------------------- client

export type NameClientOptions = NameRules & {
  /** Origin prefix, as for `login` (default: same origin). */
  base?: string;
  /** Availability endpoint, default `/api/auth/username`. */
  path?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

const REASONS = new Set<string>(["required", "too_short", "too_long", "bad_charset", "bad_edge", "reserved", "taken", "check_failed"]);

/** A `NameError` from a server answer `{ code, reason?, message? }` (a `login` failure carries them); `undefined` for anything else. */
export const nameErrorFrom = (error: unknown): NameError | undefined => {
  if (error instanceof NameError) return error;
  const { code, reason, message } = (error ?? {}) as { code?: unknown; reason?: unknown; message?: unknown };
  const known = typeof reason === "string" && REASONS.has(reason) ? (reason as NameReason) : undefined;
  const mapped = code === "name_required" ? "required" : code === "name_taken" ? "taken" : code === "name_invalid" ? (known ?? "bad_charset") : undefined;
  return mapped ? nameError(mapped, typeof message === "string" ? message : undefined) : undefined;
};

/** Asks the server whether `raw` is free. Invalid names throw a `NameError` without a request; a taken one answers `available: false`. */
export const checkNameAvailability = async (raw: string, opts: NameClientOptions = {}): Promise<{ name: string; available: boolean }> => {
  const parsed = parseName(raw, opts);
  if (!("name" in parsed)) throw nameError(parsed.reason);
  const url = `${opts.base ?? ""}${opts.path ?? "/api/auth/username"}?name=${encodeURIComponent(parsed.name)}`;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, { signal: opts.signal ?? null });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    throw nameError("check_failed");
  }
  const body = (await res.json().catch(() => ({}))) as { available?: unknown };
  if (res.ok && typeof body.available === "boolean") return { name: parsed.name, available: body.available };
  throw nameErrorFrom(body) ?? nameError("check_failed");
};

/**
 * Validates `raw` with the local rules (no network) and calls `register(name)` synchronously, in the same turn as the
 * click: Safari drops the user activation across an awaited fetch and `navigator.credentials.create` then fails with
 * NotAllowedError. A name taken in the meantime surfaces afterwards as `name_taken` (409) from `login(adapter, { app, name })`
 * (see `nameErrorFrom`). That leaves an orphan passkey, which is accepted: the app shows the error and lets the user pick
 * another name (the passkey can be reused for it, or removed in the OS). Use `createNameChecker` to warn earlier.
 * Throws a `NameError` for an invalid name, without calling `register`.
 */
export const registerWithName = <R>(raw: string, register: (name: string) => Promise<R> | R, rules?: NameRules): Promise<{ name: string; result: R }> => {
  const parsed = parseName(raw, rules);
  if (!("name" in parsed)) return Promise.reject(nameError(parsed.reason));
  const { name } = parsed;
  try {
    return Promise.resolve(register(name)).then((result) => ({ name, result }));
  } catch (error) {
    return Promise.reject(error);
  }
};

export type NameCheckState = {
  input: string;
  status: "idle" | "checking" | "available" | "taken" | "invalid" | "error";
  /** Set for `invalid` (`required` is never shown: a blank input is `idle`), `taken` and `error` (`check_failed`). */
  reason?: NameReason;
  /** The normalised name once it parsed. */
  name?: string;
};

/**
 * Debounced live check for an input. `set` on every keystroke; read `get()`, react through `subscribe` (shaped for
 * React's `useSyncExternalStore`; states are replaced, never mutated). Invalid input is reported at once without a
 * request, an older answer never overwrites a newer input.
 */
export const createNameChecker = (opts: Omit<NameClientOptions, "signal"> & { delayMs?: number } = {}) => {
  let state: NameCheckState = { input: "", status: "idle" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const listeners = new Set<() => void>();
  const emit = (next: NameCheckState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const cancel = () => {
    clearTimeout(timer);
    controller?.abort();
    controller = undefined;
  };
  return {
    get: () => state,
    subscribe: (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener)),
    set(input: string) {
      cancel();
      const parsed = parseName(input, opts);
      if (!("name" in parsed)) return emit(parsed.reason === "required" ? { input, status: "idle" } : { input, status: "invalid", reason: parsed.reason });
      const { name } = parsed;
      emit({ input, status: "checking", name });
      const mine = (controller = new AbortController());
      timer = setTimeout(async () => {
        try {
          const { available } = await checkNameAvailability(name, { ...opts, signal: mine.signal });
          if (controller === mine) emit(available ? { input, status: "available", name } : { input, status: "taken", name, reason: "taken" });
        } catch (error) {
          if (controller === mine) emit({ input, status: "error", name, reason: nameErrorFrom(error)?.reason ?? "check_failed" });
        }
      }, opts.delayMs ?? 300);
    },
    /** Stop timers and in-flight requests; the state stays. */
    destroy: () => (cancel(), listeners.clear()),
  };
};
