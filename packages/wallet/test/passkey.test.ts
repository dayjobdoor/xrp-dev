import { Wallet } from "../src/index.js";
import { decode, hashTransaction, verifyTransaction } from "xrp-dev/codec";
import { ClientError } from "xrp-dev";
import type { RpcClient } from "xrp-dev/client";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { SubmittableTransaction } from "xrpl";
import { MemoryStorageAdapter, WalletManager, type WalletAdapter } from "xrpl-connect";
import { PasskeyAdapter, PasskeyError, registerPasskey, type PasskeyAdapterOptions } from "../src/passkey.js";

const network = { id: "testnet", name: "Testnet", wss: "wss://s.altnet.rippletest.net:51233" };
const PRF = new Uint8Array(32).fill(9);
// Pinned in wallet.test.ts from an independent oracle (node:crypto HKDF + ripple-keypairs), not from this package.
const ADDRESS_FOR_PRF_9 = "rKGPScxUfLBjQDP6ZWudDHTirv8k2pMZBP";
const OTHER_PRF = new Uint8Array(32).fill(7);

type Seen = { get: any[]; submit: unknown[] };
/** `prf` may be a function of the 0-based `credentials.get` call number, to model the user picking another passkey later. */
const fakes = (prf: Uint8Array | undefined | ((call: number) => Uint8Array | undefined), extra: Partial<PasskeyAdapterOptions> = {}) => {
  const seen: Seen = { get: [], submit: [] };
  const credentialFor = (output: Uint8Array | undefined) => ({
    rawId: new Uint8Array([1, 2, 3]).buffer,
    getClientExtensionResults: () => (output ? { prf: { enabled: true, results: { first: output.slice().buffer } } } : { prf: { enabled: false } }),
  });
  const credentials = {
    get: async (options: unknown) => {
      const call = seen.get.length;
      seen.get.push(options);
      return credentialFor(typeof prf === "function" ? prf(call) : prf) as unknown as Credential;
    },
    create: async () => credentialFor(typeof prf === "function" ? prf(0) : prf) as unknown as Credential,
  };
  const client: RpcClient = {
    request: <T>(method: string, params?: object) => {
      seen.submit.push({ method, params });
      return Effect.succeed({ engine_result: "tesSUCCESS", engine_result_message: "ok" } as T);
    },
  };
  return { seen, adapter: new PasskeyAdapter({ network, client, credentials, ...extra }), credentials };
};

const payment = (account: string) =>
  ({
    TransactionType: "Payment",
    Account: account,
    Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
    Amount: "1000",
    Fee: "12",
    Sequence: 1,
    LastLedgerSequence: 100,
  }) as SubmittableTransaction;

describe("K02 unavailable environments", () => {
  it("no WebAuthn → isAvailable false; no PRF result → connect explains", async () => {
    const noWebAuthn = new PasskeyAdapter({ network, client: fakes(PRF).seen as never });
    expect(await noWebAuthn.isAvailable()).toBe(false);
    const { adapter } = fakes(undefined);
    await expect(adapter.connect()).rejects.toThrow(/PRF/);
    expect(await adapter.getAccount()).toBeNull();
  });
});

describe("K03 connect and sign", () => {
  it("derives the W-W06 address, asks for PRF with the fixed salt, signs verifiably and submits from the client", async () => {
    const { adapter, seen } = fakes(PRF);
    const account = await adapter.connect();
    expect(account.address).toBe(ADDRESS_FOR_PRF_9);
    const asked = seen.get[0] as { publicKey: { extensions: { prf: { eval: { first: Uint8Array } } }; userVerification: string } };
    expect(asked.publicKey.extensions.prf.eval.first).toEqual(new TextEncoder().encode("xrp-dev/prf/v1"));
    expect(asked.publicKey.userVerification).toBe("required");
    const signed = await adapter.sign(payment(account.address));
    expect(await Effect.runPromise(verifyTransaction(signed.tx_blob!))).toBe(true);
    const sent = await adapter.signAndSubmit(payment(account.address));
    expect(sent.engine_result).toBe("tesSUCCESS");
    expect(seen.submit).toEqual([{ method: "submit", params: { tx_blob: sent.tx_blob } }]);
  });
  it("fills tx_json and signature, and refuses object-form Flags instead of guessing", async () => {
    const { adapter } = fakes(PRF);
    const { address } = await adapter.connect();
    const signed = await adapter.sign({ ...payment(address), Flags: 0x00020000 });
    expect(signed.tx_json).toMatchObject({ Flags: 0x00020000, TxnSignature: signed.signature });
    await expect(adapter.sign({ ...payment(address), Flags: { tfPartialPayment: true } } as never)).rejects.toThrow(/Flags must be a number/);
  });
  it("registration returns the backup Secret Numbers for the same address", async () => {
    const { credentials } = fakes(PRF);
    const out = await registerPasskey({ rp: { name: "xrp-dev" }, user: { id: new Uint8Array([1]), name: "a", displayName: "a" }, credentials });
    expect(out.account?.address).toBe(ADDRESS_FOR_PRF_9);
    expect((await Effect.runPromise(Wallet.fromSecretNumbers(out.account!.secretNumbers))).address).toBe(ADDRESS_FOR_PRF_9);
  });
});

