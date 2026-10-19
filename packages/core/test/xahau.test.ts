import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { autofill, NETWORK_PRESETS, type RpcClient } from "../src/client.js";
import { decode, encode } from "../src/codec.js";
import { XAHAU_DEFINITIONS } from "../src/xahau.js";

const run = Effect.runPromise;
const account = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const importTx = { TransactionType: "Import", Account: account, Blob: "00", Sequence: 0, Fee: "10", NetworkID: 21338, SigningPubKey: "" };

describe("Xahau definitions", () => {
  it("round-trips an Import; the XRPL tables refuse it", async () => {
    const blob = await run(encode(importTx, XAHAU_DEFINITIONS));
    expect(await run(decode(blob, XAHAU_DEFINITIONS))).toEqual(importTx);
    await expect(run(encode(importTx))).rejects.toThrow();
  });

  it("encodes hook parameters", async () => {
    const tx = {
      TransactionType: "SetHook",
      Account: account,
      Fee: "10",
      Sequence: 1,
      SigningPubKey: "",
      Hooks: [{ Hook: { HookHash: "AB".repeat(32), HookNamespace: "CD".repeat(32), HookOn: "0".repeat(64), HookParameters: [{ HookParameter: { HookParameterName: "43", HookParameterValue: "01" } }] } }],
    };
    expect(await run(decode(await run(encode(tx, XAHAU_DEFINITIONS)), XAHAU_DEFINITIONS))).toEqual(tx);
  });
});

/** A node that answers `fee` and records what it was asked. */
const node = (drops: Record<string, string>) => {
  const asked: { method: string; params?: object }[] = [];
  const client: RpcClient = {
    request: <T>(method: string, params?: object) => {
      asked.push({ method, ...(params && { params }) });
      return Effect.succeed({ drops, ledger_current_index: 100 } as T);
    },
  };
  return { client, asked };
};

describe("autofill", () => {
  const payment = { TransactionType: "Payment", Account: account, Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", Amount: "1", Sequence: 5 };

  it("adds NetworkID above 1024 only", async () => {
    const { client } = node({ open_ledger_fee: "10" });
    expect((await run(autofill(client, payment, { networkId: NETWORK_PRESETS["xahau:testnet"].networkId }))).NetworkID).toBe(21338);
    expect((await run(autofill(client, payment, { networkId: 1 }))).NetworkID).toBeUndefined();
    expect((await run(autofill(client, { ...payment, NetworkID: 7 }, { networkId: 21338 }))).NetworkID).toBe(7);
  });

  it("with definitions asks for the fee of this transaction and uses base_fee", async () => {
    const { client, asked } = node({ base_fee: "34", open_ledger_fee: "10" });
    const out = await run(autofill(client, payment, { definitions: XAHAU_DEFINITIONS }));
    expect(out.Fee).toBe("34");
    expect(asked[0]!.params).toHaveProperty("tx_blob");
  });

  it("without definitions keeps using open_ledger_fee", async () => {
    const { client } = node({ base_fee: "34", open_ledger_fee: "10" });
    expect((await run(autofill(client, payment))).Fee).toBe("10");
  });
});
