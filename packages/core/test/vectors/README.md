# Test vectors

Every file is vendored verbatim; none is edited by hand.

## wycheproof/ (Apache-2.0, https://github.com/C2SP/wycheproof/blob/main/LICENSE)

Both files come from [C2SP/wycheproof](https://github.com/C2SP/wycheproof) `testvectors_v1/`. The commit named is one at which the file has exactly this content.

- `ecdsa_secp256k1_sha256_test.json`: commit `878e5366008753df2064d40c49f8e2f50f9c6af7` (2026-05-12). Used by `secp256k1.test.ts` (W-E02).
- `ed25519_test.json`: commit `5722833ca004` (2026-08-11); 151 vectors, all `valid` or `invalid`. Upstream has changed it since (2026-10-23, more vectors with `acceptable` results); the harness in `ed25519.test.ts` (W-E02) skips `acceptable`, so the file can be refreshed. Used by `ed25519.test.ts` (W-E02).

## rfc8032-ed25519.json

RFC 8032 section 7.1 Ed25519 test vectors (TEST 1, 2, 3, 1024, SHA(abc)), extracted verbatim. Used by `ed25519.test.ts` (W-E01).

## codec-fixtures.json

Source: https://github.com/XRPLF/xrpl.js `packages/ripple-binary-codec/test/fixtures/codec-fixtures.json` on `main` at commit `cfd0fb4fe9c3efdc5b041a7e43aecc566ffd5542` (downloaded 2026-10-11), verbatim. License: ISC (https://github.com/XRPLF/xrpl.js/blob/main/LICENSE). Used by `codec.test.ts` (W-K01, W-K03, W-K09, W-K11) and `portability.test.ts`. Its `ledgerData` section is not used.
