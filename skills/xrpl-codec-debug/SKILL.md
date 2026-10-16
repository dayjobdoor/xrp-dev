---
name: xrpl-codec-debug
description: Decode and debug XRPL binary transactions (tx_blob) with xrp-dev/codec. Use when the user has a hex blob or hash to inspect, a signature or hash does not match, or needs to understand field order, amount encoding, currency codes, length prefixes or signing/hash prefixes.
---

# Debug an XRPL binary blob

## Decode a `tx_blob`

`decode(hex)` returns the JSON form; `encode(json)` is its inverse. If `encode(decode(blob)) !== blob`, the blob is not canonical.

```ts
import { Effect } from "effect"
import { decode, encode } from "xrp-dev/codec"

const tx = {
  TransactionType: "Payment",
  Account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
  Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  Amount: "1000000",
  Fee: "10",
  Sequence: 1,
  SigningPubKey: "",
}
const blob = await Effect.runPromise(encode(tx))
const back = await Effect.runPromise(decode(blob))
if (back.TransactionType !== "Payment" || back.Amount !== "1000000") throw new Error("roundtrip failed")
console.log("DECODE_OK", blob.slice(0, 12))
```

## Field order

Fields are sorted by (type code, field code), ascending, not by name. Each field starts with a field ID:

- both codes < 16: one byte, `type << 4 | field`;
- type ≥ 16: first nibble 0, then a type byte; field ≥ 16: low nibble 0, then a field byte; both: `00 type field`.

`TransactionType` is type 1 (UInt16), field 2 → `12`. `Flags` is type 2 (UInt32), field 2 → `22`. `Sequence` is `24`, `Amount` (type 6, field 1) is `61`, `Fee` is `68`, `SigningPubKey` (type 7, field 3) is `73`, `TxnSignature` is `74`, `Account` (type 8, field 1) is `81`, `Destination` is `83`. So a Payment blob starts `12 0000 22 ...`: the fields appear in exactly this order whatever the order of keys in the JSON.

```ts
import { Effect } from "effect"
import { encode } from "xrp-dev/codec"

const blob = await Effect.runPromise(
  encode({
    TransactionType: "Payment",
    Flags: 0,
    Sequence: 1,
    Amount: "1000000",
    Fee: "10",
    SigningPubKey: "",
    Account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
    Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  }),
)
// Input order is irrelevant: the blob is sorted by field ID.
const expected = "120000" + "2200000000" + "2400000001" + "6140000000000F4240" + "68400000000000000A" + "7300" + "8114"
if (!blob.startsWith(expected)) throw new Error("unexpected header: " + blob.slice(0, 60))
console.log("ORDER_OK", blob.slice(0, 12))
```

## Amounts

- **XRP** is 64 bits: top bit 0 (not an issued amount), next bit 1 (positive), then 62 bits of drops. `"1000000"` → `40000000000F4240`.
- **Issued currency** is 384 bits: 64-bit value, 160-bit currency, 160-bit issuer AccountID. The value's top bit is 1, next bit is the sign (1 = positive), then 8 bits exponent (biased by 97) and 54 bits mantissa (normalised to 10^15 … 10^16-1). `"1"` USD → `D4838D7EA4C68000`.
- Zero issued value is `8000000000000000`.

## Currency codes

20 bytes. A standard 3-character code (`USD`) is ASCII at bytes 12–14 with all other bytes zero: `0000000000000000000000005553440000000000`. Anything else is 40 hex characters, taken as is (a `00` prefix is accepted, and a code that is the standard form in hex decodes back as `USD`). The all-zero code is `XRP` and is rejected as an issued currency.

```ts
import { Effect } from "effect"
import { encode } from "xrp-dev/codec"

const issuer = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"
const encodeAmount = (Amount: unknown) =>
  Effect.runPromise(encode({ TransactionType: "Payment", Account: issuer, Destination: issuer, Amount }))

const drops = await encodeAmount("1000000")
const iou = await encodeAmount({ currency: "USD", issuer, value: "1" })
if (!drops.includes("6140000000000F4240")) throw new Error("XRP amount encoding")
if (!iou.includes("61D4838D7EA4C68000" + "0000000000000000000000005553440000000000")) throw new Error("IOU amount encoding")
console.log("AMOUNT_OK", "XRP 40000000000F4240", "IOU D4838D7EA4C68000")
```

## Length prefixes (VL)

Variable-length fields (Blob, AccountID, Vector256) are prefixed by a length: 0–192 → one byte; 193–12480 → two bytes (`n = len - 193`; `b1 = 193 + (n >> 8)`, `b2 = n & 255`); 12481–918744 → three bytes. A `SigningPubKey` of 33 bytes starts `7321`; `Account` is always `8114` (20 bytes) followed by the AccountID.

## Prefixes

| Purpose | Prefix (hex) | Bytes hashed/signed |
| --- | --- | --- |
| Single signing (`encodeForSigning`) | `53545800` ("STX\0") | prefix + signing fields |
| Multisigning (`encodeForMultisigning`) | `534D5400` ("SMT\0") | prefix + signing fields (empty `SigningPubKey`) + signer's AccountID |
| Transaction ID (`hashTransaction`) | `54584E00` ("TXN\0") | `sha512Half(prefix + signed blob)` |

Signing fields exclude `TxnSignature` and `Signers`. A signature check failing usually means the signed bytes differ from these (wrong prefix, `SigningPubKey` changed after signing, or multisign without the signer's AccountID).

```ts
import { Effect } from "effect"
import { bytesToHex, hexToBytes, sha512Half } from "xrp-dev/crypto"
import { encode, encodeForMultisigning, encodeForSigning, hashTransaction } from "xrp-dev/codec"

const account = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"
const tx = {
  TransactionType: "Payment",
  Account: account,
  Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  Amount: "1000000",
  Fee: "10",
  Sequence: 1,
  SigningPubKey: "02" + "11".repeat(32),
}
const program = Effect.gen(function* () {
  const signing = bytesToHex(yield* encodeForSigning(tx))
  const multi = bytesToHex(yield* encodeForMultisigning(tx, account))
  const blob = yield* encode(tx)
  const id = yield* hashTransaction(blob)
  const manual = bytesToHex(yield* sha512Half(yield* hexToBytes("54584E00" + blob)))
  if (!signing.startsWith("53545800")) throw new Error("STX prefix")
  if (!multi.startsWith("534D5400")) throw new Error("SMT prefix")
  if (!blob.includes("732102" + "11".repeat(32))) throw new Error("VL prefix 0x21 for 33-byte key")
  if (id !== manual) throw new Error("hash prefix 54584E00")
  console.log("PREFIX_OK", signing.slice(0, 8), multi.slice(0, 8), id.slice(0, 8))
})
await Effect.runPromise(program)
```
