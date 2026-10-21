# xrp-dev/wallet

The only key-holding package of [xrp-dev](https://github.com/dayjobdoor/xrp-dev/tree/main/packages): derive XRPL wallets from entropy, seeds, Secret Numbers or a passkey, sign transactions (refusing the ones that hand the account to another key), and an [xrpl-connect](https://www.npmjs.com/package/xrpl-connect) passkey adapter. Built on [`xrp-dev`](https://www.npmjs.com/package/xrp-dev) and Effect; runs on workerd, Bun, browsers and Node.

> **Not independently audited as a whole:** the curves and RIPEMD-160 come from [`@noble/curves`](https://github.com/paulmillr/noble-curves) / [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) through `xrp-dev` (audited, per the noble README: Trail of Bits 2023 and Aug 2026, Cure53 2024, Kudelski 2023; algorithmic constant time, which JavaScript cannot fully guarantee). The key derivation, seed and Secret Numbers code, transaction checks, passkey adapter and glue are this repository's and have had no third-party audit. Sign on the key owner's own device rather than in a service that signs for remote callers.

## Install

```sh
bun add xrp-dev effect   # or: npm i xrp-dev effect
```

Published as a subpath of `xrp-dev`, not its own package. Peer dependency `effect` `^4.0.2` is required. For `xrp-dev/passkey` only, `xrpl-connect` `^1.0.0` and `xrpl` `^4 || ^5` are optional and used for types only (never loaded at runtime). ESM-only.

## Wallet

Every function returns an Effect that fails with a [`WalletError`](#walleterror-reasons).

```ts
import { Effect } from "effect";
import { Wallet } from "xrp-dev/wallet";

const program = Effect.gen(function* () {
  const wallet = yield* Wallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb");
  const { tx_blob, hash } = yield* wallet.sign({
    TransactionType: "Payment",
    Account: wallet.address,
    Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
    Amount: "1000000",
    Fee: "12",
    Sequence: 7,
    LastLedgerSequence: 1000,
  });
  wallet.destroy();
  return { tx_blob, hash };
});
```

| Constructor | Input | Notes |
| --- | --- | --- |
| `Wallet.fromEntropy(entropy, { algorithm? })` | 16 bytes | `algorithm`: `"secp256k1"` (default, like xrpl.js and Xaman) or `"ed25519"`. Your buffer is not zeroed; it is yours. |
| `Wallet.fromSeed(seed)` | `s…` seed string | Algorithm comes from the seed. |
| `Wallet.fromSecretNumbers(input, { algorithm? })` | 8 groups of 6 digits (string or array) | XLS-12 Secret Numbers. |
| `Wallet.fromPrf(prf, { salt?, info?, algorithm? })` | 32+ byte WebAuthn PRF output | HKDF-SHA256, salt and info default to `xrp-dev/prf/v1`, to 16 bytes of entropy. |

A wallet exposes `address`, `publicKey` and `algorithm`. Its `toJSON`, `toString` and `util.inspect` show the address and public key only.

- `sign(tx, { multisign? })` returns `{ tx_blob, hash }`. With `multisign: true` it adds this wallet's entry to `Signers` (the transaction's `Account` is another account); a transaction that already has `Signers` is rejected. The single-sign path rejects a transaction whose `Account` is not this wallet's address (`bad_tx`). It does not autofill: set `Fee`, `Sequence` and `LastLedgerSequence` (use `autofill` from `xrp-dev/client`). `Flags` must be a number.
- `signMessage(bytes)` returns the hex signature, byte-compatible with ripple-keypairs' `sign`. It refuses bytes that start with an XRPL hash prefix (`STX\0`, `SMT\0`, …; three upper-case letters and a zero byte): a signature over those is a valid transaction. Refusal is `bad_message`.
- `destroy()` zeroes the key bytes the wallet owns (a `Uint8Array`; BigInt copies made inside the curve code cannot be erased); every later sign fails with `destroyed`. A sign already in flight finishes with its own copy of the key.

### Helpers

- `entropyFromPrf(prf, { salt?, info? }?)`: the PRF → 16-byte entropy step of `fromPrf`, e.g. to show the Secret Numbers backup of a passkey account.
- `entropyToSeed(entropy, algorithm?)`: the classic `s…` backup string.
- `toSecretNumbers(entropy)`: the 8 six-digit groups for 16 bytes of entropy.

### Refusals

`signingRefusal(tx)` returns a message (Japanese, as the app shows it) or `undefined`. It refuses:

- `SetRegularKey`, `SignerListSet`, `DelegateSet`: they hand control of the account to another key. `SetHook` (Xahau): it installs code that can block or emit transactions for the account. `Import` (Xahau): refused when the XPOP's inner XRPL transaction is `SetRegularKey`, `SignerListSet` or `AccountSet` (Xahau carries the keying and flags over to the account) or when the XPOP cannot be read; any other inner transaction stays signable.
- `AccountSet` with `SetFlag: 4` (`asfDisableMaster`).
- `Batch`: the inner transactions cannot be reviewed individually.
- Any transaction whose `TransactionType` is not a string (fail closed).

`Wallet.sign` applies this to what it actually signs: it encodes one snapshot of your object, decodes the blob and checks the decoded JSON, so numeric type codes (`5`, `12`, `71`, …) and getters that change between reads cannot slip through. A refusal is `WalletError` reason `refused`. `PasskeyAdapter` applies the same refusals before it prompts. They hold for every signer in this package and are not configurable.

## Passkey adapter

`xrp-dev/passkey` is a `WalletAdapter` for xrpl-connect. The key is derived on the device from the passkey's WebAuthn PRF output (secp256k1 by default, `algorithm: "ed25519"` optional) and never leaves the browser.

```ts
import { PasskeyAdapter, registerPasskey } from "xrp-dev/passkey";
import { createRpcClient, PUBLIC_RPC_URLS } from "xrp-dev/client";
import { WalletManager } from "xrpl-connect";

const { credentialId, account } = await registerPasskey({
  rp: { name: "My app" },
  user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "me", displayName: "Me" },
});
// `account.secretNumbers` is the only backup besides the passkey itself: show it once.

const adapter = new PasskeyAdapter({
  network: { id: "testnet", name: "Testnet", wss: "wss://s.altnet.rippletest.net:51233" },
  client: createRpcClient({ url: PUBLIC_RPC_URLS.testnet }),
  credentialId,
});

const walletManager = new WalletManager({ adapters: [adapter], network: "testnet" });
const { address } = await walletManager.connect("xrp-dev-passkey");
```

- `registerPasskey({ rp, user, credentials?, algorithm?, derivation? })` creates a resident, user-verified passkey with PRF enabled and returns `{ credentialId, account: { address, secretNumbers } }`. It leaves no unusable passkey behind: a browser that reports no PRF support (`getClientCapabilities`) is refused before anything is created; an authenticator that only reports `enabled` is asked once more with the new credential; when no PRF result arrives the credential is reported to the OS with `signalUnknownCredential` (best effort) and the call throws a `PasskeyError`.
- `PasskeyAdapter` options: `network` and `client` (required), `rpId`, `credentialId` (limits `connect` to one passkey), `credentials` (defaults to `navigator.credentials`; for tests), `algorithm` (`"secp256k1"` default or `"ed25519"`; must match how the account was created), `derivation` (see below).
- `connect()` asks for the passkey once to learn the address and public key, remembers which credential was used, and keeps no secret. A `network` other than the configured one is refused before any prompt.
- `sign`, `signAndSubmit` and `signMessage` each run a fresh user-verified ceremony for that credential, derive the key, check that it is the connected account (another passkey is a `PasskeyError`; nothing is signed), sign, and wipe the key. A dismissed prompt is a `PasskeyError`. `sign` snapshots the transaction once, refuses dangerous types and a foreign `Account` before prompting, fills a missing `Account` with the connected address, and autofills `Fee`, `Sequence` and `LastLedgerSequence` through `client`.
- `signAndSubmit` submits through `client`. If submit times out, the connection closes or the node answers `tem`/`tef`/`tel`, it throws a `PasskeyError` whose `hash` and `tx_blob` are the signed transaction. After a timeout the transaction may still be applied: look `hash` up with the `tx` method before signing again, or the next `Sequence` pays twice.
- Page-load restore: `WalletManager` stores `serializeReconnectOptions()` (public data only: `address`, `publicKey`, `credentialId`, `algorithm`) and `reconnect()` hands it back to `connect()`, which then restores the account **without a prompt**. Missing fields, or an `algorithm` other than the adapter's, make it fail (the manager then returns `null`) instead of prompting. The restored address is only what was stored: every signature still derives the key and refuses when it is not that address, so a tampered store cannot produce a signature for a wrong account.
- `disconnect()` forgets the account; `getAccount()` returns it (`null` when disconnected).

### Runtime

Browsers need a secure context (HTTPS or localhost) and an authenticator with the PRF extension; `isAvailable()` says false without WebAuthn. `PUBLIC_RPC_URLS.mainnet` and `.testnet` in `xrp-dev` are CORS-enabled (`xrplcluster.com`, `testnet.xrpl-labs.com`), so a browser can call them directly. Devnet's public JSON-RPC has no CORS: in a browser use `createWsClient` or a same-origin proxy.

## WalletError reasons

`bad_seed`, `bad_entropy` (not 16 bytes), `bad_secret_numbers` (not 8 groups of 6 digits), `bad_checksum` (with a 1-based `position`), `bad_prf` (under 32 bytes), `bad_message` (hash prefix), `bad_tx` (`Signers` already present, or a foreign `Account`), `refused` (a refusal above), `destroyed`, and `bad_key` (the curve code rejected a key; no valid input reaches it).

## Security notes

- Passkey signing prompts for every signature. A page that holds a connected adapter cannot spend without a user-verified ceremony each time.
- Zeroing is best-effort. Key, entropy and PRF byte arrays are wiped as soon as they are used, also on failures, but JavaScript BigInts and strings (seeds, Secret Numbers, intermediate curve values) cannot be erased and a garbage collector may have copied buffers. Treat the page's JavaScript context as the trust boundary.
- Never send seeds or private keys to a server.

### Reproducing another app's derivation

The default derivation (PRF input, HKDF salt and info all `xrp-dev/prf/v1`) is fixed for this package's versions. An app that already derives its accounts differently passes the same inputs and gets the same addresses: `derivation: { prfInput, salt, info }` on `registerPasskey` and `PasskeyAdapter`, `{ salt, info }` on `Wallet.fromPrf` and `entropyFromPrf`. `wallet.test.ts` pins one such scheme (salt = SHA-256 of the RP ID, info per algorithm) against its own frozen vectors. Changing any input changes every address derived from the passkey.

Repository and issues: <https://github.com/dayjobdoor/xrp-dev>. MIT.
