// AGENTS.md: a change updates CHANGELOG.md under the next version heading. This fails when a change touches a package's
// `src/` and not CHANGELOG.md. `--staged` checks the index (the pre-commit hook); `--base <ref>` checks `<ref>...HEAD` (CI on a
// pull request). A change with nothing a user could notice: `SKIP_CHANGELOG=1`.
import { $ } from "bun";

const args = process.argv.slice(2);
const base = args.indexOf("--base") >= 0 ? args[args.indexOf("--base") + 1] : undefined;
if (!args.includes("--staged") && !base) throw new Error("usage: check-changelog.ts --staged | --base <ref>");

if (process.env.SKIP_CHANGELOG) {
  console.log("changelog check skipped (SKIP_CHANGELOG)");
  process.exit(0);
}

const names = args.includes("--staged") ? await $`git diff --cached --name-only`.text() : await $`git diff --name-only ${base}...HEAD`.text();
const files = names.split("\n").filter(Boolean);
const source = files.filter((f) => /^packages\/[^/]+\/src\//.test(f));

if (source.length > 0 && !files.includes("CHANGELOG.md")) {
  console.error(`CHANGELOG.md is not part of this change, but ${source.length} file(s) under packages/*/src are:\n- ${source.slice(0, 8).join("\n- ")}${source.length > 8 ? "\n- ..." : ""}\nAdd an entry under the next version heading, or set SKIP_CHANGELOG=1 if no user could notice the change.`);
  process.exit(1);
}
