# xrp-dev

XRPL SDK for plain TypeScript: hashing, secp256k1 / ed25519, classic and X-addresses, the binary codec and a JSON-RPC / WebSocket client. The main entry holds no wallet and no key storage. Wallets are `xrp-dev/wallet`; the MCP server is `xrp-dev/mcp` (bin `xrp-dev-mcp`). It runs unchanged on Cloudflare Workers (workerd), Bun, browsers and Node. Functions return values or throw, network calls return Promises, and an [Effect](https://effect.website) API of the same functions is under `xrp-dev/effect`.

> **Not independently audited as a whole:** SHA-256, SHA-512, secp256k1, ed25519 and RIPEMD-160 are [`@noble/curves`](https://github.com/paulmillr/noble-curves) and [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) (audited: Trail of Bits 2023 and Aug 2026, Cure53 2024, Kudelski 2023, per the noble README). The binary codec, address and seed code, JSON-RPC client and the glue between them are this repository's and have had no third-party audit.

## Security

noble targets algorithmic constant time. Its README: "_JIT-compiler_ and _Garbage Collector_ make 'constant time' extremely hard to achieve [timing attack] resistance in a scripting language", so no JavaScript library can promise constant-timeness, and "if your goal is absolute security, don't use any JS lib". Within those limits its secret-scalar multiplication uses a fixed operation sequence, data-oblivious table scans and scalar blinding; ed25519 signing only multiplies the blinded base point. Judge for yourself before signing for remote callers in a shared-host service. Signing on the key owner's own device is the safer default. Verification and hashing take only public inputs and are fine anywhere. JavaScript cannot erase BigInts, which noble uses for scalars; zeroing a `Uint8Array` does not remove those copies.

noble requires Node >= 20.19 and is ESM-only.

## Runtime

- Browsers need a secure context (HTTPS or localhost) for WebAuthn and for WebCrypto (`crypto.subtle`). Within this package only the server half of `xrp-dev/auth` (`createChallenge`, `verifyLogin`: HMAC) and the wallet's PRF derivation (`Wallet.fromPrf`, the passkey adapter: HKDF) use `crypto.subtle`; hashing, addresses, the codec and signing do not.
- `AbortSignal.any` needs Node >= 20.3 (the package as a whole needs >= 20.19, noble's floor), Chrome 116, Safari 17.4 or Firefox 124.
- CORS: `PUBLIC_RPC_URLS.mainnet` and `.testnet` answer the preflight, so a browser can call them. devnet has no CORS-enabled public JSON-RPC: use `createWsClient` (WebSocket is not subject to CORS) or a same-origin proxy.

## Install

```sh
bun add xrp-dev   # or: npm i xrp-dev
```

`effect` (`^4.0.2`) is a regular dependency, installed with `xrp-dev` and shared with your own copy when the versions allow. You only touch it through `xrp-dev/effect`, `xrp-dev/mcp` and `xrp-dev/name/server` (`validateName` returns an Effect).

## Entry points

| Import | What |
| --- | --- |
| `xrp-dev` | crypto, address, codec and client: plain functions that throw, and Promises for the client. No keys |
| `xrp-dev/crypto` | sha256 / sha512Half / ripemd160, base58, secp256k1, ed25519 |
| `xrp-dev/address` | classic addresses, X-addresses, seeds |
| `xrp-dev/codec` | `encode`, `decode`, signing blobs, `hashTransaction`, `verifyTransaction`; each takes optional `defs` (codec tables) last |
| `xrp-dev/client` | `Client` (xrpl.js style: `request`, `autofill`, `submit`, `submitAndWait`), or the functions `createRpcClient`, `createWsClient`, `autofill`, `submit`, `submitAndWait`; `NETWORK_PRESETS` |
| `xrp-dev/effect` | the alpha.4 API: fallible and I/O functions return `Effect`s that fail with the same error classes, pure helpers (`bytesToHex`, `ripemd160`, `isValid*Key`, ...) return values. Subpaths: `/effect/crypto`, `/effect/address`, `/effect/codec`, `/effect/wallet`, `/effect/client` |
| `xrp-dev/xahau` | `XAHAU_DEFINITIONS`: codec tables for Xahau, pass as `defs`. Types for the Xahau-only transactions (`Remit`, `URITokenMint`, `SetHook`, `Import`, ..., union `XahauTransaction`); each is assignable to `TxJson` |
| `xrp-dev/auth` | wallet sign-in: `createChallenge`, `verifyLogin` (server), `login(adapter, { app })` (browser); see [Wallet sign-in](#wallet-sign-in-xrp-devauth) |
| `xrp-dev/name` | one unique name per account: rules, client checks (`createNameChecker`, `registerWithName`). Browser-safe, no `effect` |
| `xrp-dev/name/server` | the server half: store helpers (`registerPasskeyAccount`, `loginWithName`), availability handler. Re-exports `xrp-dev/name` |
| `xrp-dev/wallet` | keys and signing: plain functions that throw `WalletError` (`Wallet.fromPrf` is a Promise). Not loaded by the entries above |
| `xrp-dev/passkey` | xrpl-connect passkey adapter. Needs the optional `xrpl` and `xrpl-connect` peers, types only |
| `xrp-dev/mcp` | tool registry and JSON-RPC handler. Bin: `xrp-dev-mcp` |
| `xrp-dev/x402` | Hono gate for x402 v2 exact payments on XRPL (`requirePayment`). Needs the optional `hono` peer |

The first five entries re-export their own error class (`CryptoError`, `AddressError`, `CodecError`, `ClientError`), so importing one is enough to catch and narrow its errors. `xrp-dev/wallet` throws `WalletError`.

```ts run
import { isValidClassicAddress } from "xrp-dev/address";
import { encode, hashTransaction } from "xrp-dev/codec";
import { Client, ClientError } from "xrp-dev/client";
import { Wallet } from "xrp-dev/wallet";

const tx = { TransactionType: "Payment", Account: "rrrrrrrrrrrrrrrrrrrrrhoLvTp", Destination: "rrrrrrrrrrrrrrrrrrrrBZbvji", Amount: "1", Fee: "10", Sequence: 1, SigningPubKey: "" };
const ok = isValidClassicAddress(tx.Account);
const hash = hashTransaction(encode(tx));

// Send a payment on the testnet: build, autofill, sign, submit and wait until it is validated.
const client = new Client("testnet");
const wallet = Wallet.fromEntropy(crypto.getRandomValues(new Uint8Array(16)));
try {
  const filled = await client.autofill({ TransactionType: "Payment", Account: wallet.address, Destination: tx.Destination, Amount: "1000000" });
  const result = await client.submitAndWait(wallet.sign(filled).tx_blob);
  console.log(result.transaction_result); // "tesSUCCESS", or a "tec…" code: applied, but it failed
} catch (e) {
  if (e instanceof ClientError) console.error(e.reason); // "http", "timeout", "rippled_error", "rejected", "expired", "aborted", ...
}
await client.disconnect();
```

`client.request("account_info", { account })` and xrpl.js' `client.request({ command: "account_info", account })` both resolve to the node's `result`. A `wss://` URL gives a WebSocket client; `"mainnet"`, `"testnet"` and `"devnet"` name the public nodes. Every call takes `{ signal }` to abort it (it rejects with `ClientError` reason `aborted`) and `autofill`, `submit`, `submitAndWait` take `{ timeoutMs }` to bound it (reason `timeout`). A client you write yourself is handed that `signal` as `request(method, params, { signal })`; ignore it and the call still stops waiting, but your request keeps running. A `WebSocket` client's `close()` / `disconnect()` is not final: a later request opens a new socket. On a WebSocket a timeout fails only the request that timed out; the socket is replaced after three timeouts in a row with nothing heard from the node in between. `maxBodyBytes` (default 5 MiB) caps one HTTP body or one WebSocket message; a WebSocket message over it fails the socket with `too_large`. `submitAndWait` takes `timeoutMs` as one deadline for the whole call; once the transaction is submitted, errors while polling are retried until that deadline, and a resubmitted blob the node answers `tefALREADY` or `tefPAST_SEQ` is looked up by hash and resolves with the ledger's result.

Everything in `crypto`, `address` and `codec` is synchronous: a result is returned, and a failure throws the entry's error class (`AddressError`, `CodecError`, `CryptoError`). Only the client is asynchronous: its methods return Promises that reject with `ClientError`. The errors are plain `Error` subclasses with `_tag` and `reason`. `crypto`, `address`, `codec`, `auth` and `wallet` import no `effect`, so a bundle of those subpaths carries none of it; the client, the root `xrp-dev` entry (which re-exports the client) and `xrp-dev/name/server` do. For Effects, import from `xrp-dev/effect/...` instead; the functions and errors are the same. `PasskeyAdapter` and `xrp-dev/mcp` accept either client (`toEffectClient` from `xrp-dev/effect/client` converts one explicitly). 

## Wallet sign-in (`xrp-dev/auth`)

The server issues a challenge, the wallet signs a text that names it, the server checks both. A challenge is `<unix ms>.<random 128-bit nonce>.<HMAC>`; the HMAC covers `app`, `origin`, the time and the nonce, and the signed text names the app, the origin and, when the app passes one, the account `name` (so a relayed signature cannot register a different permanent name). `origin` is the web origin the page is served from (`https://app.example`): configure it, do not read it from the request. It is required on the server; the browser `login()` passes `location.origin` unless you give `origin`. A challenge from another app or origin, one older than 5 minutes and one in the format before the nonce fail with `challenge_invalid`.

**Replay:** without `consumeChallenge` the server is stateless and a captured signed login can be replayed until its challenge expires (5 minutes). To make a challenge single-use, pass `consumeChallenge(nonce, expiresAtMs)`; it is called once per correctly signed login and must return `false` (sync or async) if it has seen the nonce, which makes `verifyLogin` answer `challenge_used`. It must be atomic: with several servers use a database insert that fails on a duplicate, and delete rows after `expiresAtMs`.

```ts
import { createChallenge, verifyLogin } from "xrp-dev/auth";

const ORIGIN = "https://app.example";
const spent = new Map<string, number>(); // nonce -> expiresAtMs; a DB table with a UNIQUE nonce (insert-or-fail) works across servers
const consumeChallenge = (nonce: string, expiresAtMs: number) => {
  for (const [n, at] of spent) if (at < Date.now()) spent.delete(n);
  return spent.has(nonce) ? false : (spent.set(nonce, expiresAtMs), true);
};

app.get("/api/auth/challenge", async (c) => c.json({ challenge: await createChallenge(c.env.JWT_SECRET, { app: APP, origin: ORIGIN }) }));
app.post("/api/auth/login", async (c) => {
  const body = await c.req.json();
  const r = await verifyLogin(c.env.JWT_SECRET, { app: APP, origin: ORIGIN, ...body, consumeChallenge }); // `{ address }` or `{ code }`
  // set the session for r.address
});
```

Failures: `invalid_request` (no credential, or `proof` over 4096, `signature` over 160, `publicKey` over 66, `name` over 128 characters), `challenge_invalid`, `signature_invalid`, `challenge_used`.

## Unique names (`xrp-dev/name`)

Every app that signs up with a passkey binds one unique, immutable name to the account when it is created. The rules, the race-safe server flow and the client checks live here once; the app supplies a three-method store over its own table and the copy for the error codes. `xrp-dev/name` (rules and client, plain `Error`s, imports no `effect`) is what a browser bundle takes; `xrp-dev/name/server` adds the Effect-based `validateName` and the store helpers.

Table (SQLite/D1 shown; Postgres and MySQL work the same): `account` and `name` both `UNIQUE`, `name` stored normalised.

```sql
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE UNIQUE INDEX users_account_unique ON users (account);
CREATE UNIQUE INDEX users_name_unique ON users (name);
```

Server (Hono + Drizzle/D1; `create` must be a single insert and must throw on a UNIQUE violation, which is what keeps two racing sign-ups apart):

```ts
import { loginWithName, nameAvailabilityHandler, type NameStore } from "xrp-dev/name/server";

const store = (db: DrizzleD1Database): NameStore<User> => ({
  findByAccount: (account) => db.select().from(users).where(eq(users.account, account)).get(),
  findByName: (name) => db.select().from(users).where(eq(users.name, name)).get(),
  create: (account, name) => db.insert(users).values({ account, name }).returning().get(),
});

app
  .get("/username", nameAvailabilityHandler<Context<Env>>((c) => store(c.get("db")), { reserved: ["gallery"] }))
  .post("/login", async (c) => {
    const r = await loginWithName(c.env.JWT_SECRET, store(c.get("db")), { app: APP, origin: ORIGIN, body: await c.req.json().catch(() => null), reserved: ["gallery"] });
    if ("code" in r) return c.json({ code: r.code, reason: r.reason, message: r.message }, r.status);
    // set the session for r.address (r.user.name, r.created) as before
    return c.json({ address: r.address, name: r.user.name });
  });
```

| Export | What |
| --- | --- |
| `parseName(raw, rules?)` | `{ name }` (trimmed, lower case) or `{ reason }`. `[a-z0-9_]`, 3-20 characters, no leading or trailing `_`, not reserved. `rules`: `{ min?, max?, reserved? }` (extra words) |
| `validateName(raw, rules?)` | `xrp-dev/name/server` only: the same as `Effect<string, NameError>`. `NameError` is a plain `Error` with `_tag`, `code` and `reason` |
| `RESERVED_NAMES`, `NAME_MIN`, `NAME_MAX` | the default rules: auth/ops words, route-like words, `vocab` |
| `registerPasskeyAccount(store, account, name, opts?)` | registered account: its row, `created: false`, `name` ignored. New account: needs a valid free `name`. `{ user, created }` or a failure |
| `claimName(store, account, name, opts?)` | the insert half: a UNIQUE rejection becomes `name_taken`, or the existing row when this account was just registered |
| `loginWithName(secret, store, { app, origin, body, consumeChallenge?, ...opts })` | `verifyLogin` + `registerPasskeyAccount` on a `POST /login` body; `{ address, user, created }` or `{ code, status, message, reason? }` |
| `checkNameAvailable(store, raw, opts?)`, `nameAvailabilityHandler(store, opts?)` | `{ name, available }`; the handler serves `GET ?name=` (rate-limit it: it is unauthenticated) |
| `isUniqueViolation(error)` | SQLite/D1, Postgres, MySQL; override with `opts.isConflict` |
| `checkNameAvailability(raw, { base?, path?, fetch?, signal? })` | browser: local rules, then `GET /api/auth/username?name=`. For a live check, not for the click |
| `registerWithName(raw, register, rules?)` | browser: local rules only, then `register(name)` is called synchronously (no `await` before it: Safari loses the click's user activation across a fetch and `navigator.credentials.create` fails with `NotAllowedError`). Then connect and `login(adapter, { app, name })` binds the name |
| `createNameChecker({ delayMs?, ...})` | debounced live check: `set(input)`, `get()`, `subscribe(fn)` (fits `useSyncExternalStore`), `destroy()`; states `idle`, `checking`, `available`, `taken`, `invalid`, `error` |
| `nameErrorFrom(error)` | a `NameError` from a `login()` failure (`LoginError` carries `status`, `code`, `reason`) |

Codes are stable; the copy is the app's (`opts.messages` on the server, a `reason` lookup in the UI). A failure is `{ code, reason }`: `name_required` (428, `required`), `name_invalid` (400, `too_short` / `too_long` / `bad_charset` / `bad_edge` / `reserved`), `name_taken` (409, `taken`); the client adds `check_failed` (`NameError` only). `login()` already sends `name` in the body and now throws a `LoginError`.

**Lost race:** the passkey is created before the server sees the name, so someone can take it in between. `login()` then fails with `name_taken` (`nameErrorFrom(error)?.reason === "taken"`) and the passkey is left without an account. That is accepted: show the error and let the user choose another name (the same passkey signs in with the new one, nothing is lost); `createNameChecker` makes it rare.

Repository and issues: <https://github.com/dayjobdoor/xrp-dev>. MIT.
