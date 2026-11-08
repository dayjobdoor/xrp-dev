import * as plain from "../codec.js";
import { CodecError } from "../errors.js";
import { lift } from "./lift.js";

export { CodecError };
export type { Definitions, TxJson } from "../codec.js";
export { XRPL_DEFINITIONS, makeDefinitions } from "../codec.js";

const fails = /* @__PURE__ */ lift(CodecError);

export const encode = /* @__PURE__ */ fails(plain.encode);
export const decode = /* @__PURE__ */ fails(plain.decode);
/** `STX\0` + the signing fields only (TxnSignature, Signers, … dropped). */
export const encodeForSigning = /* @__PURE__ */ fails(plain.encodeForSigning);
/** `SMT\0` + signing fields with SigningPubKey emptied + the signer's AccountID. */
export const encodeForMultisigning = /* @__PURE__ */ fails(plain.encodeForMultisigning);
/** Transaction ID: sha512Half(`TXN\0` + signed blob). */
export const hashTransaction = /* @__PURE__ */ fails(plain.hashTransaction);
/** True when the blob is signed the way rippled requires and every signature verifies; fails with `CodecError` if the blob does not decode. See `xrp-dev/codec`. */
export const verifyTransaction = /* @__PURE__ */ fails(plain.verifyTransaction);
/** True when a single-signed blob's `SigningPubKey` is the master key of its `Account`; fails with `CodecError` if the blob does not decode. */
export const signerMatchesAccount = /* @__PURE__ */ fails(plain.signerMatchesAccount);
