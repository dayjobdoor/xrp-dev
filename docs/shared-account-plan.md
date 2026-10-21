# Shared account across apps (plan B: Related Origin Requests) and renamable names

Status: plan only. Nothing here is implemented.

## Goal
One passkey gives one XRPL address and one name in every app. The name can be changed.

## Why B
The wallet key is derived on the client from the passkey PRF output (`Wallet.fromPrf`, salt `xrp-dev/prf/v1`). Only a page whose origin is allowed for the credential's `rpId` can run the PRF. Each app must therefore run the PRF itself, which rules out SSO through one auth origin (it would hold every key and every signature would need a popup). B keeps signing local.

## Mechanism
1. Pick one RP ID, e.g. the domain of the canonical app. Serve `/.well-known/webauthn` there: `{"origins":["https://xrp.sh","https://pjq.jp","https://8102.jp", ...]}`.
2. Every app passes that `rpId` to `Passkey.connect` / registration (`rpId` option already exists in `xrp-dev/wallet/passkey`).
3. Chrome 128+ and Safari 18+ honour the list. Firefox does not (not measured here). Browsers without support fall back to a per-app credential, so the address differs there: show a notice.
4. Browsers cap the number of distinct labels in the list (reported as about 5; verify before relying on it). Count registrable domains, not subdomains.
5. `*.589.workers.dev` hosts can share `rpId: "589.workers.dev"` without the file (workers.dev is on the Public Suffix List). Useful for dev stages only.

## Name ledger
- One ledger for all apps, reached by HTTP (or a Cloudflare service binding): `NameStore` over `fetch`. It stores `(account, name)` only, never keys.
- Each app keeps its own users table keyed by `account`. The name is a display column fetched from, or mirrored from, the ledger.
- Where the ledger lives is open (xrpdev Worker or a new one).

## Rename
- Key everything on `account`, never on the name. Audit URLs that embed the name (xrpeco `/room/<name>`) and resolve name -> account at the edge.
- `renameName(store, account, raw, opts)`: one `UPDATE ... WHERE account = ?`; UNIQUE(name) decides races. Authorised by a fresh passkey signature over a challenge that includes the new name.
- Policy (decided): no frequency limit, old name released immediately, no history. Risk accepted: a released name can be taken by someone else.
- After a rename call `PublicKeyCredential.signalCurrentUserDetails({ rpId, userId, name, displayName })` so the passkey manager shows the new name.

## Steps
1. xrp-dev: `renameName` + tests; drop "immutable" wording in `registerPasskeyAccount`/CHANGELOG.
2. xrpeco: rename endpoint, UI, URL resolution; run on a dev stage.
3. Pick the RP ID domain; publish `/.well-known/webauthn`; set `rpId` in each app.
4. Ledger service and `NameStore` HTTP adapter; migrate each app to it.
5. Verify in Chrome and Safari: same address and name in two apps; rename visible in both.

## Open
- RP ID domain and the origin list.
- Ledger host.
- Existing prod accounts: changing `rpId` changes their credentials and addresses. Users today: xrpeco 1, others unknown.
