// Preloaded into the README snippets (test/readme.test.ts): a rippled that answers every JSON-RPC call offline, so an example
// that talks to "testnet" runs as written.
const answers: Record<string, object> = {
  ping: {},
  fee: { drops: { open_ledger_fee: "10" }, ledger_current_index: 1000 },
  ledger_current: { ledger_current_index: 1000 },
  account_info: { account_data: { Sequence: 5 } },
  submit: { engine_result: "tesSUCCESS", engine_result_message: "ok", applied: true },
  ledger: { ledger_index: 1001 },
  tx: { validated: true, meta: { TransactionResult: "tesSUCCESS" } },
};

globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const { method } = JSON.parse(String(init?.body)) as { method: string };
  return Response.json({ result: method in answers ? { status: "success", ...answers[method] } : { status: "error", error: "unknownCmd", error_message: `unexpected ${method}` } });
}) as typeof fetch;
