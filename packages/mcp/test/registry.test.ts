import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientError, type Network, type RpcClient } from "xrp-dev";
import { Wallet } from "xrp-dev-wallet";
import { Effect, Schema as S } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { defineTool, handleJsonRpc, tools, type Deps } from "../src/index.js";

const info = { name: "t", version: "0" };
const SEED = "snoPBrXtMeMyMHUVTgbuqAfg1SUTb";

// A rippled stand-in that records every call.
const fake = (answers: Record<string, unknown> = {}) => {
  const calls: { method: string; params: object | undefined; network: Network | undefined }[] = [];
  const deps: Deps = {
    client: (network): RpcClient => ({
      request: <T>(method: string, params?: object) => {
        calls.push({ method, params, network });
        return method in answers ? Effect.succeed(answers[method] as T) : Effect.fail(new ClientError({ reason: "rippled_error", message: `${method}: no answer` }));
      },
    }),
  };
  return { calls, deps };
};
const ACCOUNT = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const ISSUER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const NETWORK = { fee: { drops: { open_ledger_fee: "10" }, ledger_current_index: 100 }, account_info: { account_data: { Sequence: 7 } } };

const call = (deps: Deps, name: string, args: unknown) =>
  handleJsonRpc(tools, deps, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, info);
const rawText = (reply: Awaited<ReturnType<typeof call>>) => (reply as { result: { content: { text: string }[] } }).result.content[0]!.text;
const textOf = (reply: Awaited<ReturnType<typeof call>>) => JSON.parse(rawText(reply));

const keysOf = (v: unknown): string[] =>
  typeof v === "object" && v !== null ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : [];

