// P04 runner Worker: bundled by the test, run in workerd without nodejs_compat.
// Fixed vectors are hard-coded here; xrpl.js-derived expectations arrive in the request body.
import { classicToXAddress, xAddressToClassic } from "xrp-dev/address";
import { decode, encode, verifyTransaction, type TxJson } from "xrp-dev/codec";
import { bytesToHex, ripemd160, sha256, sha512 } from "xrp-dev/crypto";
import { Effect } from "effect";

interface Expected {
  payments: { seed: string; tx_blob: string }[];
  codec: { binary: string; json: TxJson }[];
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const GENESIS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

export default {
  async fetch(request: Request): Promise<Response> {
    const expected = (await request.json()) as Expected;
    const failures: string[] = [];
    let ran = 0;
    const check = async (name: string, actual: () => Promise<unknown>, want: unknown) => {
      ran++;
      try {
        const got = await actual();
        if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      } catch (e) {
        failures.push(`${name}: threw ${String(e)}`);
      }
    };

    await check("sha256 abc", () => Effect.runPromise(sha256(utf8("abc"))).then(bytesToHex), "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD");
    await check("sha512 abc", () => Effect.runPromise(sha512(utf8("abc"))).then(bytesToHex), "DDAF35A193617ABACC417349AE20413112E6FA4E89A97EA20A9EEEE64B55D39A2192992A274FC1A836BA3C23A3FEEBBD454D4423643CE80E2A9AC94FA54CA49F");
    await check("ripemd160 abc", async () => bytesToHex(ripemd160(utf8("abc"))), "8EB208F7E05D987A9B044A8E98C6B087F15A0BFC");

    await check("X-address from classic", () => Effect.runPromise(classicToXAddress(GENESIS, 12345, false)), "XVPcpSm47b1CZkf5AkKM9a84dQHe3mTAxgxfLw2qYoe7Boa");
    await check("X-address testnet no tag", () => Effect.runPromise(classicToXAddress(GENESIS, false, true)), "TVK3SYvMLZR6rEtLDZh3saYHaqFSeMpn3Dz7EsmQC63VUwh");
    await check("X-address to classic", () => Effect.runPromise(xAddressToClassic("XVPcpSm47b1CZkf5AkKM9a84dQHe3mTAxgxfLw2qYoe7Boa")), { classicAddress: GENESIS, tag: 12345, test: false });

    // Blobs signed by xrpl.js verify in workerd (secp256k1 and ed25519).
    for (const p of expected.payments) await check(`verify ${p.seed.slice(0, 5)}`, () => Effect.runPromise(verifyTransaction(p.tx_blob)), true);

    for (const [i, f] of expected.codec.entries()) {
      await check(`codec encode #${i}`, () => Effect.runPromise(encode(f.json)), f.binary);
      await check(`codec round trip #${i}`, () => Effect.runPromise(decode(f.binary).pipe(Effect.flatMap(encode))), f.binary);
    }

    return Response.json({ failures, ran });
  },
};
