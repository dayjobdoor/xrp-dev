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
import { Effect } from "effect"
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
  const filled = await Effect.runPromise(autofill(client, tx))
  if (!filled.Fee || !filled.Sequence || !filled.LastLedgerSequence) throw new Error("autofill incomplete")
  console.log("AUTOFILL_OK", filled.TransactionType, filled.Fee, filled.Sequence, filled.LastLedgerSequence)
}
```

## 2. Sign, submit, confirm

Signing happens where the key lives. A real wallet comes from the Passkey app (`Wallet.fromPrf`) or from the user's own local code (`Wallet.fromSeed`, seed read from their environment, never from chat). The random wallet below is only for a self-contained example.

Confirmation rules:

- Look up `tx` by hash until `validated: true`, then read `meta.TransactionResult` (`tesSUCCESS` = done; any `tec*` code was applied but failed and still consumed the fee).
- If the transaction is not validated and the validated ledger index is past `LastLedgerSequence`, it can never be included: it expired. Re-autofill and re-sign with a fresh `LastLedgerSequence`.
- Read the ledger index **before** looking up the transaction, so a transaction validated in between is not reported as expired.

```ts
import { Effect } from "effect"
import { Wallet } from "xrp-dev/wallet"
import { autofill, createRpcClient, submit, type RpcClient } from "xrp-dev/client"

const client = createRpcClient({ url: "https://s.altnet.rippletest.net:51234/" })

const confirm = (client: RpcClient, hash: string, lastLedger: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 30; i++) {
      const { ledger_index } = yield* client.request<{ ledger_index: number }>("ledger", { ledger_index: "validated" })
      const found = yield* client
        .request<{ validated?: boolean; meta?: { TransactionResult?: string } }>("tx", { transaction: hash })
        .pipe(Effect.catch(() => Effect.succeed(undefined))) // txnNotFound until it is in a ledger
      if (found?.validated) return found.meta?.TransactionResult ?? "unknown"
      if (ledger_index > lastLedger) return "expired"
      yield* Effect.sleep(1000)
    }
    return "pending"
  })

const program = Effect.gen(function* () {
  const wallet = yield* Wallet.fromEntropy(crypto.getRandomValues(new Uint8Array(16)))
  const tx = yield* autofill(client, {
    TransactionType: "Payment",
    Account: wallet.address,
    Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
    Amount: "1000000",
  })
  const { tx_blob, hash } = yield* wallet.sign(tx)
  const sent = yield* submit(client, tx_blob)
  console.log("SUBMITTED", sent.engine_result)
  const result = yield* confirm(client, hash, Number(tx.LastLedgerSequence))
  console.log("CONFIRMED", result)
})

await Effect.runPromise(program)
```
