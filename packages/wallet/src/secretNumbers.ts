import { WalletError } from "./errors.js";

// XLS-12: 16 bytes of entropy as 8 groups. Each group is a 16-bit big-endian value (5 digits)
// followed by one checksum digit: (value * (position * 2 + 1)) % 9.
const checksum = (position: number, value: number) => (value * (position * 2 + 1)) % 9;

/** Throws `WalletError` (`bad_entropy`) unless `entropy` is 16 bytes. */
export const toSecretNumbers = (entropy: Uint8Array): string[] => {
  if (entropy.length !== 16) throw new WalletError({ reason: "bad_entropy", message: "entropy must be 16 bytes" });
  return Array.from({ length: 8 }, (_, i) => {
    const value = (entropy[i * 2]! << 8) | entropy[i * 2 + 1]!;
    return `${String(value).padStart(5, "0")}${checksum(i, value)}`;
  });
};

/** Throws `WalletError` (`bad_secret_numbers`, or `bad_checksum` with the 1-based `position` of the group). */
export const fromSecretNumbers = (input: string | readonly string[]): Uint8Array => {
  const groups = typeof input === "string" ? (input.match(/[0-9]+/g) ?? []) : input.map((g) => g.trim());
  if (groups.length !== 8 || groups.some((g) => !/^[0-9]{6}$/.test(g))) throw new WalletError({ reason: "bad_secret_numbers", message: "expected 8 groups of 6 digits" });
  const entropy = new Uint8Array(16);
  for (const [i, group] of groups.entries()) {
    const value = Number(group.slice(0, 5));
    if (value > 0xffff || checksum(i, value) !== Number(group[5])) throw new WalletError({ reason: "bad_checksum", message: `secret number group ${i + 1} is invalid`, position: i + 1 });
    entropy[i * 2] = value >> 8;
    entropy[i * 2 + 1] = value & 0xff;
  }
  return entropy;
};
