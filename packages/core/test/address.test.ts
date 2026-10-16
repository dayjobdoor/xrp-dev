import { Effect } from "effect";
import fc from "fast-check";
import * as oracle from "ripple-address-codec";
import { describe, expect, it } from "vite-plus/test";
import {
  classicToXAddress,
  decodeAccountId,
  decodeSeed,
  deriveAccountId,
  encodeAccountId,
  encodeSeed,
  isValidClassicAddress,
  xAddressToClassic,
} from "../src/address.js";
import { base58CheckEncode } from "../src/crypto/base58.js";
import { hexToBytes } from "../src/crypto/hex.js";

const run = Effect.runPromise;
const GENESIS_PUB = "0330E7FC9D56BB25D6893BA3F317AE5BCF33B3291BD63DB32654A313222F7FD020";
const GENESIS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

describe("W-A01 public key to address", () => {
  it("genesis", async () => {
    const id = await run(deriveAccountId(await run(hexToBytes(GENESIS_PUB))));
    expect(await run(encodeAccountId(id))).toBe(GENESIS);
  });
  it("AccountID encoding matches ripple-address-codec", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 20, maxLength: 20 }), async (id) => {
        const address = await run(encodeAccountId(id));
        expect(address).toBe(oracle.encodeAccountID(id));
        expect(await run(decodeAccountId(address))).toEqual(id);
      }),
    );
  });
});

describe("W-A02 X-address", () => {
  it("fixed vectors", async () => {
    expect(await run(classicToXAddress(GENESIS, 12345, false))).toBe("XVPcpSm47b1CZkf5AkKM9a84dQHe3mTAxgxfLw2qYoe7Boa");
    expect(await run(classicToXAddress(GENESIS, false, true))).toBe("TVK3SYvMLZR6rEtLDZh3saYHaqFSeMpn3Dz7EsmQC63VUwh");
    expect(await run(xAddressToClassic("XVPcpSm47b1CZkf5AkKM9a84dQHe3mTAxgxfLw2qYoe7Boa"))).toEqual({ classicAddress: GENESIS, tag: 12345, test: false });
  });
  it("matches ripple-address-codec for any tag and network", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 20, maxLength: 20 }), fc.oneof(fc.constant(false as const), fc.nat({ max: 0xffffffff })), fc.boolean(), async (id, tag, test) => {
        const classic = oracle.encodeAccountID(id);
        const x = await run(classicToXAddress(classic, tag, test));
        expect(x).toBe(oracle.classicAddressToXAddress(classic, tag, test));
        expect(await run(xAddressToClassic(x))).toEqual({ classicAddress: classic, tag, test });
      }),
    );
  });
  it("rejects a tag above 32 bits", async () => {
    expect((await run(Effect.flip(classicToXAddress(GENESIS, 2 ** 32, false)))).reason).toBe("bad_tag");
  });
});

describe("X-address edge cases", () => {
  const xRaw = (prefix: number[], flag: number, tag: number[], reserved: number[]) =>
    run(base58CheckEncode(Uint8Array.of(...prefix, ...new Uint8Array(20).fill(7), flag, ...tag, ...reserved)));
  const MAIN = [0x05, 0x44];

  it.each([-1, 1.5, NaN])("classicToXAddress rejects tag %s as bad_tag", async (tag) => {
    expect((await run(Effect.flip(classicToXAddress(GENESIS, tag, false)))).reason).toBe("bad_tag");
  });

  it.each([
    ["flag 1 with non-zero reserved bytes", MAIN, 1, [1, 0, 0, 0], [0, 0, 0, 1], "bad_tag"],
    ["flag 2", MAIN, 2, [0, 0, 0, 0], [0, 0, 0, 0], "bad_tag"],
    ["flag 0 with a tag", MAIN, 0, [1, 0, 0, 0], [0, 0, 0, 0], "bad_tag"],
    ["a foreign prefix", [0x00, 0x00], 0, [0, 0, 0, 0], [0, 0, 0, 0], "bad_version"],
  ])("xAddressToClassic rejects %s", async (_, prefix, flag, tag, reserved, reason) => {
    expect((await run(Effect.flip(xAddressToClassic(await xRaw(prefix, flag, tag, reserved))))).reason).toBe(reason);
  });

  it("xAddressToClassic rejects a 30-byte payload as bad_length", async () => {
    const short = await run(base58CheckEncode(Uint8Array.of(...MAIN, ...new Uint8Array(28))));
    expect((await run(Effect.flip(xAddressToClassic(short)))).reason).toBe("bad_length");
  });

  it("tag 0 and the maximum tag are real tags, distinct from no tag", async () => {
    const zero = await run(classicToXAddress(GENESIS, 0, false));
    expect(zero).not.toBe(await run(classicToXAddress(GENESIS, false, false)));
    expect(await run(xAddressToClassic(zero))).toEqual({ classicAddress: GENESIS, tag: 0, test: false });
    const max = await run(classicToXAddress(GENESIS, 4294967295, false));
    expect(await run(xAddressToClassic(max))).toEqual({ classicAddress: GENESIS, tag: 4294967295, test: false });
  });

  it("decodeAccountId refuses an X-address with a version error", async () => {
    const x = await run(classicToXAddress(GENESIS, 1, false));
    expect((await run(Effect.flip(decodeAccountId(x)))).reason).toBe("bad_version");
  });
});

describe("W-A03 invalid addresses", () => {
  it.each([
    ["wrong length", GENESIS.slice(0, -1)],
    ["character outside the alphabet", `${GENESIS.slice(0, -1)}0`],
    ["checksum mismatch", `${GENESIS.slice(0, -1)}${GENESIS.endsWith("h") ? "j" : "h"}`],
    ["a seed passed as an address", "snoPBrXtMeMyMHUVTgbuqAfg1SUTb"],
  ])("%s", async (_, address) => {
    expect(await run(isValidClassicAddress(address))).toBe(false);
  });
});

describe("seeds", () => {
  it("decodes both families and matches ripple-address-codec", async () => {
    expect((await run(decodeSeed("sEdSJHS4oiAdz7w2X2ni1gFiqtbJHqE"))).algorithm).toBe("ed25519");
    expect((await run(decodeSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb"))).algorithm).toBe("secp256k1");
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 16, maxLength: 16 }), fc.constantFrom("ed25519" as const, "secp256k1" as const), async (entropy, algorithm) => {
        const seed = await run(encodeSeed(entropy, algorithm));
        expect(seed).toBe(oracle.encodeSeed(entropy, algorithm));
        expect(await run(decodeSeed(seed))).toEqual({ entropy, algorithm });
      }),
    );
  });
});
