#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createRpcClient, NETWORKS, type Network, PUBLIC_RPC_URLS } from "xrp-dev";
import pkg from "../package.json" with { type: "json" };
import { handleJsonRpc, tools } from "../src/index.js";

// Local stdio server: reads and computes, never signs or submits. Newline-delimited JSON-RPC on stdin / stdout.
const usage: () => never = () => {
  console.error(`usage: xrp-dev-mcp [--network ${NETWORKS.join("|")}]`);
  process.exit(2);
};
let requested: string | undefined;
try {
  // strict: a typo such as `--netwrok` must fail, not silently serve the default network.
  requested = parseArgs({ options: { network: { type: "string" } }, strict: true }).values.network;
} catch {
  usage();
}
const defaultNetwork = requested === undefined ? "testnet" : NETWORKS.find((n) => n === requested);
if (!defaultNetwork) usage();

const deps = { client: (network: Network = defaultNetwork) => createRpcClient({ url: PUBLIC_RPC_URLS[network] }) };
const serverInfo = { name: "xrp-dev-mcp", version: pkg.version };
const write = (reply: unknown) => process.stdout.write(`${JSON.stringify(reply)}\n`);
const parseError = () => write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });

// One line is buffered whole before it is parsed, so it needs a ceiling (rippled's own tx limit is 1 MiB).
const MAX_LINE = 8 * 1024 * 1024;

const handle = async (raw: string) => {
  const line = raw.trim();
  if (!line) return;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    parseError();
    return;
  }
  const reply = await handleJsonRpc(tools, deps, message, serverInfo);
  if (reply) write(reply);
};

// Not awaited in the read loop: a slow tool call must not hold up ping or tools/list behind it.
const inFlight = new Set<Promise<void>>();
const start = (line: string) => {
  const p: Promise<void> = handle(line)
    .catch((e) => console.error("request failed", e))
    .finally(() => inFlight.delete(p));
  inFlight.add(p);
};

process.stdin.setEncoding("utf8");
let buffer = "";
let discarding = false; // inside an oversized line: skip up to its newline
for await (const chunk of process.stdin as AsyncIterable<string>) {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (discarding) discarding = false;
    else if (line.length > MAX_LINE) parseError();
    else start(line);
  }
  if (buffer.length > MAX_LINE) {
    buffer = "";
    if (!discarding) parseError();
    discarding = true;
  }
}
if (!discarding) start(buffer); // a final message without a trailing newline
await Promise.all(inFlight);
