import { defineConfig } from "vite-plus";

// Pure-BigInt curve math: 5 s is too tight on a loaded machine or CI runner.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 60_000 },
  // One ESM file per subpath; definitions.json is inlined into the codec chunk.
  pack: {
    entry: ["src/index.ts", "src/crypto.ts", "src/address.ts", "src/codec.ts", "src/client.ts", "src/auth.ts", "src/xahau.ts"],
    format: "esm",
    platform: "neutral",
    dts: true,
    clean: true,
    tsconfig: "tsconfig.json",
  },
});
