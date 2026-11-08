# Coding standards

Read during review. Only judgement calls live here: anything a tool can check is a check (`bun run lint`, `tsc` with `noUnusedLocals`, the bundle budgets, P03, the `ts run` README examples, the pre-commit hook), not a rule.

## Types say what the runtime guarantees

- A type that claims more than the code checks is a bug waiting for input: `request<T>` and `as T` on an answer from a node or a hand-written client. Narrow at the boundary (`unknown`, then a guard) and fail with the library's error.
- A type assertion needs a reason a reader can see at that line, and sits in one place (a guard function), not at every use.
- An adapter's declared error type is true: `lift(CodecError)(f)` means `f` throws nothing else the caller would call a failure. Do not widen it to make a call site compile.

## Comments and docs

- A comment says why, not what, and does not narrate the change ("now", "no longer", "was", "moved"). The commit and `CHANGELOG.md` carry history.
- A comment or doc sentence that names a mechanism (Effect, WebCrypto, `runSync`, a peer dependency) is re-read when that mechanism changes. Stale ones were the most common finding of the last review.
- Wording follows the entry: plain functions "throw", Effect entries "fail", the Promise client "rejects". `plain` means imports no `effect`, nothing weaker.
- A user-visible change has a `CHANGELOG.md` line that says what a user must do or what they will see. The hook only checks that the file changed; whether the line is true and complete is the review's job. Numbers in it (bundle sizes) come from `scripts/check-bundles.ts`, not from memory.

## Tests

- A test added with a fix fails without the fix. For a new check, break the thing it guards once and watch it fail (a wrong transaction type for a typed call, a module-level read of the curve for the bundle check).
- A test that mirrors the implementation (reads back what the constructor set, compares a function with a wrapper of itself) is deleted, not kept for coverage.

## Where each rule lives

Layering, the plain/Effect split and the `dist` trap: `docs/layering.md`. Repo boundaries, frozen constants, release: `AGENTS.md`.
