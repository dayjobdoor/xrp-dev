# xrp-dev

XRPL SDK for workerd, Bun, browsers and Node, published as one npm package, `xrp-dev`. `packages/core` is the published package; `packages/wallet`, `packages/mcp` and `packages/x402` are private sources that `packages/core/scripts/assemble.ts` copies into core's `dist/` (`xrp-dev/wallet`, `xrp-dev/passkey`, `xrp-dev/mcp`, `xrp-dev/x402`). Design: [docs/design-document.html](docs/design-document.html). License: MIT.

## Boundary

- Only `packages/wallet` holds keys; `xrp-dev`'s main entry keeps just the raw primitives the wallet builds on (`crypto`'s `sign` / `getPublicKey` / `addScalars` / `isValidPrivateKey`, the seed codecs in `address`). No API accepts or returns seeds or private keys outside the wallet; the MCP server reads and prepares, never signs or submits.
- A package imports only its dependencies, never another package's `src/`. Consumers (the apps that use `xrp-dev`) are not referenced from here.
- Secrets never go into the repo; releases are keyless (below).

## Conventions

- Effect 4: I/O returns `Effect`, errors are tagged classes with a `reason`. Tests: `vp test` per package (vite-plus) and `bun test` over core, wallet and `test/` (skill snippets). Differential tests (ripple-binary-codec, xrpl.js, Wycheproof, RFC 8032) guard the codec and key code; keep them.
- Key derivation constants (`packages/wallet/src/prf.ts`) are frozen per version: changing one changes every address derived from a passkey. Apps with their own scheme pass `derivation`; a new scheme needs a pinned vector from an independent oracle.
- `signingRefusal` messages of `xrp-dev/wallet` stay Japanese: they are behavior, covered by tests.
- Tests check behavior; no tests of types, wiring or mirrors of the implementation.
- A change updates `CHANGELOG.md` under the next version heading in the same commit.
- Not independently audited as a whole: the READMEs keep their warning until a third party has reviewed the codec, address, wallet and MCP code.

## Verify

`mise run check` (= `bun run typecheck && bun run test && bun run test:bun && bun run check`). `bun run check` packs the tarball, runs publint and attw, installs it into a throwaway project, imports every subpath, signs and verifies a Payment and answers MCP requests from Node and Bun.

`bun run build` builds core, wallet, mcp and x402 and assembles them (also what `prepare` runs). `bun.lock` and the hoisted linker (`bunfig.toml`) are required: `check-packages.ts` reads peers from the root `node_modules`.

## Release

Keyless (npm trusted publishing over OIDC, `.github/workflows/publish.yml`). Bump `version` in the four `packages/*/package.json` (the bin inlines mcp's version, wallet depends on core's), add `## <version> (date)` to `CHANGELOG.md` (a heading still saying `unreleased` fails `plan`), push to `main`. `plan` publishes only when npm lacks that exact version; `verify` packs and checks the tarball and uploads it; the `npm-publish` environment's reviewers gate the publish job, which publishes that exact tarball (no rebuild), tags `v<version>` and creates a GitHub Release from the CHANGELOG section; a prerelease id picks the dist-tag (`alpha`, `beta`, else `next`). A ruleset on `main` blocks force-push and deletion and requires the `check` CI job (admin bypass: direct pushes still work); `v*` tags are immutable. Agents never run `npm publish`.

First publish only, by hand with a `dayjobdoor`-owned npm account (the first publisher becomes the maintainer): `npm whoami`, `mise run dryrun`, then `cd packages/core && npm publish --access public --tag alpha`, then `npm trust github` for repo `dayjobdoor/xrp-dev` and workflow `publish.yml` (npm >= 11.15).
