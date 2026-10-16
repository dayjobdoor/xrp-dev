# xrp-dev

XRPL SDK built on [Effect](https://effect.website) for workerd, Bun, browsers and Node, published as the single npm package [`xrp-dev`](packages/core/README.md).

| Directory | Ships as |
| --- | --- |
| [`packages/core`](packages/core) | `xrp-dev`: crypto, address, codec, client. Holds no keys |
| [`packages/wallet`](packages/wallet) | `xrp-dev/wallet`, `xrp-dev/passkey`: the only key-holding code, plus an xrpl-connect passkey adapter |
| [`packages/mcp`](packages/mcp) | `xrp-dev/mcp`, bin `xrp-dev-mcp`: XRPL tools for MCP servers. Reads and prepares; never signs |
| [`packages/x402`](packages/x402) | `xrp-dev/x402`: Hono gate for x402 v2 exact payments |
| [`skills`](skills) | Agent Skills for code that uses the package |

```sh
bun install
mise run check   # typecheck, tests, pack + consumer check
```

Contributing and release rules: [AGENTS.md](AGENTS.md). Changes: [CHANGELOG.md](CHANGELOG.md). MIT.
