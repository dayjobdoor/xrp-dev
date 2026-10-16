# Changelog

## 0.1.0-alpha.0 (2026-10-16)

First release as `xrp-dev` (one npm package; `wallet`, `passkey`, `mcp` and `x402` are subpaths).

- **Entry points**: `xrp-dev` (crypto, address, codec, client; holds no keys), `xrp-dev/wallet`, `xrp-dev/passkey`, `xrp-dev/mcp` (bin `xrp-dev-mcp`), `xrp-dev/x402` (Hono gate for x402 v2 exact payments; optional `hono` peer).
- **Passkey derivation can be set per app**: `entropyFromPrf` and `Wallet.fromPrf` take `{ salt, info }`, `registerPasskey` and `PasskeyAdapter` take `derivation: { prfInput, salt, info }`. The default stays `xrp-dev/prf/v1`. A test pins another app's frozen vectors (ed25519 and secp256k1) so such an app keeps its addresses. **Breaking** against earlier unpublished builds: `entropyFromPrf(prf, opts)` replaces `entropyFromPrf(prf, salt)`.
- **`algorithm` option** on `PasskeyAdapter` and `registerPasskey` (`"secp256k1"` default, `"ed25519"`).
- **`registerPasskey` leaves no orphan passkey** and now returns `{ credentialId, account }` (it throws instead of returning `prf: false`): refuses a browser that reports no PRF support before creating anything, asks an `enabled`-only authenticator once more with the new credential, and reports a passkey without PRF to the OS (`signalUnknownCredential`).
- **Page-load restore without a prompt**: `PasskeyAdapter.serializeReconnectOptions()` lets xrpl-connect's `WalletManager.reconnect()` restore the account from public data (`address`, `publicKey`, `credentialId`, `algorithm`). Incomplete data or another algorithm fails instead of prompting; every signature still re-derives the key and refuses a different address.
