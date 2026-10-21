import { Effect } from "effect";
import { sign as keypairSign } from "ripple-keypairs";
import { describe, expect, it, vi } from "vite-plus/test";
import { Wallet as XrplWallet } from "xrpl";
import { createChallenge, loginMessage, LoginError } from "../src/auth.js";
import {
  RESERVED_NAMES,
  NameError,
  checkNameAvailability,
  checkNameAvailable,
  claimName,
  createNameChecker,
  isUniqueViolation,
  loginWithName,
  nameAvailabilityHandler,
  nameErrorFrom,
  normalizeName,
  parseName,
  registerPasskeyAccount,
  registerWithName,
  validateName,
  type NameRecord,
  type NameStore,
} from "../src/name-server.js";

type Row = NameRecord & { id: number };

/** A table with UNIQUE(account) and UNIQUE(name) whose insert yields first, so two callers really interleave. */
const makeStore = () => {
  const rows: Row[] = [];
  const store: NameStore<Row> = {
    findByAccount: async (account) => rows.find((r) => r.account === account),
    findByName: async (name) => rows.find((r) => r.name === name),
    create: async (account, name) => {
      await Promise.resolve();
      const clash = rows.find((r) => r.account === account) ? "users.account" : rows.find((r) => r.name === name) ? "users.name" : undefined;
      if (clash) throw new Error("Failed query", { cause: new Error(`D1_ERROR: UNIQUE constraint failed: ${clash}: SQLITE_CONSTRAINT`) });
      const row = { id: rows.length + 1, account, name };
      rows.push(row);
      return row;
    },
  };
  return { rows, store };
};

describe("parseName", () => {
  it("lower-cases and trims so uniqueness is case-insensitive", () => {
    expect(parseName("  Dave_1 ")).toEqual({ name: "dave_1" });
    expect(normalizeName(" Dave ")).toBe("dave");
  });

  it.each([
    ["", "required"],
    ["   ", "required"],
    [undefined, "required"],
    [42, "required"],
    ["ab", "too_short"],
    ["a".repeat(21), "too_long"],
    ["dave!", "bad_charset"],
    ["ダーヴ", "bad_charset"],
    ["da ve", "bad_charset"],
    ["dave-1", "bad_charset"],
    ["_dave", "bad_edge"],
    ["dave_", "bad_edge"],
    ["AUTH", "reserved"],
    ["vocab", "reserved"],
    ["admin", "reserved"],
  ])("%j -> %s", (input, reason) => {
    expect(parseName(input)).toEqual({ reason });
  });

  it("accepts the boundaries and names that merely contain a reserved word", () => {
    expect(parseName("abc")).toEqual({ name: "abc" });
    expect(parseName("a".repeat(20))).toEqual({ name: "a".repeat(20) });
    expect(parseName("dashboard_fan")).toEqual({ name: "dashboard_fan" });
    expect(parseName("a_b")).toEqual({ name: "a_b" });
  });

  it("takes per-app rules: extra reserved words and another length", () => {
    expect(parseName("gallery", { reserved: ["Gallery"] })).toEqual({ reason: "reserved" });
    expect(parseName("abcd", { min: 5 })).toEqual({ reason: "too_short" });
    expect(parseName("abcdef", { max: 5 })).toEqual({ reason: "too_long" });
  });

  it("reserves xrpst's words and the route-like ones", () => {
    for (const word of ["api", "auth", "op", "dashboard", "admin", "www", "docs", "login", "logout", "sw", "assets", "vocab"]) expect(RESERVED_NAMES).toContain(word);
    for (const word of RESERVED_NAMES) expect(word).toBe(word.toLowerCase());
  });

  it("validateName is the same rule as a tagged error", async () => {
    expect(await Effect.runPromise(validateName(" Dave "))).toBe("dave");
    const err = await Effect.runPromise(Effect.flip(validateName("x")));
    expect(err).toBeInstanceOf(NameError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("name_invalid");
    expect(err._tag).toBe("NameError");
    expect(err.reason).toBe("too_short");
  });
});

describe("isUniqueViolation", () => {
  it("finds SQLite, Postgres and MySQL conflicts through the cause chain, and nothing else", () => {
    expect(isUniqueViolation(new Error("x", { cause: new Error("UNIQUE constraint failed: users.name") }))).toBe(true);
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "ER_DUP_ENTRY" })).toBe(true);
    expect(isUniqueViolation(new Error("D1_ERROR: no such table: users"))).toBe(false);
    expect(isUniqueViolation("UNIQUE constraint failed")).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});

