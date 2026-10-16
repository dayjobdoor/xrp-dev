import { describe, expect, it } from "vite-plus/test";
import { XRPL_DEFINITION_COUNTS, XRPL_PROTOCOL } from "../src/protocol.js";

describe("XRPL_PROTOCOL", () => {
  it("names the snapshot and its table sizes", () => {
    expect(XRPL_PROTOCOL).toEqual({
      server: "xrpld",
      repository: "XRPLF/rippled",
      definitionsSource: "https://s1.ripple.com:51234/",
      definitionsMethod: "server_definitions",
      capturedOn: "2026-10-11",
    });
    expect(XRPL_DEFINITION_COUNTS).toEqual({
      fields: 357,
      transactionTypes: 83,
      ledgerEntryTypes: 32,
      transactionResults: 195,
    });
  });
});
