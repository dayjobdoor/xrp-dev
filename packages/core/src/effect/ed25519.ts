import * as plain from "../crypto/ed25519.js";
import { CryptoError } from "../errors.js";
import { lift, liftTotal } from "./lift.js";

export { isValidPublicKey } from "../crypto/ed25519.js";

const fails = /* @__PURE__ */ lift(CryptoError);

export const getPublicKey = /* @__PURE__ */ fails(plain.getPublicKey);
export const sign = /* @__PURE__ */ fails(plain.sign);
/** False for anything malformed: wrong lengths, S >= L, non-canonical or small-order public key. */
export const verify = /* @__PURE__ */ liftTotal(plain.verify);
