import xahauRaw from "./codec/definitions.xahau.json" with { type: "json" };
import { makeDefinitions } from "./codec/definitions.js";

/** Codec tables for Xahau (hooks, Import, URIToken, ...). Pass as the `defs` argument of encode/decode. */
export const XAHAU_DEFINITIONS = makeDefinitions(xahauRaw);

/** Where `definitions.xahau.json` came from. Change it in the same commit that regenerates the JSON. */
export const XAHAU_PROTOCOL = {
  definitionsSource: "https://xahau.network/",
  definitionsMethod: "server_definitions",
  capturedOn: "2026-10-19",
} as const;
