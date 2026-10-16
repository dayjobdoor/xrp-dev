import { Effect, Exit } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { base58CheckDecode, base58CheckEncode, base58Decode, base58Encode, bytesToHex, hexToBytes, ripemd160, sha256, sha512, sha512Half } from "../src/crypto.js";

const run = Effect.runPromise;
const utf8 = (s: string) => new TextEncoder().encode(s);
const lower = (b: Uint8Array) => bytesToHex(b).toLowerCase();

describe("W-C01 hashes", () => {
  it("SHA-256 / SHA-512 / sha512Half of abc", async () => {
    expect(lower(await run(sha256(utf8("abc"))))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const full = await run(sha512(utf8("abc")));
    expect(lower(full)).toBe(
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    );
    expect(await run(sha512Half(utf8("abc")))).toEqual(full.slice(0, 32));
  });
});

describe("W-C02 RIPEMD-160", () => {
  it("fixed vectors", () => {
    expect(lower(ripemd160(utf8("")))).toBe("9c1185a5c5e9fc54612808977ee8f548b2258d31");
    expect(lower(ripemd160(utf8("abc")))).toBe("8eb208f7e05d987a9b044a8e98c6b087f15a0bfc");
  });
  it("known answers (RIPEMD-160 reference vectors)", () => {
    expect(lower(ripemd160(utf8("a")))).toBe("0bdc9d2d256b3ee9daae347be6f4dc835a467ffe");
    expect(lower(ripemd160(utf8("message digest")))).toBe("5d0689ef49d2fae572b881b123a85ffa21595f36");
    expect(lower(ripemd160(utf8("abcdefghijklmnopqrstuvwxyz")))).toBe("f71c27109c692c1b56bbdceb5b9d2865b3708dbc");
    expect(lower(ripemd160(utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe("12a053384a9c0c88e405a06c27dcf49ada62eb2b");
    expect(lower(ripemd160(utf8("1234567890".repeat(8))))).toBe("9b752e45573d4b39f4dbd3323cab82bf63326bfb");
    expect(lower(ripemd160(utf8("a".repeat(1_000_000))))).toBe("52783243c1697bdbe16d37f97f68f08325dc1528");
  });
});

describe("W-C03 base58", () => {
  it("round-trips and maps leading zero bytes to r", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 64 }), async (b) => {
        const text = base58Encode(b);
        let zeros = 0;
        while (b[zeros] === 0) zeros++;
        expect(text.startsWith("r".repeat(zeros))).toBe(true);
        expect(text[zeros]).not.toBe("r");
        expect(await run(base58Decode(text))).toEqual(b);
      }),
    );
  });
  it("rejects characters outside the XRPL alphabet", async () => {
    const exit = await Effect.runPromiseExit(base58Decode("r0"));
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("bad_base58");
  });
});

describe("W-C04 base58check", () => {
  it("detects a single replaced character", async () => {
    const text = await run(base58CheckEncode(Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20)));
    const i = 5;
    const tampered = text.slice(0, i) + (text[i] === "p" ? "s" : "p") + text.slice(i + 1);
    const err = await run(Effect.flip(base58CheckDecode(tampered)));
    expect(err.reason).toBe("bad_checksum");
  });
});

describe("hex", () => {
  it("is upper-case and rejects odd or non-hex input", async () => {
    expect(bytesToHex(Uint8Array.of(0xab, 0x01))).toBe("AB01");
    expect(await run(hexToBytes("ab01"))).toEqual(Uint8Array.of(0xab, 0x01));
    expect((await run(Effect.flip(hexToBytes("abc")))).reason).toBe("bad_hex");
    expect((await run(Effect.flip(hexToBytes("zz")))).reason).toBe("bad_hex");
  });
});
