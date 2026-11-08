# Layering

Read this before changing `packages/core/src/effect/*`, `packages/wallet/src/effect.ts`, `src/client.ts`, or the return type of a public entry.

## Plain implementation

`crypto`, `address`, `codec`, `auth` and `wallet` are plain TypeScript: a function returns its value or throws `CryptoError` / `AddressError` / `CodecError` / `WalletError`. Those are plain `Error`s with `_tag`, `reason` and an optional `cause` (`packages/core/src/errors.ts`, `packages/wallet/src/errors.ts`). None of them imports `effect`.

- That is enforced, not asked for: `portability.test.ts` (P03, in core and in wallet) bundles each entry with `effect` left external and fails on an import of it; `scripts/check-bundles.ts` fails when an entry outgrows its budget or `client` carries the secp256k1 curve.
- Only `crypto.subtle` is asynchronous: HKDF in the wallet's passkey path (`Wallet.fromPrf`, `entropyFromPrf` return Promises) and the HMAC of `auth`.
- Key material: every copy the wallet makes is zeroed in a `finally`, however the call ends. Do not keep one longer.

## Effect adapters

`packages/core/src/effect/{crypto,address,codec,secp256k1,ed25519}.ts` and `packages/wallet/src/effect.ts` are thin adapters over the plain functions, published as `xrp-dev/effect/*`.

- `lift(ErrorClass)(f)` makes `f` return `Effect<T, ErrorClass>`; `lift(A, B)` allows either; `liftAsync` is the Promise twin; `liftTotal` is for a function that cannot fail. A throw of a listed class is a typed failure, any other throw is a defect. The declared error type is therefore true; do not widen it.
- Every adapter call is annotated `/* @__PURE__ */`, and so is the `lift(...)` factory call: a top-level call is otherwise kept by a bundler, and `client` then drags in the curves.
- Behavior tests run against the adapters (the differential tests against ripple-binary-codec, xrpl.js, Wycheproof and RFC 8032 are written in Effect); `packages/core/test/public-api.test.ts` and `plain-contracts.test.ts` cover the plain functions.

## Where Effect is the implementation

- `packages/core/src/effect/client.ts`: the JSON-RPC and WebSocket client (timeouts, interruption, socket bookkeeping). `src/client.ts` wraps it with `Effect.runPromise` for the Promise API (`Client`, `submitAndWait`, `{ signal, timeoutMs }`).
- `toEffectClient` turns a Promise client or an Effect client into the Effect one; `PasskeyAdapter`, `xrp-dev/mcp` and the Effect `autofill` / `submit` accept either.
- `xrp-dev/passkey` and the MCP tools are written in Effect and use the `xrp-dev/effect/*` entries.

## Build and dist

Wallet, mcp and x402 are private sources that `packages/core/scripts/assemble.ts` copies into `packages/core/dist/` (`xrp-dev/wallet`, `xrp-dev/passkey`, `xrp-dev/mcp`, `xrp-dev/x402`). Tests and snippets reach `xrp-dev/*` through that `dist`, so an old or incomplete `dist` makes a run fail for a reason that is not the change.

- `bun run build` at the repo root builds all four and assembles them. `bun run build` inside `packages/core` rebuilds core and copies back the siblings that were built before.
- The test preload (`test/bun-setup.ts`) fails when a part is missing from `dist` and warns when `dist` is older than a package's `src`.
- A bundle size that moves on purpose: `bun scripts/check-bundles.ts --update`, then record the new sizes in `CHANGELOG.md`.
