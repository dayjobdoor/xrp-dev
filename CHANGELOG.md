# Changelog

## 0.1.0-alpha.2 (2026-10-19)

- **Fix**: `autofill` with `definitions` probed `fee` with a blob lacking `Sequence` and `Fee`, which xahaud answers with `invalidTransaction`; every `PasskeyAdapter` send on Xahau without a preset `Fee` failed. The probe now carries `Sequence: 0` and `Fee: "0"` placeholders.

- **`xrp-dev/auth`**: wallet sign-in for apps. `createChallenge` / `isFreshChallenge` (stateless HMAC challenge bound to the app name, 5 min, constant-time compare), `loginMessage`, `verifyMessage`, `loginProofTx` / `verifyProofTx` (an unappliable `AccountSet` memo transaction for wallets that cannot sign messages), `verifyLogin` (server: challenge + signature or proof in one call, returns an address or a failure code) and `login(adapter, { app })` (browser: challenge, sign, post, session cookie).
- **`xrp-dev/xahau`**: `XAHAU_DEFINITIONS` and `XAHAU_PROTOCOL`, a `server_definitions` snapshot of Xahau (hooks, Import, URIToken, ...). Not re-exported from `.`, so the extra JSON loads only for those who import it.
- **Codec tables are a parameter**: `makeDefinitions(raw)`, `XRPL_DEFINITIONS`, and an optional last `defs` argument on `encode`, `decode`, `encodeForSigning`, `encodeForMultisigning`, `verifyTransaction`, `signerMatchesAccount`. `Wallet.sign(tx, { definitions })` and `PasskeyAdapter({ definitions })` use it. `scripts/definitions.ts` takes `--out <name>`.
- **`NETWORK_PRESETS`** (`xrp-dev/client`): `xrpl:mainnet|testnet|devnet` and `xahau:mainnet|testnet` with `networkId`, `rpc`, `ws`, `explorer` and `faucet`. `PUBLIC_RPC_URLS` is built from it.
- **`autofill` options** `networkId` (adds `NetworkID` when above 1024) and `definitions` (asks `fee` for this transaction's `tx_blob` and uses `base_fee`, which includes hook fees). `PasskeyAdapter` takes `networkId` and passes both.

## 0.1.0-alpha.0 (2026-10-16)

First release as `xrp-dev` (one npm package; `wallet`, `passkey`, `mcp` and `x402` are subpaths).

- **Entry points**: `xrp-dev` (crypto, address, codec, client; holds no keys), `xrp-dev/wallet`, `xrp-dev/passkey`, `xrp-dev/mcp` (bin `xrp-dev-mcp`), `xrp-dev/x402` (Hono gate for x402 v2 exact payments; optional `hono` peer).
- **Passkey derivation can be set per app**: `entropyFromPrf` and `Wallet.fromPrf` take `{ salt, info }`, `registerPasskey` and `PasskeyAdapter` take `derivation: { prfInput, salt, info }`. The default stays `xrp-dev/prf/v1`. A test pins another app's frozen vectors (ed25519 and secp256k1) so such an app keeps its addresses. **Breaking** against earlier unpublished builds: `entropyFromPrf(prf, opts)` replaces `entropyFromPrf(prf, salt)`.
- **`algorithm` option** on `PasskeyAdapter` and `registerPasskey` (`"secp256k1"` default, `"ed25519"`).
- **`registerPasskey` leaves no orphan passkey** and now returns `{ credentialId, account }` (it throws instead of returning `prf: false`): refuses a browser that reports no PRF support before creating anything, asks an `enabled`-only authenticator once more with the new credential, and reports a passkey without PRF to the OS (`signalUnknownCredential`).
- **Page-load restore without a prompt**: `PasskeyAdapter.serializeReconnectOptions()` lets xrpl-connect's `WalletManager.reconnect()` restore the account from public data (`address`, `publicKey`, `credentialId`, `algorithm`). Incomplete data or another algorithm fails instead of prompting; every signature still re-derives the key and refuses a different address.
