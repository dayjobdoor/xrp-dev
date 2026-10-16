import { defineConfig } from "vite-plus";

// Pure-BigInt curve math: 5 s is too tight on a loaded machine or CI runner.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 60_000 },
  pack: { entry: ["src/index.ts", "src/passkey.ts"], format: "esm", platform: "neutral", dts: true, clean: true, tsconfig: "tsconfig.json" },
});
