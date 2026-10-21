import { Effect } from "effect";
import { verifyLogin, type LoginFailure } from "./auth.js";
import { NAME_MESSAGES, NameError, nameCode, nameError, parseName, type NameCode, type NameReason, type NameRules } from "./name.js";

export * from "./name.js";

// Server half of `xrp-dev/name`: a store over the app's table, race-safe binding, `loginWithName`. Re-exports the rules.

/** Effect form of `parseName`: the normalised name, or a `NameError`. */
export const validateName = (raw: unknown, rules?: NameRules): Effect.Effect<string, NameError> => {
  const parsed = parseName(raw, rules);
  return "name" in parsed ? Effect.succeed(parsed.name) : Effect.fail(nameError(parsed.reason));
};

/** What the store returns: the app's own row, as long as it carries the account and its name. */
export type NameRecord = { account: string; name: string };

/**
 * The app's side. `account` is the XRPL classic address. Back it with a table that has UNIQUE(account) and UNIQUE(name):
 * `create` must be ONE insert of both columns (no separate "reserve the name" step), so the database is what keeps two
 * racing sign-ups apart, and must throw when a UNIQUE constraint rejects it.
 */
export type NameStore<T extends NameRecord = NameRecord> = {
  findByAccount(account: string): Promise<T | null | undefined> | T | null | undefined;
  findByName(name: string): Promise<T | null | undefined> | T | null | undefined;
  create(account: string, name: string): Promise<T> | T;
};

export type ServerNameOptions = NameRules & {
  /** Copy per reason or login failure code; defaults to `NAME_MESSAGES` (English). */
  messages?: Partial<Record<NameReason | LoginFailure, string>>;
  /** Tells a UNIQUE rejection from other errors; defaults to `isUniqueViolation`. */
  isConflict?: (error: unknown) => boolean;
};

export type NameFailure = { code: NameCode; reason: NameReason; status: 400 | 409 | 428; message: string };

const failure = (reason: NameReason, opts: ServerNameOptions = {}): NameFailure => ({
  code: nameCode(reason),
  reason,
  status: reason === "required" ? 428 : reason === "taken" ? 409 : 400,
  message: opts.messages?.[reason] ?? NAME_MESSAGES[reason],
});

const UNIQUE = /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|duplicate key value|Duplicate entry/i;
const UNIQUE_CODES = new Set(["23505", "ER_DUP_ENTRY", "SQLITE_CONSTRAINT_UNIQUE"]);

/** SQLite/D1 ("UNIQUE constraint failed"), Postgres (23505) and MySQL (ER_DUP_ENTRY), anywhere along the `cause` chain (Drizzle wraps the driver's error). */
export const isUniqueViolation = (error: unknown, depth = 0): boolean => {
  if (!error || typeof error !== "object" || depth > 5) return false;
  const { message, code, cause } = error as { message?: unknown; code?: unknown; cause?: unknown };
  return (typeof message === "string" && UNIQUE.test(message)) || (typeof code === "string" && UNIQUE_CODES.has(code)) || isUniqueViolation(cause, depth + 1);
};

/** Is `raw` free? The database's UNIQUE constraint still decides at `create`; this is the live check. */
export const checkNameAvailable = async (store: NameStore, raw: unknown, opts: ServerNameOptions = {}): Promise<{ name: string; available: boolean } | NameFailure> => {
  const parsed = parseName(raw, opts);
  if (!("name" in parsed)) return failure(parsed.reason, opts);
  return { name: parsed.name, available: !(await store.findByName(parsed.name)) };
};

/**
 * Hono handler for `GET ?name=`: `{ name, available }`, or `{ code: "name_invalid", reason, message }` (400).
 * Unauthenticated by nature: put a rate limit in front of it. Annotate the context: `nameAvailabilityHandler<Context<Env>>(...)`.
 */
export const nameAvailabilityHandler =
  <C extends { req: { query(key: string): string | undefined } }>(store: NameStore | ((c: C) => NameStore), opts?: ServerNameOptions) =>
  async (c: C): Promise<Response> => {
    const result = await checkNameAvailable(typeof store === "function" ? store(c) : store, c.req.query("name"), opts);
    return "code" in result ? Response.json({ code: result.code, reason: result.reason, message: result.message }, { status: result.status }) : Response.json(result);
  };

/**
 * Binds `name` to `account` in one `create`. A UNIQUE rejection means either this account was registered a moment ago
 * (returned as is, `created: false`) or the name belongs to someone else (`name_taken`).
 */
export const claimName = async <T extends NameRecord>(
  store: NameStore<T>,
  account: string,
  raw: unknown,
  opts: ServerNameOptions = {},
): Promise<{ user: T; created: boolean } | NameFailure> => {
  const parsed = parseName(raw, opts);
  if (!("name" in parsed)) return failure(parsed.reason, opts);
  try {
    return { user: await store.create(account, parsed.name), created: true };
  } catch (error) {
    if (!(opts.isConflict ?? isUniqueViolation)(error)) throw error;
    const raced = await store.findByAccount(account);
    return raced ? { user: raced, created: false } : failure("taken", opts);
  }
};

/**
 * Sign-up or sign-in of an account that proved its key: a registered account returns its row (any `name` sent is ignored,
 * names are immutable); a new one needs a valid free `name`.
 */
export const registerPasskeyAccount = async <T extends NameRecord>(
  store: NameStore<T>,
  account: string,
  raw: unknown,
  opts: ServerNameOptions = {},
): Promise<{ user: T; created: boolean } | NameFailure> => {
  const existing = await store.findByAccount(account);
  return existing ? { user: existing, created: false } : claimName(store, account, raw, opts);
};

export type LoginFailureResult = { code: LoginFailure; status: 400 | 401; message: string; reason?: undefined };

/**
 * `POST /login` in one call: `verifyLogin` (challenge + signature or proof) then `registerPasskeyAccount`. `body` is the
 * parsed JSON as it came in (`{ challenge, signature?, publicKey?, proof?, name? }`). On success the app sets its session
 * for `address`; on failure answer `{ code, reason, message }` with `status`.
 */
export const loginWithName = async <T extends NameRecord>(
  secret: string,
  store: NameStore<T>,
  p: { app: string; body: unknown } & ServerNameOptions,
): Promise<{ address: string; user: T; created: boolean } | NameFailure | LoginFailureResult> => {
  const reject = (code: LoginFailure, status: 400 | 401): LoginFailureResult => ({ code, status, message: p.messages?.[code] ?? NAME_MESSAGES[code] });
  const b = (typeof p.body === "object" && p.body !== null ? p.body : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof b[key] === "string" ? (b[key] as string) : undefined);
  const challenge = text("challenge");
  if (challenge === undefined || (b.name !== undefined && typeof b.name !== "string")) return reject("invalid_request", 400);
  const verified = await verifyLogin(secret, { app: p.app, challenge, signature: text("signature"), publicKey: text("publicKey"), proof: text("proof") } as Parameters<typeof verifyLogin>[1]);
  if ("code" in verified) return reject(verified.code, verified.code === "invalid_request" ? 400 : 401);
  const registered = await registerPasskeyAccount(store, verified.address, b.name, p);
  return "code" in registered ? registered : { address: verified.address, ...registered };
};
