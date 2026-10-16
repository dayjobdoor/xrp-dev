import { spawn } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import { PUBLIC_RPC_URLS } from "xrp-dev";
import pkg from "../package.json" with { type: "json" };

const BIN = new URL("../bin/mcp.ts", import.meta.url).pathname;
const FAKE_RIPPLED = new URL("./fake-rippled.preload.ts", import.meta.url).pathname;
const ACCOUNT = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const accountInfo = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "account_info", arguments: { account: ACCOUNT } } };

// One child per test: writes the requests, closes stdin, and collects the newline-delimited replies.
const talk = (requests: unknown[], args: string[] = [], end = "\n", env: Record<string, string> = {}) =>
  new Promise<{ replies: any[]; err: string; code: number | null }>((resolve) => {
    const child = spawn("bun", env.FAKE_DELAY_MS === undefined ? [BIN, ...args] : ["--preload", FAKE_RIPPLED, BIN, ...args], { env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ replies: out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)), err, code }));
    child.stdin.write(requests.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + end);
    child.stdin.end();
  });

describe("stdio server", () => {
  it("M04, M08: answers initialize and tools/list, and offers no submit", async () => {
    const { replies } = await talk([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      "{not json",
    ]);
    expect(replies).toHaveLength(3);
    // Replies are written as each request finishes, so match by id, not by position.
    const byId = (id: number | null) => replies.find((r) => r.id === id);
    expect(byId(1)).toMatchObject({ result: { serverInfo: { name: "xrp-dev-mcp" } } });
    const names = byId(2).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("prepare_payment");
    expect(names).not.toContain("submit");
    expect(byId(null)).toMatchObject({ error: { code: -32700 } });
  }, 30_000);

  it("runs a computation tool without touching the network", async () => {
    const { replies } = await talk([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "is_valid_address", arguments: { address: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" } } }]);
    expect(replies[0].result.content[0].text).toBe("true");
  }, 30_000);

  it("answers a final message that has no trailing newline", async () => {
    const { replies } = await talk([{ jsonrpc: "2.0", id: 7, method: "ping" }], [], "");
    expect(replies).toEqual([{ jsonrpc: "2.0", id: 7, result: {} }]);
  }, 30_000);

  it("rejects an unknown --network", async () => {
    const { code, err } = await talk([], ["--network", "moonnet"]);
    expect(code).toBe(2);
    expect(err).toContain("usage");
  }, 30_000);

  it.each([
    [["--network=mainnet"], "mainnet"],
    [["--network", "mainnet"], "mainnet"],
    [[], "testnet"],
  ])("serves the network chosen by %j", async (args, network) => {
    const { replies } = await talk([accountInfo], args, "\n", { FAKE_DELAY_MS: "0" });
    expect(JSON.parse(replies[0].result.content[0].text).url).toBe(PUBLIC_RPC_URLS[network as "mainnet" | "testnet"]);
  }, 30_000);

  it.each([["--netwrok", "mainnet"], ["--network"], ["mainnet"]])("exits 2 on the bad arguments %j instead of serving testnet", async (...args) => {
    const { code, err } = await talk([], args);
    expect(code).toBe(2);
    expect(err).toContain("usage");
  }, 30_000);

  it("reports the manifest version", async () => {
    const { replies } = await talk([{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }]);
    expect(replies[0].result.serverInfo.version).toBe(pkg.version);
  }, 30_000);

  it("answers ping while a slow tool call is still running", async () => {
    const { replies } = await talk([accountInfo, { jsonrpc: "2.0", id: 2, method: "ping" }], [], "\n", { FAKE_DELAY_MS: "1500" });
    expect(replies.map((r) => r.id)).toEqual([2, 1]);
  }, 30_000);

  it("answers a JSON-RPC batch with one array", async () => {
    const { replies } = await talk([[{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "ping" }]]);
    expect(replies).toEqual([[{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, result: {} }]]);
  }, 30_000);

  it("drops a line over 8 MiB with a parse error and keeps serving", async () => {
    const { replies } = await talk(["x".repeat(9 * 1024 * 1024), { jsonrpc: "2.0", id: 3, method: "ping" }]);
    expect(replies).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { jsonrpc: "2.0", id: 3, result: {} }]);
  }, 30_000);
});
