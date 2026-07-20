# Status and remaining work

## Completed

- A standalone Yellowstone gRPC observer tracks `LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9` through the 82 endpoint.
- The observer keeps no-profit NotArb checks as arbitrage-intent evidence: mint, intended DEX programs, ALT tables, and a distinct `not_executed` price status.
- The observed public ALT IDs are stored in `last-grpc-active-lookup-tables.txt`.
- NotArb `onchain-bot` is running in a native `[notarb_markets]` dry-run mode against the same Yellowstone gRPC stream.
- Native market discovery has confirmed the observed `5UoWzex7rVky9ZSHGQXQgAPsm8jDZQMFBGqch8L7pump` route as a NotArb target; it is discovering markets and ALTs without sending a transaction.

## Current topology

```text
82.39.215.201:10000 Yellowstone gRPC
  -> SSH jump 82.23.138.51
  -> 127.0.0.1:18100
  -> grpc-last.mjs and [notarb_markets]

82.39.215.201:8899 Solana JSON-RPC (account/blockhash/ALT reads)
  -> SSH jump 82.23.138.51
  -> 127.0.0.1:18899
  -> NotArb read-only loaders
```

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
& "$env:LOCALAPPDATA\notarb\bin\notarb.bat" onchain-bot .\notarb-last-grpc-dryrun.toml
```
