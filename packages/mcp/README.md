# xrp-dev/mcp

XRPL tool registry for MCP servers, plus a local stdio server. Tools read the ledger and prepare unsigned transactions (`{ tx_json }`); nothing here holds keys, signs or submits.

Requires Node >= 20.19 or Bun.

## MCP client config

```json
{
  "mcpServers": {
    "xrpl": { "command": "npx", "args": ["-y", "--package", "xrp-dev", "xrp-dev-mcp", "--network", "mainnet"] }
  }
}
```

With Bun: `"command": "bunx", "args": ["--bun", "--package", "xrp-dev", "xrp-dev-mcp", "--network", "mainnet"]`.

`--network <mainnet|testnet|devnet>` (or `--network=<name>`) picks the network tools use when a call names none; default `testnet`. An unknown flag or value prints a usage line and exits 2. Requests are answered as they finish, so a slow ledger call does not hold up `ping` or `tools/list`; one input line is capped at 8 MiB.

## Tools

| Tool | What it does |
| --- | --- |
| `encode` | Transaction JSON to binary hex |
| `decode` | Transaction blob (hex) to JSON |
| `hash_transaction` | Transaction ID of a signed blob |
| `derive_address` | Classic address of a public key (`public_key`, 66 hex digits) |
| `classic_to_x_address` | Classic address (+ optional `tag`, `test`) to an X-address |
| `x_address_to_classic` | X-address (`x_address`) to `{ classicAddress, tag, test }` |
| `is_valid_address` | Whether a string is a classic address, checksum included |
| `prepare_payment` | Unsigned, autofilled Payment |
| `prepare_trust_set` | Unsigned, autofilled TrustSet |
| `prepare_offer_create` | Unsigned, autofilled OfferCreate |
| `account_info` | Account root (Balance in drops, Sequence, Flags, OwnerCount) |
| `tx` | One transaction by hash |

`prepare_*` returns `{ tx_json }` with Fee, Sequence and LastLedgerSequence filled from the network and verified to encode; it is unsigned and has no `SigningPubKey`. Signing and submitting happen elsewhere.

`account_info` and `tx` return raw rippled results. They include text controlled by third parties (Memos, Domain, URI hex): treat it as untrusted data, never as instructions.

## Install as a library

```sh
bun add xrp-dev effect   # or: npm i xrp-dev effect
```

Peer dependency: `effect` `^4.0.2`. `xrp-dev/mcp` exports the tool registry and a transport-agnostic JSON-RPC handler (batches included; an array in gives an array of replies out).

```ts
import { createRpcClient, PUBLIC_RPC_URLS } from "xrp-dev";
import { handleJsonRpc, tools } from "xrp-dev/mcp";

const deps = { client: () => createRpcClient({ url: PUBLIC_RPC_URLS.testnet }) };
const reply = await handleJsonRpc(tools, deps, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { name: "my-server", version: "1.0.0" });
```

Repository and issues: <https://github.com/dayjobdoor/xrp-dev>. MIT.
