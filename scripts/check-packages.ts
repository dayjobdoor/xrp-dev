// Packs the one published package and proves a consumer can use it: publint, attw (ESM-only),
// then a throwaway project that installs the tarball, imports every subpath, signs and verifies a
// transaction and answers an MCP request from Node and Bun, and type-checks the entry points under
// node16 and bundler resolution. Run after `bun run build`.
// With PACK_DIR set the tarballs it checked stay there, so a release publishes those exact files
// instead of packing the tree a second time.
import { $ } from "bun";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PACKAGES = ["core"];
// Peers the consumer must provide (optional ones included, so every entry point resolves its types), at the
// versions this repo tests with. Why not a range: it would re-resolve on every run, so a new upstream release
// could break, or compromise, a publish. node_modules is what bun.lock pins.
const PEERS = await Promise.all(
  ["effect", "xrpl", "xrpl-connect", "hono"].map(async (name) => `${name}@${(await Bun.file(join(ROOT, "node_modules", name, "package.json")).json()).version}`),
);
// The consumer's own compiler for the tsc step; not a peer of the packages.
const TSC = "typescript@7.0.2";

const tmp = await mkdtemp(join(tmpdir(), "xrp-dev-pack-"));
const packDir = process.env.PACK_DIR ?? tmp;
try {
  await mkdir(packDir, { recursive: true });
  const tarballs: string[] = [];
  const specifiers: string[] = [];
  const names: string[] = [];
  for (const dir of PACKAGES) {
    const cwd = join(ROOT, "packages", dir);
    const pkg = await Bun.file(join(cwd, "package.json")).json();
    await $`bun pm pack --destination ${packDir} --quiet`.cwd(cwd);
    const tgz = join(packDir, `${pkg.name.replace("/", "-")}-${pkg.version}.tgz`);
    tarballs.push(tgz);
    names.push(pkg.name);
    for (const sub of Object.keys(pkg.exports)) if (sub !== "./package.json") specifiers.push(pkg.name + sub.slice(1));
    console.log(`\n== ${pkg.name}`);
    await $`bunx --bun publint@0.3.25 ${tgz} --strict`;
    await $`bunx @arethetypeswrong/cli@0.18.5 ${tgz} --profile esm-only --ignore-rules cjs-resolves-to-esm`;
    // `bun pm pack` keeps a manifest as written; `npm publish` rewrites it (it once dropped `bin` for a "./" path), so ask npm.
    // Only the rewrite notice fails the check: a registry or network error here says nothing about the manifest.
    const dry = await $`npm publish --dry-run --tag check ${tgz} 2>&1`.cwd(cwd).nothrow().text();
    if (dry.includes("auto-corrected")) throw new Error(`npm would rewrite ${pkg.name}'s package.json (run \`npm pkg fix\`):\n${dry}`);
  }

  const app = join(tmp, "consumer");
  await mkdir(app);
  // bun pm pack rewrites workspace:* to the version, which is not on the registry yet: point it at the tarballs.
  const overrides = Object.fromEntries(names.map((name, i) => [name, `file:${tarballs[i]}`]));
  await Bun.write(join(app, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module", overrides }));
  console.log("\n== consumer");
  // Fresh cache: a cached tarball of the same name and version from an earlier build must not be reused.
  await $`bun add ${tarballs} ${PEERS} ${TSC}`.cwd(app).env({ ...process.env, BUN_INSTALL_CACHE_DIR: join(tmp, "cache") });

  // Importing proves the entry points load; calling proves the bundles work: sign a Payment, check the signature.
  const probe = `const mods = ${JSON.stringify(specifiers)};
for (const m of mods) { const x = await import(m); if (!Object.keys(x).length) throw new Error(m + " has no exports"); }
console.log("imported", mods.length, "entry points");
const { Effect } = await import("effect");
const { decode, verifyTransaction } = await import("xrp-dev/codec");
const { Wallet } = await import("xrp-dev/wallet");
const run = Effect.runPromise;
const wallet = await run(Wallet.fromEntropy(new Uint8Array(16).fill(7)));
const { tx_blob } = await run(wallet.sign({ TransactionType: "Payment", Account: wallet.address, Destination: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", Amount: "1", Fee: "10", Sequence: 1, LastLedgerSequence: 100 }));
if (!(await run(verifyTransaction(tx_blob)))) throw new Error("a signed blob does not verify");
if ((await run(decode(tx_blob))).Account !== wallet.address) throw new Error("decode lost the Account");
console.log("signed and verified a Payment");`;
  await $`node --input-type=module -e ${probe}`.cwd(app);
  await $`bun -e ${probe}`.cwd(app);

  // The bin, by path from the installed package, answers tools/list and one call under Node (its shebang) and
  // Bun. Why not `bunx xrp-dev-mcp`: a bin that is missing makes bunx fetch the unscoped registry package of that name.
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "is_valid_address", arguments: { address: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" } } },
  ];
  for (const command of [["./node_modules/.bin/xrp-dev-mcp"], ["bun", "--bun", "./node_modules/.bin/xrp-dev-mcp"]]) {
    const proc = Bun.spawn(command, { cwd: app, stdin: new Blob([requests.map((r) => `${JSON.stringify(r)}\n`).join("")]), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}: ${stderr}`);
    // Replies may arrive in either order: requests run concurrently.
    const replies = new Map(stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((reply) => [reply.id, reply]));
    if (!replies.get(1)?.result?.tools?.length) throw new Error(`${command.join(" ")} tools/list: ${stdout}`);
    if (replies.get(2)?.result?.isError !== false) throw new Error(`${command.join(" ")} tools/call: ${stdout}`);
    console.log(`xrp-dev-mcp bin ok (${command[0] === "bun" ? "bun" : "node"})`);
  }

  await Bun.write(join(app, "consumer.ts"), `${specifiers.map((s, i) => `import * as m${i} from "${s}";`).join("\n")}\nexport const all = [${specifiers.map((_, i) => `m${i}`).join(", ")}];\n`);
  for (const [name, module, moduleResolution] of [["node16", "node16", "node16"], ["bundler", "esnext", "bundler"]]) {
    const config = join(app, `tsconfig.${name}.json`);
    await Bun.write(config, JSON.stringify({ compilerOptions: { module, moduleResolution, target: "es2022", lib: ["es2022", "dom"], strict: true, noEmit: true, skipLibCheck: true, types: [] }, files: ["consumer.ts"] }));
    console.log(`tsc ${name}`);
    await $`./node_modules/.bin/tsc -p ${config}`.cwd(app);
  }
  console.log(`\nok: ${specifiers.length} entry points, ${tarballs.length} tarballs${process.env.PACK_DIR ? ` kept in ${packDir}` : ""}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
