import { defineConfig } from "vite-plus";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  // The stdio bin runs on Node and Bun and has no importable API, so it ships without .d.ts; its shebang survives bundling.
  // platform "node" would rename the bin to mcp.mjs (package.json points at mcp.js); "neutral" only warns that node:util stays external.
  pack: [
    { entry: ["src/index.ts"], dts: true, clean: false },
    { entry: ["bin/mcp.ts"], dts: false, clean: false },
  ].map((config) => ({ format: "esm", platform: "neutral", tsconfig: "tsconfig.json", ...config })),
});
