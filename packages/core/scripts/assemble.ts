// Copies the built wallet, mcp and x402 into this package's dist so npm publishes one name.
// ponytail: a directory copy, not a second bundler. The hashed chunk next to wallet's index
// must move with it. `vp pack` of core wipes dist, so core's own `build` runs this too.
import { existsSync } from "node:fs";
import { cp, copyFile, rm } from "node:fs/promises";

for (const name of ["wallet", "mcp", "x402"]) {
  // `bun run build` in packages/core alone: a sibling that was never built is left out, one that was is copied back.
  if (!existsSync(new URL(`../../${name}/dist/`, import.meta.url))) {
    console.log(`assemble: ${name} is not built, skipped (bun run build at the repo root builds all four)`);
    continue;
  }
  await rm(new URL(`${name}/`, new URL("../dist/", import.meta.url)), { recursive: true, force: true });
  await cp(new URL(`../../${name}/dist/`, import.meta.url), new URL(`../dist/${name}/`, import.meta.url), { recursive: true });
}
// The one changelog lives at the repo root; the tarball carries a copy (gitignored, regenerated on every build).
await copyFile(new URL("../../../CHANGELOG.md", import.meta.url), new URL("../CHANGELOG.md", import.meta.url));
