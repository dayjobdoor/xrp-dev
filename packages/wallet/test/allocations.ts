// What a heap dump taken after a call would show: every Uint8Array the call allocated, and which of them still hold a secret.
const Native = Uint8Array;

/**
 * Runs `f` with the global `Uint8Array` swapped for a recording subclass and returns every instance made meanwhile,
 * plus what `f` threw. The subclass keeps the name (a library may test `constructor.name`), the statics and the species,
 * so `slice`, `Uint8Array.from` and the libraries' own `new Uint8Array(n)` record too.
 */
export const recordAllocations = async (f: () => unknown): Promise<{ arrays: Uint8Array[]; error: unknown }> => {
  const arrays: Uint8Array[] = [];
  let error: unknown;
  class Uint8Array extends Native {
    constructor(...args: [number]) {
      super(...args);
      arrays.push(this);
    }
  }
  globalThis.Uint8Array = Uint8Array as unknown as typeof Native;
  try {
    await f();
  } catch (e) {
    error = e;
  } finally {
    globalThis.Uint8Array = Native;
  }
  return { arrays, error };
};

/** How many recorded arrays still hold `secret` (a run of non-zero bytes) anywhere inside their bytes. */
export const copiesOf = (arrays: readonly Uint8Array[], secret: Uint8Array): number => {
  const needle = Buffer.from(secret);
  return arrays.filter((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).includes(needle)).length;
};
