import { defineConfig } from "vite-plus";

export default defineConfig({
  // Parallel runs of the whole repo make the default 5 s too tight; core and wallet use 60 s too.
  test: { include: ["test/**/*.test.ts"], testTimeout: 60_000 },
  pack: { entry: ["src/index.ts"], format: "esm", platform: "neutral", dts: true, clean: true, tsconfig: "tsconfig.json" },
});
