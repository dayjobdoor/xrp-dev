import { describe, expect, it } from "vite-plus/test";
import {
  AddressError,
  CodecError,
  CryptoError,
  base58CheckDecode,
  base58CheckEncode,
  base58Decode,
  base58Encode,
  bytesToHex,
  decode,
  decodeAccountId,
  ed25519,
  encode,
  encodeForMultisigning,
  encodeSeed,
  hashTransaction,
  hexToBytes,
  publicKeyToAddress,
  secp256k1,
  signerMatchesAccount,
  verifyTransaction,
  type TxJson,
} from "../src/index.js";
import { verifyMessage } from "../src/auth.js";

const reason = (f: () => unknown, ctor: new (...a: never[]) => Error): unknown => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ctor);
    return (e as { reason: unknown }).reason;
  }
  throw new Error("did not throw");
};

const GENESIS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

describe("crypto: what throws, and which reason", () => {
  it("hexToBytes: odd length and non-hex are bad_hex", () => {
    expect(reason(() => hexToBytes("abc"), CryptoError)).toBe("bad_hex");
    expect(reason(() => hexToBytes("zz"), CryptoError)).toBe("bad_hex");
    expect(hexToBytes("")).toEqual(new Uint8Array());
  });

  it("base58Decode and base58CheckDecode", () => {
    expect(reason(() => base58Decode("r0"), CryptoError)).toBe("bad_base58");
    expect(reason(() => base58Decode("r".repeat(129)), CryptoError)).toBe("bad_length");
    expect(reason(() => base58CheckDecode(base58Encode(new Uint8Array(3))), CryptoError)).toBe("bad_length");
    const good = base58CheckEncode(Uint8Array.of(1, 2, 3, 4, 5));
    expect(base58CheckDecode(good)).toEqual(Uint8Array.of(1, 2, 3, 4, 5));
    const flipped = good.slice(0, -1) + (good.endsWith("r") ? "p" : "r");
    expect(reason(() => base58CheckDecode(flipped), CryptoError)).toBe("bad_checksum");
  });

  it("ed25519 and secp256k1 reject a bad key and a bad digest with CryptoError", () => {
    expect(reason(() => ed25519.getPublicKey(new Uint8Array(31)), CryptoError)).toBe("bad_key");
    expect(reason(() => ed25519.sign(new Uint8Array(1), new Uint8Array(33)), CryptoError)).toBe("bad_key");
    expect(reason(() => secp256k1.getPublicKey(new Uint8Array(32)), CryptoError)).toBe("bad_key");
    expect(reason(() => secp256k1.sign(new Uint8Array(31), new Uint8Array(32).fill(1)), CryptoError)).toBe("bad_length");
    expect(reason(() => secp256k1.sign(new Uint8Array(32), new Uint8Array(32)), CryptoError)).toBe("bad_key");
  });

  it("verify never throws: malformed input is false", () => {
    const key = new Uint8Array(32).fill(7);
    const pub = ed25519.getPublicKey(key);
    const sig = ed25519.sign(utf8("m"), key);
    expect(ed25519.verify(sig, utf8("m"), pub)).toBe(true);
    expect(ed25519.verify(sig.slice(1), utf8("m"), pub)).toBe(false);
    expect(ed25519.verify(sig, utf8("m"), pub.slice(1))).toBe(false);
    expect(secp256k1.verify(new Uint8Array(3), new Uint8Array(32), new Uint8Array(33))).toBe(false);
    expect(secp256k1.verify(new Uint8Array(70).fill(1), new Uint8Array(32), new Uint8Array(33).fill(2))).toBe(false);
  });
});

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("address: reasons", () => {
  it("decodeAccountId: a character outside the alphabet, a bad checksum, another kind of string", () => {
    expect(reason(() => decodeAccountId("0OIl"), AddressError)).toBe("bad_encoding");
    const flipped = GENESIS.slice(0, -1) + (GENESIS.endsWith("h") ? "p" : "h");
    expect(reason(() => decodeAccountId(flipped), AddressError)).toBe("bad_checksum");
    expect(reason(() => decodeAccountId(encodeSeed(new Uint8Array(16), "secp256k1")), AddressError)).toBe("bad_version");
  });

  it("publicKeyToAddress: bad hex, wrong length, a point that is not a key", () => {
    expect(reason(() => publicKeyToAddress("zz"), AddressError)).toBe("bad_encoding");
    expect(reason(() => publicKeyToAddress(new Uint8Array(32)), AddressError)).toBe("bad_length");
    expect(reason(() => publicKeyToAddress("04" + "11".repeat(32)), AddressError)).toBe("bad_key");
  });
});