describe("registerPasskeyAccount", () => {
  it("asks a new account for a name (428) and creates nothing", async () => {
    const { store, rows } = makeStore();
    expect(await registerPasskeyAccount(store, "rA", undefined)).toMatchObject({ code: "name_required", reason: "required", status: 428 });
    expect(rows).toEqual([]);
  });

  it("binds the normalised name to the account at creation", async () => {
    const { store, rows } = makeStore();
    expect(await registerPasskeyAccount(store, "rA", "  Dave_1 ")).toMatchObject({ created: true, user: { account: "rA", name: "dave_1" } });
    expect(rows).toHaveLength(1);
  });

  it("rejects an invalid name (400) with the reason", async () => {
    const { store } = makeStore();
    expect(await registerPasskeyAccount(store, "rA", "x")).toMatchObject({ code: "name_invalid", reason: "too_short", status: 400 });
    expect(await registerPasskeyAccount(store, "rA", "admin")).toMatchObject({ code: "name_invalid", reason: "reserved" });
  });

  it("rejects a name another account holds, case-insensitively (409)", async () => {
    const { store } = makeStore();
    await registerPasskeyAccount(store, "rA", "dave");
    expect(await registerPasskeyAccount(store, "rB", "DAVE")).toMatchObject({ code: "name_taken", reason: "taken", status: 409 });
  });

  it("returns a registered account unchanged and ignores any name it sends (immutable)", async () => {
    const { store, rows } = makeStore();
    await registerPasskeyAccount(store, "rA", "dave");
    expect(await registerPasskeyAccount(store, "rA", "!!")).toMatchObject({ created: false, user: { name: "dave" } });
    expect(await registerPasskeyAccount(store, "rA", "erin")).toMatchObject({ created: false, user: { name: "dave" } });
    expect(rows).toHaveLength(1);
  });

  it("two accounts racing for one name: exactly one wins, the other gets name_taken", async () => {
    const { store, rows } = makeStore();
    const results = await Promise.all([registerPasskeyAccount(store, "rA", "dave"), registerPasskeyAccount(store, "rB", "dave")]);
    expect(results.filter((r) => "user" in r)).toHaveLength(1);
    expect(results.filter((r) => "code" in r)).toEqual([expect.objectContaining({ code: "name_taken" })]);
    expect(rows).toHaveLength(1);
  });

  it("the same account racing with itself is one account and both calls succeed", async () => {
    const { store, rows } = makeStore();
    const results = await Promise.all([registerPasskeyAccount(store, "rA", "dave"), registerPasskeyAccount(store, "rA", "dave")]);
    expect(results.every((r) => "user" in r && r.user.name === "dave")).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it("lets other store errors through instead of calling them a taken name", async () => {
    const { store } = makeStore();
    store.create = async () => {
      throw new Error("D1_ERROR: no such table: users");
    };
    await expect(claimName(store, "rA", "dave")).rejects.toThrow("no such table");
  });

  it("uses the app's copy and its own conflict test", async () => {
    const { store } = makeStore();
    await claimName(store, "rA", "dave");
    expect(await claimName(store, "rB", "dave", { messages: { taken: "既に使われています" } })).toMatchObject({ message: "既に使われています" });
    store.create = async () => {
      throw Object.assign(new Error("boom"), { dup: true });
    };
    expect(await claimName(store, "rC", "erin", { isConflict: (e) => (e as { dup?: boolean }).dup === true })).toMatchObject({ code: "name_taken" });
  });
});

describe("availability", () => {
  it("answers free and taken by normalised name; invalid names carry the reason", async () => {
    const { store } = makeStore();
    await claimName(store, "rA", "dave");
    expect(await checkNameAvailable(store, "Dave")).toEqual({ name: "dave", available: false });
    expect(await checkNameAvailable(store, "erin")).toEqual({ name: "erin", available: true });
    expect(await checkNameAvailable(store, "no way")).toMatchObject({ code: "name_invalid", reason: "bad_charset", status: 400 });
    expect(await checkNameAvailable(store, undefined)).toMatchObject({ code: "name_required" });
  });

  it("the Hono handler reads ?name= and picks the store from the context", async () => {
    const { store } = makeStore();
    await claimName(store, "rA", "dave");
    const handler = nameAvailabilityHandler((c: { req: { query(k: string): string | undefined } }) => store);
    const ctx = (name?: string) => ({ req: { query: (k: string) => (k === "name" ? name : undefined) } });
    const ok = await handler(ctx("DAVE"));
    expect([ok.status, await ok.json()]).toEqual([200, { name: "dave", available: false }]);
    const bad = await handler(ctx("x"));
    expect([bad.status, await bad.json()]).toEqual([400, { code: "name_invalid", reason: "too_short", message: "The name is too short." }]);
  });
});

describe("loginWithName", () => {
  const SECRET = "test-secret";
  const APP = "TEST APP";
  const hex = (text: string) => Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("");
  const A = XrplWallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb");
  const B = XrplWallet.fromSeed("sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE");
  const body = async (wallet: XrplWallet, name?: unknown, now?: number) => {
    const challenge = await createChallenge(SECRET, { app: APP, ...(now !== undefined && { now }) });
    return { challenge, signature: keypairSign(hex(loginMessage(APP, challenge)), wallet.privateKey), publicKey: wallet.publicKey, ...(name !== undefined && { name }) };
  };

  it("verifies the signature, then binds the name on first login", async () => {
    const { store } = makeStore();
    expect(await loginWithName(SECRET, store, { app: APP, body: await body(A, "  Dave_1 ") })).toMatchObject({ address: A.address, created: true, user: { account: A.address, name: "dave_1" } });
    expect(await loginWithName(SECRET, store, { app: APP, body: await body(A, "!!") })).toMatchObject({ address: A.address, created: false, user: { name: "dave_1" } });
  });

  it("asks a new address for a name, and refuses a taken one", async () => {
    const { store } = makeStore();
    expect(await loginWithName(SECRET, store, { app: APP, body: await body(A) })).toMatchObject({ code: "name_required", status: 428 });
    await loginWithName(SECRET, store, { app: APP, body: await body(A, "dave") });
    expect(await loginWithName(SECRET, store, { app: APP, body: await body(B, "DAVE") })).toMatchObject({ code: "name_taken", status: 409 });
  });

  it("registers nothing for a bad signature, a stale challenge or a malformed body", async () => {
    const { store, rows } = makeStore();
    const good = await body(A, "dave");
    expect(await loginWithName(SECRET, store, { app: APP, body: { ...good, signature: "00" + good.signature.slice(2) } })).toMatchObject({ code: "signature_invalid", status: 401 });
    expect(await loginWithName(SECRET, store, { app: APP, body: await body(A, "dave", Date.now() - 10 * 60_000) })).toMatchObject({ code: "challenge_invalid", status: 401 });
    expect(await loginWithName(SECRET, store, { app: APP, body: { challenge: good.challenge } })).toMatchObject({ code: "invalid_request", status: 400 });
    expect(await loginWithName(SECRET, store, { app: APP, body: { ...good, name: 5 } })).toMatchObject({ code: "invalid_request", status: 400 });
    expect(await loginWithName(SECRET, store, { app: APP, body: null })).toMatchObject({ code: "invalid_request" });
    expect(rows).toEqual([]);
  });
});

describe("client", () => {
  const answer = (status: number, json: unknown) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(json, { status })) as unknown as typeof fetch;

  it("checkNameAvailability normalises, asks the server and returns availability", async () => {
    const fetch = answer(200, { name: "dave", available: true });
    expect(await checkNameAvailability(" Dave ", { fetch, base: "https://x.test" })).toEqual({ name: "dave", available: true });
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("https://x.test/api/auth/username?name=dave");
  });

  it("invalid input throws a NameError without a request", async () => {
    const fetch = answer(200, {});
    await expect(checkNameAvailability("x", { fetch })).rejects.toMatchObject({ _tag: "NameError", reason: "too_short" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps a server rejection, a bad body and a network failure to stable reasons", async () => {
    await expect(checkNameAvailability("dave", { fetch: answer(400, { code: "name_invalid", reason: "reserved" }) })).rejects.toMatchObject({ reason: "reserved" });
    await expect(checkNameAvailability("dave", { fetch: answer(500, {}) })).rejects.toMatchObject({ reason: "check_failed" });
    await expect(checkNameAvailability("dave", { fetch: (async () => Promise.reject(new TypeError("offline"))) as typeof fetch })).rejects.toMatchObject({ reason: "check_failed" });
  });

  it("registerWithName calls register synchronously, with no request (Safari keeps the user activation)", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    let calledSynchronously = false;
    const pending = registerWithName(" Dave ", async (name) => {
      calledSynchronously = true;
      return `passkey:${name}`;
    }, { reserved: [] });
    expect(calledSynchronously).toBe(true);
    expect(await pending).toEqual({ name: "dave", result: "passkey:dave" });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("registerWithName refuses an invalid name without creating a passkey, and passes register's failure on", async () => {
    const register = vi.fn(async () => "x");
    await expect(registerWithName("x", register)).rejects.toMatchObject({ _tag: "NameError", code: "name_invalid", reason: "too_short" });
    await expect(registerWithName("admin", register)).rejects.toMatchObject({ reason: "reserved" });
    expect(register).not.toHaveBeenCalled();
    await expect(registerWithName("dave", async () => Promise.reject(new Error("NotAllowedError")))).rejects.toThrow("NotAllowedError");
    await expect(registerWithName("dave", () => { throw new Error("sync boom"); })).rejects.toThrow("sync boom");
  });

  it("nameErrorFrom reads the codes a login() failure carries", () => {
    expect(nameErrorFrom(new LoginError("x", 409, "name_taken"))?.reason).toBe("taken");
    expect(nameErrorFrom(new LoginError("x", 428, "name_required"))?.reason).toBe("required");
    expect(nameErrorFrom(new LoginError("x", 400, "name_invalid", "too_long"))?.reason).toBe("too_long");
    expect(nameErrorFrom(new LoginError("x", 401, "signature_invalid"))).toBeUndefined();
    expect(nameErrorFrom(new Error("plain"))).toBeUndefined();
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createNameChecker", () => {
  const setup = () => {
    const calls: string[] = [];
    const taken = new Set(["dave"]);
    const fake = (async (url: string) => {
      const name = new URL(url, "http://x").searchParams.get("name")!;
      calls.push(name);
      return Response.json({ name, available: !taken.has(name) });
    }) as unknown as typeof fetch;
    const checker = createNameChecker({ fetch: fake, delayMs: 40 });
    const seen: string[] = [];
    checker.subscribe(() => seen.push(checker.get().status));
    return { checker, calls, seen };
  };

  it("debounces keystrokes into one request and ends on the answer", async () => {
    const { checker, calls } = setup();
    for (const input of ["er", "eri", "erin"]) checker.set(input);
    expect(checker.get()).toMatchObject({ status: "checking", name: "erin" });
    await sleep(200);
    expect(calls).toEqual(["erin"]);
    expect(checker.get()).toEqual({ input: "erin", status: "available", name: "erin" });
    checker.set("Dave");
    await sleep(200);
    expect(checker.get()).toMatchObject({ status: "taken", reason: "taken", name: "dave" });
  });

  it("reports an invalid input at once without a request, and blank as idle", async () => {
    const { checker, calls } = setup();
    checker.set("a!");
    expect(checker.get()).toMatchObject({ status: "invalid", reason: "bad_charset" });
    checker.set("");
    expect(checker.get().status).toBe("idle");
    await sleep(200);
    expect(calls).toEqual([]);
  });

  it("a newer input cancels the pending one; destroy stops everything", async () => {
    const { checker, calls } = setup();
    checker.set("erin");
    await sleep(2);
    checker.set("frank");
    await sleep(200);
    expect(calls).toEqual(["frank"]);
    checker.set("gina");
    checker.destroy();
    await sleep(200);
    expect(calls).toEqual(["frank"]);
  });
});
