import raw from "./codec/definitions.json" with { type: "json" };

const fields = raw.FIELDS as readonly unknown[];

/**
 * Which ledger this package encodes. `capturedOn` is the day `definitions.json` was taken from
 * `definitionsSource` (`server_definitions`). Change it in the same commit that regenerates the JSON.
 * The server software is xrpld; the repository is still XRPLF/rippled.
 */
export const XRPL_PROTOCOL = {
  server: "xrpld",
  repository: "XRPLF/rippled",
  definitionsSource: "https://s1.ripple.com:51234/",
  definitionsMethod: "server_definitions",
  capturedOn: "2026-10-11",
} as const;

/** Sizes of the five tables in the snapshot. Derived, so they cannot drift from the JSON. */
export const XRPL_DEFINITION_COUNTS = {
  fields: fields.length,
  transactionTypes: Object.keys(raw.TRANSACTION_TYPES).length,
  ledgerEntryTypes: Object.keys(raw.LEDGER_ENTRY_TYPES).length,
  transactionResults: Object.keys(raw.TRANSACTION_RESULTS).length,
} as const;