describe("K04 disconnect forgets the key", () => {
  it("getAccount is null and sign fails", async () => {
    const { adapter } = fakes(PRF);
    const { address } = await adapter.connect();
    await adapter.disconnect();
    expect(await adapter.getAccount()).toBeNull();
    await expect(adapter.sign(payment(address))).rejects.toThrow(/not connected/);
  });
});

describe("refusals and submit failures", () => {
  it.each([
    [{ TransactionType: "Batch" }],
    [{ TransactionType: "SetRegularKey" }],
    [{ TransactionType: "SignerListSet" }],
    [{ TransactionType: "DelegateSet" }],
    [{ TransactionType: "SetHook" }],
    [{ TransactionType: "AccountSet", SetFlag: 4 }],
  ])("never signs %o", async (extra) => {
    const { adapter, seen } = fakes(PRF);
    const { address } = await adapter.connect();
    await expect(adapter.sign({ ...payment(address), ...extra } as SubmittableTransaction)).rejects.toThrow(/署名しません/);
    expect(seen.submit).toEqual([]);
    expect(seen.get).toHaveLength(1);
  });

  it("autofills missing Fee/Sequence/LastLedgerSequence through the client before signing", async () => {
    const methods: string[] = [];
    const client: RpcClient = {
      request: <T>(method: string) => {
        methods.push(method);
        const result = { fee: { open_ledger_fee: "10" }, drops: { open_ledger_fee: "10", base_fee: "10" }, ledger_current_index: 50, account_data: { Sequence: 7 } };
        return Effect.succeed(result as T);
      },
    };
    const adapter = new PasskeyAdapter({ network, client, credentials: fakes(PRF).credentials });
    const { address } = await adapter.connect();
    const { Fee, Sequence, LastLedgerSequence, ...bare } = payment(address);
    const signed = await adapter.sign(bare);
    expect(methods).toContain("account_info");
    const tx = await Effect.runPromise(decode(signed.tx_blob!));
    expect(tx).toMatchObject({ Sequence: 7, LastLedgerSequence: 70 });
    expect(tx.Fee).toBeDefined();
  });

  it("throws on tem/tef/tel engine results", async () => {
    const client: RpcClient = { request: <T>() => Effect.succeed({ engine_result: "temBAD_FEE", engine_result_message: "bad" } as T) };
    const adapter = new PasskeyAdapter({ network, client, credentials: fakes(PRF).credentials });
    const { address } = await adapter.connect();
    await expect(adapter.signAndSubmit(payment(address))).rejects.toThrow(/temBAD_FEE/);
  });
});

describe("K05 driven by the real xrpl-connect WalletManager", () => {
  const manager = (adapter: WalletAdapter, net: "testnet" | "mainnet") => new WalletManager({ adapters: [adapter], network: net, logger: { level: "silent" } });

  it("connects on testnet without a networkMismatch, signs and submits through the manager", async () => {
    const { adapter, seen } = fakes(PRF);
    const wm = manager(adapter, "testnet");
    const account = await wm.connect("xrp-dev-passkey");
    expect(account.network.id).toBe("testnet");
    const sent = await wm.signAndSubmit(payment(account.address) as never);
    expect(sent.engine_result).toBe("tesSUCCESS");
    expect(seen.submit).toHaveLength(1);
    await wm.disconnect();
  });

  it("refuses another network before prompting the passkey; accepts a matching NetworkInfo", async () => {
    const { adapter, seen } = fakes(PRF);
    await expect(manager(adapter, "mainnet").connect("xrp-dev-passkey")).rejects.toThrow(/mainnet.*testnet/);
    expect(seen.get).toHaveLength(0);
    await expect(adapter.connect({ network: "nonesuch" as never })).rejects.toThrow(/nonesuch/);
    const wm = manager(adapter, "mainnet");
    expect((await wm.connect("xrp-dev-passkey", { network: { ...network, walletConnectId: "xrpl:1" } })).network.id).toBe("testnet");
  });
});

