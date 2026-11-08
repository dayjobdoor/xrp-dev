import * as plain from "../crypto/secp256k1.js";
import { CryptoError } from "../errors.js";
import { lift, liftTotal } from "./lift.js";

export { addScalars, isValidPrivateKey, isValidPublicKey, n } from "../crypto/secp256k1.js";

const fails = /* @__PURE__ */ lift(CryptoError);

export const getPublicKey = /* @__PURE__ */ fails(plain.getPublicKey);
/** DER signature over a 32-byte digest: RFC 6979 nonce, low-S. */
export const sign = /* @__PURE__ */ fails(plain.sign);
/** False for anything malformed, off-curve, or high-S. */
export const verify = /* @__PURE__ */ liftTotal(plain.verify);
