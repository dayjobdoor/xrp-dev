# xrp-dev

XRPL SDK for workerd, Bun, browsers and Node, published as one npm package, `xrp-dev`. `packages/core` is the published package; `packages/wallet`, `packages/mcp` and `packages/x402` are private sources that `packages/core/scripts/assemble.ts` copies into core's `dist/` (`xrp-dev/wallet`, `xrp-dev/passkey`, `xrp-dev/mcp`, `xrp-dev/x402`). Design: [docs/design-document.html](docs/design-document.html). License: MIT.

## Boundary

- Only `packages/wallet` holds keys; `xrp-dev`'s main entry keeps just the raw primitives the wallet builds on (`crypto`'s `sign` / `getPublicKey` / `addScalars` / `isValidPrivateKey`, the seed codecs in `address`). No API accepts or returns seeds or private keys outside the wallet; the MCP server reads and prepares, never signs or submits.
- A package imports only its dependencies, never another package's `src/`. Consumers (the apps that use `xrp-dev`) are not referenced from here; the one exception is the planning note `docs/shared-account-plan.md`, and `wallet.test.ts` names two apps only as the pinned inputs of their frozen derivations.
- Secrets never go into the repo; releases are keyless (below).

## Conventions

- Layering (plain core, Effect adapters, the client, the wallet, dist): `docs/layering.md`. Read it before touching `src/effect/*`, `packages/wallet/src/effect.ts` or the return type of a public entry.
- Key derivation constants (`packages/wallet/src/prf.ts`) are frozen per version: changing one changes every address derived from a passkey. Apps with their own scheme pass `derivation`; a new scheme needs a pinned vector from an independent oracle.
- `signingRefusal` messages of `xrp-dev/wallet` stay Japanese: they are behavior, covered by tests.
- Tests check behavior; no tests of types, wiring or mirrors of the implementation.
- Review judgement rules (types, comments, tests): `CODING_STANDARDS.md`.
- A change updates `CHANGELOG.md` under the next version heading in the same commit (the pre-commit hook checks it; `SKIP_CHANGELOG=1` when no user could notice).
- Not independently audited as a whole: the READMEs keep their warning until a third party has reviewed the codec, address, wallet and MCP code.

## Verify

`mise run check` is the gate (its tasks are in `mise.toml`; the `check` job of `ci.yml` and the `verify` job of `publish.yml` run the same commands; `ci.yml` also has a `changelog` job and a run of the packed tarball on Node 20.19, and is manual-only while GitHub billing blocks runs). It also packs the tarball, runs publint and attw, installs it into a throwaway project and runs the consumer probe (`scripts/check-packages.ts`).

`bun run build` builds core, wallet, mcp and x402 and assembles them (also what `prepare` runs). `bun.lock` and the hoisted linker (`bunfig.toml`) are required: `check-packages.ts` reads the peers' and `effect`'s locked versions (an `effect` override pins the consumer) from the root `node_modules`.

## Release

Keyless (npm trusted publishing over OIDC, `.github/workflows/publish.yml`). Bump `version` in the four `packages/*/package.json` (the bin inlines mcp's version, wallet depends on core's), add `## <version> (date)` to `CHANGELOG.md` (a heading still saying `unreleased` fails `plan`), push to `main`. `plan` publishes only when npm lacks that exact version; `verify` packs and checks the tarball and uploads it; the `npm-publish` environment's reviewers gate the publish job, which publishes that exact tarball (no rebuild), tags `v<version>` and creates a GitHub Release from the CHANGELOG section; a prerelease id picks the dist-tag (`alpha`, `beta`, else `next`). A ruleset on `main` blocks force-push and deletion and requires the `check` CI job (admin bypass: direct pushes still work); `v*` tags are immutable. Agents never run `npm publish`.

First publish only, by hand with a `dayjobdoor`-owned npm account (the first publisher becomes the maintainer): `npm whoami`, `mise run dryrun`, then `cd packages/core && npm publish --access public --tag alpha`, then `npm trust github` for repo `dayjobdoor/xrp-dev` and workflow `publish.yml` (npm >= 11.15).