describe("codec: a blob that does not decode throws, a blob that decodes but is not valid is false", () => {
  it("throws CodecError for non-hex, truncated and trailing-garbage input", () => {
    const blob = encode(payment());
    expect(() => verifyTransaction("zz")).toThrow(CodecError);
    expect(() => hashTransaction("xyz")).toThrow(CodecError);
    expect(() => signerMatchesAccount("zz")).toThrow(CodecError);
    expect(() => decode(blob.slice(0, -2))).toThrow(CodecError);
  });

  it("encode refuses input nested deeper than decode accepts, with CodecError rather than a stack overflow", () => {
    const nested = (levels: number) => {
      let o: Record<string, unknown> = { MemoData: "AB" };
      for (let i = 0; i < levels; i++) o = { Memo: o };
      return { ...payment(), Memos: [o] };
    };
    expect(decode(encode(nested(16)))).toEqual(nested(16));
    expect(reason(() => encode(nested(17)), CodecError)).toBe("bad_length");
    expect(reason(() => encode(nested(30_000)), CodecError)).toBe("bad_length");
    expect(encode(payment())).toBeTypeOf("string"); // the depth counter is back to zero after a throw
  });

  it("decode and encode stop at the same depth: the deepest blob decode accepts re-encodes to itself", () => {
    // Memos array (F9 .. F1) holding `levels` nested Memo objects (EA .. E1) around a MemoData blob (7D 01 AB).
    const blob = (levels: number) => "F9" + "EA".repeat(levels) + "7D01AB" + "E1".repeat(levels) + "F1";
    expect(encode(decode(blob(16)))).toBe(blob(16));
    expect(reason(() => decode(blob(17)), CodecError)).toBe("bad_length");
  });

  it("is false for a decodable blob with no signature", () => {
    expect(verifyTransaction(encode(payment()))).toBe(false);
  });
});

// A Payment that two keys multisign. Signers must be strictly ascending by AccountID, each signing the multisign blob;
// none of them may be the transaction's own Account.
const signers = [7, 9].map((fill) => {
  const key = new Uint8Array(32).fill(fill);
  const publicKey = "ED" + bytesToHex(ed25519.getPublicKey(key));
  return { key, publicKey, account: publicKeyToAddress(publicKey) };
});
function payment(): TxJson {
  return { TransactionType: "Payment", Account: GENESIS, Destination: signers[0]!.account, Amount: "1", Fee: "30", Sequence: 1, SigningPubKey: "" };
}
const entry = (s: (typeof signers)[number]) => ({
  Signer: { Account: s.account, SigningPubKey: s.publicKey, TxnSignature: bytesToHex(ed25519.sign(encodeForMultisigning(payment(), s.account), s.key)) },
});
const ascending = [...signers].sort((a, b) => (bytesToHex(decodeAccountId(a.account)) < bytesToHex(decodeAccountId(b.account)) ? -1 : 1));

describe("verifyTransaction, multisigned", () => {
  const blobOf = (list: unknown[]) => encode({ ...payment(), Signers: list });

  it("accepts signers in ascending AccountID order", () => {
    expect(verifyTransaction(blobOf(ascending.map(entry)))).toBe(true);
  });

  it("rejects the reverse order, a duplicate signer, and one signature that does not match its key", () => {
    expect(verifyTransaction(blobOf([...ascending].reverse().map(entry)))).toBe(false);
    expect(verifyTransaction(blobOf([entry(ascending[0]!), entry(ascending[0]!)]))).toBe(false);
    const forged = ascending.map(entry);
    forged[1] = { Signer: { ...forged[1]!.Signer, TxnSignature: forged[0]!.Signer.TxnSignature } };
    expect(verifyTransaction(blobOf(forged))).toBe(false);
  });

  it("rejects an empty signer list; 32 correct signers verify and a 33rd makes it false", () => {
    expect(verifyTransaction(blobOf([]))).toBe(false);
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => {
        const key = new Uint8Array(32).fill(i + 1);
        const publicKey = "ED" + bytesToHex(ed25519.getPublicKey(key));
        return { key, publicKey, account: publicKeyToAddress(publicKey) };
      })
        .sort((x, y) => (bytesToHex(decodeAccountId(x.account)) < bytesToHex(decodeAccountId(y.account)) ? -1 : 1))
        .map(entry);
    expect(verifyTransaction(blobOf(many(32)))).toBe(true);
    expect(verifyTransaction(blobOf(many(33)))).toBe(false);
  });
});

describe("auth.verifyMessage never throws on malformed input", () => {
  const ok = { message: "hello", signature: "00", publicKey: "00" };
  it("returns undefined for non-hex, odd-length hex and a key of the wrong size", () => {
    expect(verifyMessage({ ...ok, publicKey: "zz" })).toBeUndefined();
    expect(verifyMessage({ ...ok, signature: "abc" })).toBeUndefined();
    expect(verifyMessage({ ...ok, publicKey: "11".repeat(32) })).toBeUndefined();
    expect(verifyMessage({ ...ok, publicKey: "ED" + "11".repeat(31) })).toBeUndefined();
  });
});
