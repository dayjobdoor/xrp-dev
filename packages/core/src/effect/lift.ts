import { Effect } from "effect";

// The implementation is plain functions that throw tagged error classes. An Effect entry fails with the very same
// instance (so `catchTag` and `instanceof` keep working); anything else a function throws is a bug, so it is a defect.
// Call sites and the `lift(...)` factory calls are annotated `/* @__PURE__ */` so a bundler can drop an adapter nobody imports.

type ErrorClass = abstract new (...args: never[]) => Error;

const isOneOf = <const Cs extends readonly ErrorClass[]>(classes: Cs, e: unknown): e is InstanceType<Cs[number]> => classes.some((c) => e instanceof c);

/** `lift(CodecError)(f)` is `f` returning `Effect<T, CodecError>`. Only an instance of a listed class is a typed failure (`lift(A, B)` allows either): a throw of any other class is a defect, so the type is true. */
export const lift =
  <const Cs extends readonly ErrorClass[]>(...classes: Cs) =>
  <A extends readonly unknown[], T>(f: (...args: A) => T) =>
  (...args: A): Effect.Effect<T, InstanceType<Cs[number]>> =>
    Effect.suspend(() => {
      try {
        return Effect.succeed(f(...args));
      } catch (e) {
        return isOneOf(classes, e) ? Effect.fail(e) : Effect.die(e);
      }
    });

/** `lift` for a function that returns a Promise: a rejection with a listed class is a typed failure, any other is a defect. */
export const liftAsync =
  <const Cs extends readonly ErrorClass[]>(...classes: Cs) =>
  <A extends readonly unknown[], T>(f: (...args: A) => Promise<T>) =>
  (...args: A): Effect.Effect<T, InstanceType<Cs[number]>> =>
    Effect.promise(() => f(...args).then((value) => ({ value }), (error: unknown) => ({ error }))).pipe(
      Effect.flatMap((r) => ("error" in r ? (isOneOf(classes, r.error) ? Effect.fail(r.error) : Effect.die(r.error)) : Effect.succeed(r.value))),
    );

/** For a function that cannot fail: `Effect<T>`. A throw is a defect. */
export const liftTotal =
  <A extends readonly unknown[], T>(f: (...args: A) => T) =>
  (...args: A): Effect.Effect<T> =>
    Effect.sync(() => f(...args));
