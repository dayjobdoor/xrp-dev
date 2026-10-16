// Copies the built wallet, mcp and x402 into this package's dist so npm publishes one name.
// ponytail: a directory copy, not a second bundler. The hashed chunk next to wallet's index
// must move with it. Run after `vp pack` of core, wallet, mcp and x402: core's pack wipes dist.
import { cp, rm } from "node:fs/promises";

for (const name of ["wallet", "mcp", "x402"]) {
  await rm(new URL(`${name}/`, new URL("../dist/", import.meta.url)), { recursive: true, force: true });
  await cp(new URL(`../../${name}/dist/`, import.meta.url), new URL(`../dist/${name}/`, import.meta.url), { recursive: true });
}
