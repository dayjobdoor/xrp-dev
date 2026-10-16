/**
 * PRF input and HKDF salt/info, fixed per version: changing it changes every derived address. A function, not an
 * exported constant: a shared mutable Uint8Array would let any importer silently change every passkey address.
 */
export const prfSalt = (): Uint8Array => new TextEncoder().encode("xrp-dev/prf/v1");

/**
 * Overrides for the three derivation inputs, to reproduce another app's frozen derivation. Each defaults to
 * "xrp-dev/prf/v1". `prfInput` is what the authenticator evaluates (WebAuthn PRF `eval.first`); `salt` and `info`
 * are the HKDF inputs. Omitted fields keep the default, so set all three for a foreign scheme.
 */
export interface PrfDerivation {
  prfInput?: Uint8Array;
  salt?: Uint8Array;
  info?: Uint8Array;
}
