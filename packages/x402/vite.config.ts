import { defineConfig } from "vite-plus";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  pack: { entry: ["src/index.ts"], format: "esm", platform: "neutral", dts: true, clean: true, tsconfig: "tsconfig.json" },
});
