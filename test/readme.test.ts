import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "bun:test";

// A README example runs as written when its fence says `ts run`: it is type-checked, then run with an offline rippled
// (test/fake-rippled.ts). Examples that need a browser, a database or a framework stay plain `ts`.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../");
const READMES = ["packages/core/README.md", "packages/wallet/README.md", "packages/mcp/README.md"];
const tmp = mkdtempSync(join(root, "test/.skills-readme-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const run = (cmd: string[], cwd: string) =>
  new Promise<{ out: string; err: string; code: number | null }>((done) => {
    const p = spawn(cmd[0]!, cmd.slice(1), { cwd });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => done({ out, err, code }));
  });

describe("README examples marked `ts run`", () => {
  for (const readme of READMES) {
    const blocks = [...readFileSync(join(root, readme), "utf8").matchAll(/```ts run\n([\s\S]*?)```/g)].map((m) => m[1]!);
    it(`${readme} has at least one`, () => expect(blocks.length).toBeGreaterThan(0));

    blocks.forEach((src, i) => {
      it(`${readme} block ${i + 1} typechecks and runs`, async () => {
        const dir = join(tmp, `${readme.split("/")[1]}-${i}`);
        mkdirSync(dir);
        writeFileSync(join(dir, "snippet.ts"), src);
        // Examples declare values to show a call; unused ones are not a defect here.
        writeFileSync(
          join(dir, "tsconfig.json"),
          JSON.stringify({ extends: join(root, "packages/tsconfig.base.json"), compilerOptions: { types: [], noEmit: true, noUnusedLocals: false, noUnusedParameters: false }, files: ["snippet.ts"] }),
        );
        const tsc = await run(["bunx", "tsc", "-p", "tsconfig.json"], dir);
        expect(tsc.out + tsc.err).toBe("");
        const res = await run(["bun", "--preload", join(root, "test/fake-rippled.ts"), join(dir, "snippet.ts")], dir);
        expect(res.err).toBe("");
        expect(res.code).toBe(0);
      }, 180_000);
    });
  }
});
