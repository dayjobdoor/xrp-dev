import * as plain from "../address.js";
import { AddressError } from "../errors.js";
import { lift, liftTotal } from "./lift.js";

export { AddressError };
export type { Algorithm } from "../address.js";

const fails = /* @__PURE__ */ lift(AddressError);

/** RIPEMD160(SHA256(publicKey)); ed25519 keys carry their 0xED prefix. */
export const deriveAccountId = /* @__PURE__ */ liftTotal(plain.deriveAccountId);
/** Account address of a 33-byte key: `0xED` + ed25519 key, or a compressed secp256k1 point on the curve. Anything else fails. */
export const publicKeyToAddress = /* @__PURE__ */ fails(plain.publicKeyToAddress);
export const encodeAccountId = /* @__PURE__ */ fails(plain.encodeAccountId);
export const decodeAccountId = /* @__PURE__ */ fails(plain.decodeAccountId);
export const isValidClassicAddress = /* @__PURE__ */ liftTotal(plain.isValidClassicAddress);
export const encodeSeed = /* @__PURE__ */ fails(plain.encodeSeed);
/** `sEd…` is ed25519, any other `s…` seed is secp256k1. */
export const decodeSeed = /* @__PURE__ */ fails(plain.decodeSeed);
export const classicToXAddress = /* @__PURE__ */ fails(plain.classicToXAddress);
export const xAddressToClassic = /* @__PURE__ */ fails(plain.xAddressToClassic);
