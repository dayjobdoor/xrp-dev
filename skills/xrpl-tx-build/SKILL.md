---
name: xrpl-tx-build
description: Build, autofill, sign, submit and confirm XRPL transactions (Payment, TrustSet, OfferCreate) with xrp-dev and xrp-dev/wallet. Use when the user wants to send XRP or issued currency, set a trust line, or place a DEX offer, or asks why a submitted transaction did not validate.
---

# Build and send an XRPL transaction

Flow: **build JSON → autofill → sign (user's side) → submit → confirm validated**.

## Rules

- Never ask for, accept, or paste a seed, secret numbers or private key in the AI chat. Sign in the user's wallet, or in code the user runs locally. The agent only ever sees public data and signed blobs.
- A submit step (the app's `/mcp` `submit` tool, or your own code) takes a **signed `tx_blob` only**. `xrp-dev/mcp` has no `submit`; its `prepare_*` tools return an unsigned `tx_json`. Nothing here signs or takes keys.
- Amounts: XRP is a string of drops (`"1000000"` = 1 XRP). Issued currency is `{ currency, issuer, value }` with `value` a decimal string.
- `submit` returning `tesSUCCESS` only means "applied to the open ledger". It is final only after `tx` reports `validated: true`.

Snippets below create the client with one line, `const client = createRpcClient({ url: ... })`. Keep that line as written (testnet URL); the test suite replaces it with a fake.

## 1. Build and autofill

`autofill` fills only the missing `Fee`, `Sequence` and `LastLedgerSequence` (current ledger + 20).

```ts
import { autofill, createRpcClient } from "xrp-dev/client"
import type { TxJson } from "xrp-dev/codec"

const client = createRpcClient({ url: "https://s.altnet.rippletest.net:51234/" })

const account = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"
const issuer = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"

const payment: TxJson = {
  TransactionType: "Payment",
  Account: account,
  Destination: issuer,
  Amount: "1000000", // 1 XRP in drops
}
const trustSet: TxJson = {
  TransactionType: "TrustSet",
  Account: account,
  LimitAmount: { currency: "USD", issuer, value: "100" },
}
const offerCreate: TxJson = {
  TransactionType: "OfferCreate",
  Account: account,
  TakerGets: "5000000", // selling 5 XRP
  TakerPays: { currency: "USD", issuer, value: "10" }, // for 10 USD
}

for (const tx of [payment, trustSet, offerCreate]) {
  const filled = await autofill(client, tx)
  if (!filled.Fee || !filled.Sequence || !filled.LastLedgerSequence) throw new Error("autofill incomplete")
  console.log("AUTOFILL_OK", filled.TransactionType, filled.Fee, filled.Sequence, filled.LastLedgerSequence)
}
```

## 2. Sign, submit, confirm

Signing happens where the key lives. A real wallet comes from the Passkey app (`await Wallet.fromPrf`) or from the user's own local code (`Wallet.fromSeed`, seed read from their environment, never from chat). The random wallet below is only for a self-contained example.

`submitAndWait` submits and then does the confirming for you:

- It looks `tx` up by hash until `validated: true`, then reads `meta.TransactionResult` into `transaction_result` (`tesSUCCESS` = done; any `tec*` code was applied but failed and still consumed the fee, so it resolves: check the field).
- It rejects with `ClientError`: `rejected` (`tem`, `tef`, `tel`: the node refuses it for good), `expired` (the validated ledger is past `LastLedgerSequence` and the transaction is not in it: re-autofill and re-sign with a fresh `LastLedgerSequence`), `timeout` or `aborted`.
- The ledger index is read **before** the lookup, so a transaction validated in between is not reported as expired.

```ts
import { autofill, createRpcClient, submitAndWait } from "xrp-dev/client"
import { Wallet } from "xrp-dev/wallet"

const client = createRpcClient({ url: "https://s.altnet.rippletest.net:51234/" })

const wallet = Wallet.fromEntropy(crypto.getRandomValues(new Uint8Array(16)))
const tx = await autofill(client, {
  TransactionType: "Payment",
  Account: wallet.address,
  Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  Amount: "1000000",
})
const { tx_blob } = wallet.sign(tx)
const result = await submitAndWait(client, tx_blob)
console.log("SUBMITTED", result.engine_result)
console.log("CONFIRMED", result.transaction_result)
```