describe("page-load reconnect through the real WalletManager", () => {
  const quiet = { level: "silent" } as const;

  it.each(["secp256k1", "ed25519"] as const)("%s: restores without a prompt, then signs as the same account", async (algorithm) => {
    const storage = new MemoryStorageAdapter();
    const first = fakes(PRF, { algorithm });
    const { address } = await new WalletManager({ adapters: [first.adapter], network: "testnet", storage, logger: quiet }).connect("xrp-dev-passkey");
    if (algorithm === "ed25519") expect(address).not.toBe(ADDRESS_FOR_PRF_9);
    else expect(address).toBe(ADDRESS_FOR_PRF_9);
    // A page reload: a new adapter and a new manager over the same storage.
    const second = fakes(PRF, { algorithm });
    const reloaded = new WalletManager({ adapters: [second.adapter], network: "testnet", storage, logger: quiet });
    expect((await reloaded.reconnect())?.address).toBe(address);
    expect(second.seen.get).toHaveLength(0);
    const signed = await reloaded.sign(payment(address) as never);
    expect(second.seen.get).toHaveLength(1);
    expect(await Effect.runPromise(verifyTransaction(signed.tx_blob!))).toBe(true);
    expect((await Effect.runPromise(decode(signed.tx_blob!))).Account).toBe(address);
  });

  it("an adapter that derives another algorithm than the stored account does not restore, and never prompts", async () => {
    const storage = new MemoryStorageAdapter();
    await new WalletManager({ adapters: [fakes(PRF, { algorithm: "ed25519" }).adapter], network: "testnet", storage, logger: quiet }).connect("xrp-dev-passkey");
    const wrong = fakes(PRF);
    expect(await new WalletManager({ adapters: [wrong.adapter], network: "testnet", storage, logger: quiet }).reconnect()).toBeNull();
    expect(wrong.seen.get).toHaveLength(0);
    await expect(wrong.adapter.connect({ reconnect: true, address: "r", publicKey: "ED", credentialId: "AQID", algorithm: "ed25519" } as never)).rejects.toThrow(/ed25519.*secp256k1/);
  });

  it("a restore with missing fields fails instead of prompting; a restore without the flag prompts as usual", async () => {
    const { adapter, seen } = fakes(PRF);
    await expect(adapter.connect({ reconnect: true } as never)).rejects.toThrow(/nothing to restore/);
    await expect(adapter.connect({ reconnect: true, address: "r", publicKey: "02" } as never)).rejects.toThrow(/nothing to restore/);
    expect(seen.get).toHaveLength(0);
    expect((await adapter.connect()).address).toBe(ADDRESS_FOR_PRF_9);
    expect(seen.get).toHaveLength(1);
  });

  it("serializeReconnectOptions is empty until connected and again after disconnect", async () => {
    const { adapter } = fakes(PRF);
    expect(adapter.serializeReconnectOptions()).toBeUndefined();
    await adapter.connect();
    expect(adapter.serializeReconnectOptions()).toMatchObject({ reconnect: true, address: ADDRESS_FOR_PRF_9, credentialId: "AQID", algorithm: "secp256k1" });
    await adapter.disconnect();
    expect(adapter.serializeReconnectOptions()).toBeUndefined();
  });

  it("a tampered store shows a wrong address but can never produce a signature for it", async () => {
    const { adapter, seen } = fakes(PRF);
    const forged = await adapter.connect({ reconnect: true, address: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", publicKey: "02", credentialId: "AQID", algorithm: "secp256k1" } as never);
    await expect(adapter.sign(payment(forged.address))).rejects.toThrow(/not the connected account's passkey/);
    expect(seen.submit).toHaveLength(0);
  });
});

describe("registerPasskey leaves no orphan passkey", () => {
  const signalled: unknown[] = [];
  const browser = (capabilities?: Record<string, boolean>) => {
    signalled.length = 0;
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = {
      ...(capabilities ? { getClientCapabilities: async () => capabilities } : {}),
      signalUnknownCredential: async (o: unknown) => void signalled.push(o),
    };
  };
  afterEach(() => delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential);

  const cred = (results: object) => ({ rawId: new Uint8Array([1, 2, 3]).buffer, getClientExtensionResults: () => results }) as unknown as Credential;
  const withPrf = cred({ prf: { enabled: true, results: { first: PRF.slice().buffer } } });
  const enabledOnly = cred({ prf: { enabled: true } });
  const none = cred({});
  const user = { id: new Uint8Array([1]), name: "a", displayName: "a" };
  const rp = { id: "example.com", name: "xrp-dev" };
  const store = (created: Credential, asserted?: Credential) => {
    const calls = { create: 0, get: [] as any[] };
    return { calls, credentials: { create: async () => (calls.create++, created), get: async (o: unknown) => (calls.get.push(o), asserted ?? none) } };
  };

  it("a browser that reports no PRF support is refused before a passkey is created", async () => {
    browser({ "extension:prf": false });
    const { calls, credentials } = store(withPrf);
    await expect(registerPasskey({ rp, user, credentials })).rejects.toThrow(/no PRF support/);
    expect(calls.create).toBe(0);
    expect(signalled).toEqual([]);
  });

  it("an authenticator that only reports `enabled` is asked once more for the new credential", async () => {
    browser({ "extension:prf": true });
    const { calls, credentials } = store(enabledOnly, withPrf);
    const out = await registerPasskey({ rp, user, credentials });
    expect(out.account.address).toBe(ADDRESS_FOR_PRF_9);
    expect(calls.get).toHaveLength(1);
    expect(calls.get[0].publicKey.allowCredentials[0].id).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls.get[0].publicKey.rpId).toBe("example.com");
    expect(signalled).toEqual([]);
  });

  it.each([
    ["no PRF at all", none, undefined],
    ["`enabled` but no result on the follow-up", enabledOnly, none],
  ])("%s: the OS is told to drop the passkey and registration fails", async (_, created, asserted) => {
    browser();
    const { credentials } = store(created, asserted);
    await expect(registerPasskey({ rp, user, credentials })).rejects.toThrow(/PRF/);
    expect(signalled).toEqual([{ rpId: "example.com", credentialId: "AQID" }]);
  });

  it("a dismissed follow-up prompt also drops the passkey, and the user's refusal is what is reported", async () => {
    browser();
    const credentials = { create: async () => enabledOnly, get: async () => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" })) };
    await expect(registerPasskey({ rp, user, credentials })).rejects.toThrow(/dismissed/);
    expect(signalled).toHaveLength(1);
  });

  it("registers an ed25519 account whose backup restores the same address", async () => {
    const { credentials } = store(withPrf);
    const out = await registerPasskey({ rp, user, credentials, algorithm: "ed25519" });
    expect(out.account.address).not.toBe(ADDRESS_FOR_PRF_9);
    expect((await Effect.runPromise(Wallet.fromSecretNumbers(out.account.secretNumbers, { algorithm: "ed25519" }))).address).toBe(out.account.address);
  });
});

describe("every signature is its own passkey ceremony", () => {
  it("sign, signAndSubmit and signMessage each prompt once, user-verified and restricted to the connected credential", async () => {
    const { adapter, seen } = fakes(PRF);
    const { address } = await adapter.connect();
    expect(seen.get).toHaveLength(1);
    await adapter.sign(payment(address));
    expect(seen.get).toHaveLength(2);
    await adapter.signAndSubmit(payment(address));
    expect(seen.get).toHaveLength(3);
    await adapter.signMessage("hello");
    expect(seen.get).toHaveLength(4);
    for (const asked of seen.get.slice(1)) {
      expect(asked.publicKey.userVerification).toBe("required");
      expect(asked.publicKey.allowCredentials).toEqual([{ type: "public-key", id: new Uint8Array([1, 2, 3]) }]);
    }
  });

  it("signMessage signs as the connected account", async () => {
    const { adapter } = fakes(PRF);
    const { address, publicKey } = await adapter.connect();
    expect(await adapter.signMessage("hello")).toMatchObject({ message: "hello", publicKey, signerAddress: address });
  });

  it("a different passkey's PRF is refused and nothing is signed or submitted", async () => {
    const { adapter, seen } = fakes((call) => (call === 0 ? PRF : OTHER_PRF));
    const { address } = await adapter.connect();
    await expect(adapter.sign(payment(address))).rejects.toThrow(/not the connected account's passkey/);
    await expect(adapter.signAndSubmit(payment(address))).rejects.toThrow(PasskeyError);
    await expect(adapter.signMessage("hello")).rejects.toThrow(PasskeyError);
    expect(seen.submit).toEqual([]);
  });

  it("a dismissed prompt is a clear PasskeyError", async () => {
    const { adapter, credentials } = fakes(PRF);
    const { address } = await adapter.connect();
    credentials.get = async () => {
      throw new DOMException("denied", "NotAllowedError");
    };
    await expect(adapter.sign(payment(address))).rejects.toThrow(/dismissed/);
    await expect(adapter.sign(payment(address))).rejects.toBeInstanceOf(PasskeyError);
  });

  it("a rejected derivation never leaves the adapter half-connected", async () => {
    const first = fakes((call) => (call === 1 ? new Uint8Array(16) : PRF));
    const account = await first.adapter.connect();
    await expect(first.adapter.connect()).rejects.toThrow();
    expect(await first.adapter.getAccount()).toEqual(account);
    expect((await first.adapter.sign(payment(account.address))).signerAddress).toBe(account.address);

    const fresh = fakes(new Uint8Array(16));
    await expect(fresh.adapter.connect()).rejects.toThrow();
    expect(await fresh.adapter.getAccount()).toBeNull();
    await expect(fresh.adapter.signMessage("x")).rejects.toThrow(/not connected/);
  });
});

describe("refusals cannot be bypassed through the adapter", () => {
  it.each([
    [{ TransactionType: 5 }],
    [{ TransactionType: 12 }],
    [{ TransactionType: 71 }],
    [{ TransactionType: 3, SetFlag: 4 }],
    [{ TransactionType: "AccountSet", SetFlag: 4 }],
    [{ TransactionType: "SetRegularKey" }],
  ])("never prompts or signs %o", async (extra) => {
    const { adapter, seen } = fakes(PRF);
    const { address } = await adapter.connect();
    await expect(adapter.sign({ ...payment(address), ...extra } as unknown as SubmittableTransaction)).rejects.toThrow(/署名しません/);
    expect(seen.get).toHaveLength(1);
    expect(seen.submit).toEqual([]);
  });

  it("a getter whose value changes between reads is signed as what was read once", async () => {
    const { adapter } = fakes(PRF);
    const { address } = await adapter.connect();
    let reads = 0;
    const tx = payment(address);
    Object.defineProperty(tx, "TransactionType", { enumerable: true, get: () => (reads++ === 0 ? "Payment" : "SetRegularKey") });
    const signed = await adapter.sign(tx);
    expect((await Effect.runPromise(decode(signed.tx_blob!))).TransactionType).toBe("Payment");
  });

  it("ordinary Payment still signs", async () => {
    const { adapter } = fakes(PRF);
    const { address } = await adapter.connect();
    expect(await Effect.runPromise(verifyTransaction((await adapter.sign(payment(address))).tx_blob!))).toBe(true);
  });
});

describe("account binding", () => {
  it("sets a missing Account to the connected address", async () => {
    const { adapter } = fakes(PRF);
    const { address } = await adapter.connect();
    const { Account, ...bare } = payment(address);
    const signed = await adapter.sign(bare as SubmittableTransaction);
    expect(signed.tx_json?.Account).toBe(address);
  });

  it("rejects another Account before any prompt", async () => {
    const { adapter, seen } = fakes(PRF);
    await adapter.connect();
    await expect(adapter.sign(payment("rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"))).rejects.toThrow(/Account/);
    expect(seen.get).toHaveLength(1);
  });
});

describe("signAndSubmit failures keep the hash", () => {
  const failing = (fail: (method: string) => Effect.Effect<unknown, ClientError>) => {
    const client: RpcClient = { request: <T>(method: string) => fail(method) as Effect.Effect<T, ClientError> };
    return new PasskeyAdapter({ network, client, credentials: fakes(PRF).credentials });
  };

  it("a submit timeout carries the signed hash and blob and tells the caller to look it up", async () => {
    const adapter = failing(() => Effect.fail(new ClientError({ reason: "timeout", message: "timed out" })));
    const { address } = await adapter.connect();
    const error = await adapter.signAndSubmit(payment(address)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PasskeyError);
    const { hash, tx_blob, message } = error as PasskeyError;
    expect(tx_blob).toBeDefined();
    expect(hash).toBe(await Effect.runPromise(hashTransaction(tx_blob!)));
    expect(message).toContain(hash!);
    expect(message).toMatch(/before signing again/);
  });

  it("a tem/tef/tel rejection carries the hash too", async () => {
    const adapter = failing(() => Effect.succeed({ engine_result: "tefPAST_SEQ", engine_result_message: "past" }));
    const { address } = await adapter.connect();
    const error = (await adapter.signAndSubmit(payment(address)).catch((e: unknown) => e)) as PasskeyError;
    expect(error.message).toMatch(/tefPAST_SEQ/);
    expect(error.hash).toHaveLength(64);
  });
});