describe("registry", () => {
  it("M01: a real MCP client lists and calls the tools", async () => {
    const { deps } = fake();
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://mcp.test/"), {
        fetch: async (_url, init) => {
          const reply = await handleJsonRpc(tools, deps, JSON.parse(String(init?.body)), info);
          return reply ? Response.json(reply) : new Response(null, { status: 202 });
        },
      }),
    );
    expect(client.getServerVersion()?.name).toBe("t");
    const listed = (await client.listTools()).tools.map((t) => t.name);
    expect(listed).toEqual(expect.arrayContaining(["encode", "decode", "hash_transaction", "derive_address", "prepare_payment", "account_info", "tx"]));
    const out = await client.callTool({ name: "is_valid_address", arguments: { address: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" } });
    expect(out.content).toEqual([{ type: "text", text: "true" }]);
  });

  it("M02: every tool is read-only", () => {
    for (const t of tools) expect(t.annotations.readOnlyHint, t.name).toBe(true);
    expect(tools.map((t) => t.name)).not.toContain("submit");
  });

  it("M03: no schema key names a seed, secret, private key, entropy or PRF", () => {
    for (const t of tools) expect(keysOf(t.inputSchema).filter((k) => /seed|secret|private|entropy|prf/i.test(k)), t.name).toEqual([]);
  });

  it("tools/list advertises the validated patterns", async () => {
    const reply = (await handleJsonRpc(tools, fake().deps, { jsonrpc: "2.0", id: 1, method: "tools/list" }, info)) as { result: { tools: { name: string; inputSchema: any }[] } };
    const decode = reply.result.tools.find((t) => t.name === "decode")!;
    expect(decode.inputSchema.properties.tx_blob.pattern).toBeTypeOf("string");
    expect(reply.result.tools.find((t) => t.name === "tx")!.inputSchema.properties.transaction.pattern).toBeTypeOf("string");
  });

  it("M05: a schema violation is -32602 and the handler is not called", async () => {
    let called = 0;
    const spy = defineTool({ name: "spy", description: "", schema: S.Struct({ n: S.Int }), handler: () => Effect.sync(() => ++called) });
    const bad = async (args: unknown) => handleJsonRpc([spy], fake().deps, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "spy", arguments: args } }, info);
    for (const args of [{}, { n: 1.5 }, { n: "1" }, undefined]) expect(await bad(args)).toMatchObject({ error: { code: -32602 } });
    expect(called).toBe(0);
    expect(await bad({ n: 1 })).toMatchObject({ result: { isError: false } });
    expect(called).toBe(1);

    const { deps, calls } = fake(NETWORK);
    expect(await call(deps, "prepare_payment", { account: "x", destination: "y", amount: "1" })).toMatchObject({ error: { code: -32602 } });
    expect(await call(deps, "account_info", { account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", network: "nope" })).toMatchObject({ error: { code: -32602 } });
    expect(calls).toEqual([]);
  });

  it("answers the protocol methods like the agent does", async () => {
    const { deps } = fake();
    const rpc = (message: unknown) => handleJsonRpc(tools, deps, message, info);
    expect(await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    expect(await rpc({ jsonrpc: "2.0", id: 1, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999" } })).toMatchObject({ result: { protocolVersion: "2025-06-18", serverInfo: info } });
    expect(await rpc({ jsonrpc: "2.0", id: 1, method: "resources/list" })).toMatchObject({ error: { code: -32601 } });
    expect(await rpc([])).toMatchObject({ error: { code: -32600 } });
    expect(await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "ping" }])).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
    expect(await rpc([{ jsonrpc: "2.0", method: "notifications/initialized" }])).toBeUndefined();
    expect(await call(deps, "nope", {})).toMatchObject({ error: { code: -32602, message: "Unknown tool" } });
  });

  it("reports a tool failure as isError and a crash as -32603", async () => {
    const { deps } = fake();
    const decodeBad = await call(deps, "decode", { tx_blob: "00" });
    expect(decodeBad).toMatchObject({ result: { isError: true } });
    const boom = defineTool({ name: "boom", description: "", schema: S.Struct({}), handler: () => Effect.die("x") });
    expect(await handleJsonRpc([boom], deps, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom" } }, info)).toMatchObject({ error: { code: -32603 } });
  });
});

describe("tools", () => {
  it("encode, decode and hash_transaction agree on a signed payment", async () => {
    const wallet = await Effect.runPromise(Wallet.fromSeed(SEED));
    const tx = { TransactionType: "Payment", Account: wallet.address, Destination: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", Amount: "1", Fee: "10", Sequence: 1 };
    const { tx_blob, hash } = await Effect.runPromise(wallet.sign(tx));
    const { deps } = fake();
    expect(textOf(await call(deps, "decode", { tx_blob }))).toMatchObject({ Account: wallet.address, Amount: "1" });
    expect(rawText(await call(deps, "hash_transaction", { tx_blob }))).toBe(hash);
    const encoded = rawText(await call(deps, "encode", { tx_json: textOf(await call(deps, "decode", { tx_blob })) }));
    expect(encoded).toBe(tx_blob);
  });

  it("deriveAddress, X-addresses and isValidAddress", async () => {
    const wallet = await Effect.runPromise(Wallet.fromSeed(SEED));
    const { deps } = fake();
    expect(rawText(await call(deps, "derive_address", { public_key: wallet.publicKey }))).toBe(wallet.address);
    const x = rawText(await call(deps, "classic_to_x_address", { address: wallet.address, tag: 5, test: true }));
    expect(x.startsWith("T")).toBe(true);
    expect(textOf(await call(deps, "x_address_to_classic", { x_address: x }))).toEqual({ classicAddress: wallet.address, tag: 5, test: true });
    expect(textOf(await call(deps, "is_valid_address", { address: `${wallet.address.slice(0, -1)}x` }))).toBe(false);
  });

  it("derive_address refuses 33 bytes that are not a public key", async () => {
    const { deps } = fake();
    for (const public_key of [`04${"11".repeat(32)}`, "00".repeat(33)]) expect(await call(deps, "derive_address", { public_key })).toMatchObject({ result: { isError: true } });
  });

  it("prepare_offer_create passes expiration; account_info rejects a ledger_index below 1", async () => {
    const { deps, calls } = fake(NETWORK);
    const args = { account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", taker_gets: "1", taker_pays: "2" };
    expect(textOf(await call(deps, "prepare_offer_create", { ...args, expiration: 800000000 })).tx_json).toMatchObject({ Expiration: 800000000 });
    expect(await call(deps, "prepare_offer_create", { ...args, expiration: -1 })).toMatchObject({ error: { code: -32602 } });
    const before = calls.length;
    expect(await call(deps, "account_info", { account: args.account, ledger_index: -5 })).toMatchObject({ error: { code: -32602 } });
    expect(calls).toHaveLength(before);
  });

  it.each([
    ["prepare_payment", { account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", amount: "1000000", destination_tag: 3 }, "Payment"],
    ["prepare_trust_set", { account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", currency: "USD", issuer: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", limit: "100" }, "TrustSet"],
    ["prepare_offer_create", { account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", taker_gets: "1000000", taker_pays: { currency: "USD", issuer: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", value: "1" } }, "OfferCreate"],
  ])("%s autofills, never signs, and reads the chosen network", async (name, args, type) => {
    const { deps, calls } = fake(NETWORK);
    const out = textOf(await call(deps, name, { ...args, network: "devnet" }));
    expect(out.tx_json).toMatchObject({ TransactionType: type, Fee: "10", Sequence: 7, LastLedgerSequence: 120 });
    expect(out.tx_json.SigningPubKey).toBeUndefined();
    expect(out.tx_json.TxnSignature).toBeUndefined();
    expect(out.signingHash).toBeUndefined();
    expect(out.signingData).toBeUndefined();
    expect(calls.every((c) => c.network === "devnet")).toBe(true);
    expect(calls.map((c) => c.method)).not.toContain("submit");
  });

  it.each([
    ["a Destination with a bad checksum", "prepare_payment", { account: ACCOUNT, destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYf", amount: "1" }],
    ["a non-numeric IOU value", "prepare_payment", { account: ACCOUNT, destination: ISSUER, amount: { currency: "USD", issuer: ISSUER, value: "abc" } }],
    ["a non-numeric trust limit", "prepare_trust_set", { account: ACCOUNT, currency: "USD", issuer: ISSUER, limit: "abc" }],
    ["XRP as the trust-line currency", "prepare_trust_set", { account: ACCOUNT, currency: "XRP", issuer: ISSUER, limit: "1" }],
  ])("%s is a tool error, not a prepared transaction", async (_, name, args) => {
    const { deps } = fake(NETWORK);
    expect(await call(deps, name, args)).toMatchObject({ result: { isError: true } });
  });

  it("refuses a transaction blob over 2 MiB before decoding it", async () => {
    expect(await call(fake().deps, "decode", { tx_blob: "AA".repeat(2_097_153) })).toMatchObject({ error: { code: -32602 } });
  });

  it("reads: account_info and tx go to the client; a rippled error is a tool error", async () => {
    const { deps, calls } = fake({ account_info: { account_data: { Balance: "5" } } });
    expect(textOf(await call(deps, "account_info", { account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" }))).toEqual({ account_data: { Balance: "5" } });
    expect(calls[0]).toEqual({ method: "account_info", params: { account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", ledger_index: "validated" }, network: undefined });
    const hash = "A".repeat(64);
    expect(await call(deps, "tx", { transaction: hash })).toMatchObject({ result: { isError: true, content: [{ text: "tx: no answer" }] } });
    expect(calls[1]).toMatchObject({ method: "tx", params: { transaction: hash } });
  });
});
