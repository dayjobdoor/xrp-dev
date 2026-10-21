# Security policy

`xrp-dev` handles keys and signs transactions (`xrp-dev/wallet`). It has not been independently audited as a whole.

## Supported versions

Only the latest `alpha` release (see `npm view xrp-dev dist-tags`). Fixes ship as a new prerelease.

## Reporting a vulnerability

Report privately through [GitHub private vulnerability reporting](https://github.com/dayjobdoor/xrp-dev/security/advisories/new). Do not open a public issue or PR. Include the affected entry point (`xrp-dev/<subpath>`), version and a reproduction. Expect an acknowledgement within a week.

In scope: key handling, signing and the codec (wrong bytes signed), the MCP server's "never signs" boundary, the x402 gate (unpaid delivery, replay), `xrp-dev/auth` challenge verification.
