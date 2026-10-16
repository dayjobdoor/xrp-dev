import { Effect, Result, Schema as S } from "effect";
import type { Deps, Tool } from "./tools.js";

export { defineTool, tools } from "./tools.js";
export type { Deps, Tool, ToolFailure } from "./tools.js";

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const Request = S.Struct({
  jsonrpc: S.Literal("2.0"),
  id: S.optionalKey(S.Union([S.String, S.Number])),
  method: S.String,
  params: S.optionalKey(S.Unknown),
});
const InitializeParams = S.Struct({ protocolVersion: S.String });
const ToolCall = S.Struct({ name: S.String, arguments: S.optionalKey(S.Unknown) });

/** The decoded value, or `undefined` when the input does not match. */
const parse = <T, I>(schema: S.Codec<T, I>, input: unknown): T | undefined => Result.getOrUndefined(S.decodeUnknownResult(schema)(input));

export type Reply =
  | { jsonrpc: "2.0"; id: string | number; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

const ok = (id: string | number, result: unknown): Reply => ({ jsonrpc: "2.0", id, result });
const fail = (id: string | number | null, code: number, message: string): Reply => ({ jsonrpc: "2.0", id, error: { code, message } });

const toolResult = (text: string, isError: boolean) => ({ isError, content: [{ type: "text", text }] });

/**
 * One JSON-RPC message in, the reply out; `undefined` for a notification, which gets no reply.
 * An array is a batch (2025-03-26 requires them): replies come back as an array, without the notifications' entries.
 * Implements initialize, ping, tools/list and tools/call: all an MCP client needs from a tools-only server.
 */
export async function handleJsonRpc<D extends Deps>(
  tools: readonly Tool<D>[],
  deps: D,
  input: unknown,
  serverInfo: { name: string; version: string },
): Promise<Reply | Reply[] | undefined> {
  if (!Array.isArray(input)) return handleMessage(tools, deps, input, serverInfo);
  if (input.length === 0) return fail(null, -32600, "Invalid Request");
  const replies = (await Promise.all(input.map((message) => handleMessage(tools, deps, message, serverInfo)))).filter((r) => r !== undefined);
  return replies.length > 0 ? replies : undefined;
}

async function handleMessage<D extends Deps>(
  tools: readonly Tool<D>[],
  deps: D,
  input: unknown,
  serverInfo: { name: string; version: string },
): Promise<Reply | undefined> {
  const request = parse(Request, input);
  if (!request) return fail(null, -32600, "Invalid Request");
  const { id, method, params } = request;
  if (id === undefined) return undefined;

  switch (method) {
    case "initialize": {
      const asked = parse(InitializeParams, params)?.protocolVersion;
      const protocolVersion = asked && VERSIONS.includes(asked) ? asked : VERSIONS[0];
      return ok(id, { protocolVersion, capabilities: { tools: {} }, serverInfo });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) });
    case "tools/call": {
      const call = parse(ToolCall, params);
      const tool = call && tools.find((t) => t.name === call.name);
      if (!call || !tool) return fail(id, -32602, "Unknown tool");
      const checked = tool.validate(call.arguments);
      if ("error" in checked) return fail(id, -32602, checked.error);
      try {
        const result = await Effect.runPromise(Effect.result(tool.handler(checked.args, deps)));
        if (Result.isFailure(result)) return ok(id, toolResult(result.failure.message, true));
        const value = result.success;
        return ok(id, toolResult(typeof value === "string" ? value : (JSON.stringify(value) ?? "null"), false));
      } catch (e) {
        console.error(`tool ${tool.name} crashed`, e);
        return fail(id, -32603, "Internal error");
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}
