// Wallet half of the P04 runner Worker: bundled by portability.test.ts, run in workerd without nodejs_compat.
import { verifyTransaction } from "xrp-dev/codec";
import { Effect } from "effect";
import { Wallet } from "../../src/index.js";

interface Expected {
  ed25519Zero: string;
  payments: { seed: string; tx: Record<string, unknown>; tx_blob: string; hash: string }[];
}

const GENESIS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const NUMBERS = "570521-598543-265488-209520-212450-201006-286214-581400";

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

    await check("genesis seed", () => Effect.runPromise(Wallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb")).then((w) => [w.publicKey, w.address]), ["0330E7FC9D56BB25D6893BA3F317AE5BCF33B3291BD63DB32654A313222F7FD020", GENESIS]);
    await check("ed25519 zero entropy", () => Effect.runPromise(Wallet.fromEntropy(new Uint8Array(16), { algorithm: "ed25519" })).then((w) => w.address), expected.ed25519Zero);
    await check("secret numbers secp256k1", () => Effect.runPromise(Wallet.fromSecretNumbers(NUMBERS)).then((w) => w.address), GENESIS);
    await check("secret numbers ed25519", () => Effect.runPromise(Wallet.fromSecretNumbers(NUMBERS, { algorithm: "ed25519" })).then((w) => w.address), "rGWrZyQqhTp9Xu7G5Pkayo7bXjH4k4QYpf");

    for (const p of expected.payments) {
      await check(`sign ${p.seed.slice(0, 5)}`, async () => {
        const wallet = await Effect.runPromise(Wallet.fromSeed(p.seed));
        const signed = await Effect.runPromise(wallet.sign(p.tx));
        return { ...signed, verified: await Effect.runPromise(verifyTransaction(signed.tx_blob)) };
      }, { tx_blob: p.tx_blob, hash: p.hash, verified: true });
    }

    return Response.json({ failures, ran });
  },
};
