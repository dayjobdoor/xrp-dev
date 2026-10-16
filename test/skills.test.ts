import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "bun:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../");
const skillsDir = join(root, "skills");
const skills = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

// Convention: network snippets create their client with this one line; the test swaps in a fake.
const CLIENT_LINE = /^const client = createRpcClient\(\{ url: .*\}\)$/m;

const fakeClient = `import { Effect } from "effect"
import type { RpcClient } from "xrp-dev/client"

const results: Record<string, unknown> = {
  fee: { drops: { open_ledger_fee: "10" }, ledger_current_index: 1000 },
  ledger_current: { ledger_current_index: 1000 },
  account_info: { account_data: { Sequence: 5 } },
  submit: { engine_result: "tesSUCCESS", engine_result_message: "ok", applied: true },
  ledger: { ledger_index: 1001 },
  tx: { validated: true, meta: { TransactionResult: "tesSUCCESS" } },
}

export const fakeClient: RpcClient = {
  request: <T>(method: string) =>
    method in results ? Effect.succeed(results[method] as T) : Effect.die(new Error("unexpected rpc " + method)),
}
`;

const tmp = mkdtempSync(join(root, "test/.skills-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
writeFileSync(join(tmp, "fake-client.ts"), fakeClient);

const parse = (text: string) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const fm: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]!] = kv[2]!;
  }
  return { fm, body: text.slice(m?.[0].length ?? 0) };
};

const run = (cmd: string[], cwd: string) =>
  new Promise<{ out: string; err: string; code: number | null }>((done) => {
    const p = spawn(cmd[0]!, cmd.slice(1), { cwd });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => done({ out, err, code }));
  });

const markers: Record<string, string[][]> = {
  "xrpl-tx-build": [["AUTOFILL_OK Payment 10 5 1020", "AUTOFILL_OK TrustSet", "AUTOFILL_OK OfferCreate"], ["SUBMITTED tesSUCCESS", "CONFIRMED tesSUCCESS"]],
  "xrpl-codec-debug": [["DECODE_OK"], ["ORDER_OK"], ["AMOUNT_OK"], ["PREFIX_OK 53545800 534D5400"]],
};

describe("skills", () => {
  it("S00 finds the expected skills", () => {
    expect(skills.sort()).toEqual(Object.keys(markers).sort());
  });

  for (const name of skills) {
    const text = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
    const { fm, body } = parse(text);

    it(`S01 ${name}: frontmatter`, () => {
      expect(fm.name).toBe(name);
      expect(fm.description?.trim().length).toBeGreaterThan(0);
    });

    describe(`S02 ${name}: code blocks`, () => {
      const blocks = [...body.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!);
      it("has the expected number of blocks", () => expect(blocks.length).toBe(markers[name]!.length));

      blocks.forEach((src, i) => {
        it(`block ${i + 1} typechecks and runs`, async () => {
          const code = src.replace(CLIENT_LINE, 'import { fakeClient as client } from "./fake-client"');
          const dir = join(tmp, `${name}-${i}`);
          mkdirSync(dir);
          const file = join(dir, "snippet.ts");
          // Rewrite the relative import: fake-client.ts lives one level up.
          writeFileSync(file, code.replace('"./fake-client"', '"../fake-client"'));
          writeFileSync(
            join(dir, "tsconfig.json"),
            JSON.stringify({ extends: join(root, "packages/tsconfig.base.json"), compilerOptions: { types: [], noEmit: true }, files: ["snippet.ts"] }),
          );
          const tsc = await run(["bunx", "tsc", "-p", "tsconfig.json"], dir);
          expect(tsc.out + tsc.err).toBe("");
          expect(tsc.code).toBe(0);
          const res = await run(["bun", file], dir);
          expect(res.err).toBe("");
          expect(res.code).toBe(0);
          for (const marker of markers[name]![i]!) expect(res.out).toContain(marker);
        }, 180_000);
      });
    });
  }
});
