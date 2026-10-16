import { describe, expect, it } from "vite-plus/test";
import { X402_PROTOCOL, requirePayment } from "../src/index.js";

describe("requirePayment", () => {
  it("names the wire and refuses to start without a facilitator", () => {
    expect(X402_PROTOCOL).toEqual({ version: 2, scheme: "exact", library: "x402-xrpl@0.3.3" });
    expect(() => requirePayment({ price: "1", payToAddress: "r" })).toThrow(/facilitator/);
  });
});
