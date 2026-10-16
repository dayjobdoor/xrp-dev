# Test vectors

## wycheproof/

- `ecdsa_secp256k1_sha256_test.json`: from [C2SP/wycheproof](https://github.com/C2SP/wycheproof) `testvectors_v1/`, last changed at commit `878e5366008753df2064d40c49f8e2f50f9c6af7` (2026-05-12). Used by `secp256k1.test.ts` (W-E02).
- License: Apache-2.0 (https://github.com/C2SP/wycheproof/blob/main/LICENSE).

## wycheproof/ed25519_test.json

Source: https://github.com/C2SP/wycheproof `testvectors_v1/ed25519_test.json` at commit
`12fd3aaf33eb5fa1f52e026912ee00c054f9d984`. License: Apache-2.0.

## rfc8032-ed25519.json

RFC 8032 section 7.1 Ed25519 test vectors (TEST 1, 2, 3, 1024, SHA(abc)), extracted verbatim.

## codec-fixtures.json

Source: https://github.com/XRPLF/xrpl.js `packages/ripple-binary-codec/test/fixtures/codec-fixtures.json` on `main` at commit `cfd0fb4fe9c3efdc5b041a7e43aecc566ffd5542` (downloaded 2026-10-11), verbatim. License: ISC (https://github.com/XRPLF/xrpl.js/blob/main/LICENSE). Used by `codec.test.ts` (W-K01).
