# xrp-dev

XRPL SDK built on [Effect](https://effect.website): hashing, secp256k1 / ed25519, classic and X-addresses, the binary codec and a JSON-RPC / WebSocket client. The main entry holds no wallet and no key storage. Wallets are `xrp-dev/wallet`; the MCP server is `xrp-dev/mcp` (bin `xrp-dev-mcp`). It runs unchanged on Cloudflare Workers (workerd), Bun, browsers and Node.

> **Not independently audited as a whole:** secp256k1, ed25519 and RIPEMD-160 are [`@noble/curves`](https://github.com/paulmillr/noble-curves) and [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) (audited: Trail of Bits 2023 and Aug 2026, Cure53 2024, Kudelski 2023, per the noble README). SHA-256 and SHA-512 are WebCrypto's. The binary codec, address and seed code, JSON-RPC client and the glue between them are this repository's and have had no third-party audit.

## Security

noble targets algorithmic constant time. Its README: "_JIT-compiler_ and _Garbage Collector_ make 'constant time' extremely hard to achieve [timing attack] resistance in a scripting language", so no JavaScript library can promise constant-timeness, and "if your goal is absolute security, don't use any JS lib". Within those limits its secret-scalar multiplication uses a fixed operation sequence, data-oblivious table scans and scalar blinding; ed25519 signing only multiplies the blinded base point. Judge for yourself before signing for remote callers in a shared-host service. Signing on the key owner's own device is the safer default. Verification and hashing take only public inputs and are fine anywhere. JavaScript cannot erase BigInts, which noble uses for scalars; zeroing a `Uint8Array` does not remove those copies.

noble requires Node >= 20.19 and is ESM-only.

## Runtime

- Browsers need a secure context (HTTPS or localhost) for WebCrypto (`crypto.subtle`).
- `AbortSignal.any` needs Node >= 20.3 (the package as a whole needs >= 20.19, noble's floor), Chrome 116, Safari 17.4 or Firefox 124.
- CORS: `PUBLIC_RPC_URLS.mainnet` and `.testnet` answer the preflight, so a browser can call them. devnet has no CORS-enabled public JSON-RPC: use `createWsClient` (WebSocket is not subject to CORS) or a same-origin proxy.

## Install

```sh
bun add xrp-dev effect   # or: npm i xrp-dev effect
```

`effect` (`^4.0.2`) is a peer dependency: you handle its values and errors, so there must be exactly one copy.

## Entry points

| Import | What |
| --- | --- |
| `xrp-dev` | crypto, address, codec and client. No keys |
| `xrp-dev/crypto` | sha256 / sha512Half / ripemd160, base58, secp256k1, ed25519 |
| `xrp-dev/address` | classic addresses, X-addresses, seeds |
| `xrp-dev/codec` | `encode`, `decode`, signing blobs, `hashTransaction`, `verifyTransaction`; each takes optional `defs` (codec tables) last |
| `xrp-dev/client` | `createRpcClient`, `createWsClient`, `autofill`, `submit`, `NETWORK_PRESETS` |
| `xrp-dev/xahau` | `XAHAU_DEFINITIONS`: codec tables for Xahau, pass as `defs` |
| `xrp-dev/auth` | wallet sign-in: `createChallenge`, `verifyLogin` (server), `login(adapter, { app })` (browser) |
| `xrp-dev/wallet` | keys and signing. Not loaded by the entries above |
| `xrp-dev/passkey` | xrpl-connect passkey adapter. Needs the optional `xrpl` and `xrpl-connect` peers, types only |
| `xrp-dev/mcp` | tool registry and JSON-RPC handler. Bin: `xrp-dev-mcp` |
| `xrp-dev/x402` | Hono gate for x402 v2 exact payments on XRPL (`requirePayment`). Needs the optional `hono` peer |

The first five entries re-export their own error class (`CryptoError`, `AddressError`, `CodecError`, `ClientError`), so importing one is enough to catch and narrow its errors. `xrp-dev/wallet` fails with `WalletError`.

```ts
import { Effect } from "effect";
import { isValidClassicAddress } from "xrp-dev/address";
import { encode, hashTransaction } from "xrp-dev/codec";
import { createRpcClient, PUBLIC_RPC_URLS } from "xrp-dev/client";

const tx = { TransactionType: "Payment", Account: "rrrrrrrrrrrrrrrrrrrrrhoLvTp", Destination: "rrrrrrrrrrrrrrrrrrrrBZbvji", Amount: "1", Fee: "10", Sequence: 1, SigningPubKey: "" };

const program = Effect.gen(function* () {
  const ok = yield* isValidClassicAddress(tx.Account);
  const blob = yield* encode(tx);
  const hash = yield* hashTransaction(blob);
  return { ok, hash };
});

console.log(await Effect.runPromise(program));
const client = createRpcClient({ url: PUBLIC_RPC_URLS.testnet });
```

Repository and issues: <https://github.com/dayjobdoor/xrp-dev>. MIT.
