# Status and remaining work

## Completed

- A standalone Yellowstone gRPC observer tracks `LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9` through the 82 endpoint.
- The observer keeps no-profit NotArb checks as arbitrage-intent evidence: mint, intended DEX programs, ALT tables, and a distinct `not_executed` price status.
- The observed public ALT IDs are stored in `last-grpc-active-lookup-tables.txt`.
- `last-route-to-notarb.mjs` converts LAST gRPC evidence into an exact NotArb `markets_file` and route-specific ALT file; it verifies DEX account owner/pool-state size and excludes unreadable ALT accounts through the 82 read-RPC tunnel before using an address.
- The observer normalizes route fingerprints to suppress account-order noise while retaining writable route accounts, and the bridge switches generations only when the validated mint/DEX/pool/ALT set actually changes.
- The active target is intentionally dynamic. Read `last-target-route.json` together with `last-target-status.json` rather than hard-coding a historical mint or pool group.
- NotArb `onchain-bot` now loads only that target-specific `markets_file`; the global `[notarb_markets]` scan is disabled and no transaction is sent.

## Current topology

```text
82.39.215.201:10000 Yellowstone gRPC
  -> SSH jump 82.23.138.51
  -> 127.0.0.1:18100
  -> grpc-last.mjs
  -> last-route-to-notarb.mjs
  -> last-target-markets.json
  -> last-target-lookup-tables.txt
  -> last-target-status.json (active/held)
  -> NotArb [[markets_file]]
  -> NotArb [[lookup_tables_file]]

82.39.215.201:8899 Solana JSON-RPC (account/blockhash/ALT reads)
  -> SSH jump 82.23.138.51
  -> 127.0.0.1:18899
  -> NotArb read-only loaders
```

## Evidence boundary

- A `No arbitrage profit found` transaction is route-intent evidence only. It
  can supply candidate mint/DEX/pool/ALT inputs for dry-run, but it is not an
  executed DEX CPI and does not supply a realized price.
- Always inspect `last-target-route.json.source.observedAt` before treating the
  current group as fresh. The bridge deliberately keeps the last valid group
  when no newer LAST route has arrived.
- `observedLookupTables` records every ALT in the LAST transaction;
  `selectedLookupTables` is the currently readable subset loaded by NotArb;
  `rejectedLookupTables` is evidence only and is never loaded.
- `last-target-status.json` is the authoritative automatic-follow result. A
  `held` result keeps the previous target group and reports unsupported DEX,
  unreadable ALT, insufficient validated pools, or a stale observer; it never
  replaces a known group with arbitrary account keys.

## Intentionally unfinished before live trading

1. Provide a dedicated funded bot wallet path. No wallet key is committed to this repository.
2. Provide a full indexed Solana RPC for `[token_accounts_checker]`. The current 82 `:8899` node serves market/blockhash/ALT reads but does not expose arbitrary-wallet token-account secondary indexes.
3. Decide explicit risk controls: which routes/DEXes to permit, maximum priority fee, maximum tip, cooldown, and maximum daily loss/spend.
4. Add a sender only after those limits are agreed. The committed template has no `[[sender]]`, `dry_run = true`, a disabled strategy, and no durable nonce pool.
5. If durable nonces are wanted, create nonce accounts owned by the dedicated bot wallet; never reuse the watched wallet's nonce accounts.

## Safe validation command

```powershell
Copy-Item .\notarb-last-grpc-dryrun.example.toml .\notarb-last-grpc-dryrun.toml
# Edit only the local copy to point at a test/unfunded keypair.
npm run extract:last:markets
& "$env:LOCALAPPDATA\notarb\bin\notarb.bat" onchain-bot .\notarb-last-grpc-dryrun.toml
```
