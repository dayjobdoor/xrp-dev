import { defineConfig } from "vite-plus";

export default defineConfig({
  // The stdio tests start a child process per case, and parallel runs of the whole repo make the default 5 s too tight; core, wallet and x402 use 60 s too.
  test: { include: ["test/**/*.test.ts"], testTimeout: 60_000 },
  // The stdio bin runs on Node and Bun and has no importable API, so it ships without .d.ts; its shebang survives bundling.
  // platform "node" would rename the bin to mcp.mjs (core's package.json `bin` points at dist/mcp/mcp.js); "neutral" only warns that node:util stays external.
  pack: [
    { entry: ["src/index.ts"], dts: true, clean: false },
    { entry: ["bin/mcp.ts"], dts: false, clean: false },
  ].map((config) => ({ format: "esm", platform: "neutral", tsconfig: "tsconfig.json", ...config })),
});
