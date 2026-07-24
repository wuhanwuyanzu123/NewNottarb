# Status and remaining work

## Completed

- A standalone Yellowstone gRPC observer tracks `LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9` through the 82 endpoint.
- The observer keeps no-profit NotArb checks as arbitrage-intent evidence: mint, intended DEX programs, ALT tables, and a distinct `not_executed` price status.
- The observed public ALT IDs are stored in `last-grpc-active-lookup-tables.txt`.
- `last-route-to-notarb.mjs` converts LAST gRPC evidence into an exact NotArb `markets_file` and route-specific ALT file; it derives market-state addresses from the outer NA instruction's DEX-program offsets, verifies expected owner/layout, and excludes unreadable ALT accounts through the configured read RPC before using an address. The 82 read-RPC tunnel remains a legacy local-development option only.
- The observer normalizes route fingerprints to suppress account-order noise while retaining writable route accounts, and the bridge switches generations only when the validated mint/DEX/pool/ALT set actually changes.
- The active target is intentionally dynamic. Read `last-target-route.json` together with `last-target-status.json` rather than hard-coding a historical mint or pool group.
- NotArb `onchain-bot` loads only that target-specific `markets_file`; the global `[notarb_markets]` scan is disabled. The dry-run profile keeps all sender and executor paths off.
- `last-notarb-supervisor.mjs` owns the lifecycle for both the dry-run and live profiles: it starts one child only after current LAST route activity is bridge-validated, and stops that child after 30 seconds of quiet activity or on any held/stale/mismatched local evidence. The observer records dedicated `lastRoute*` activity fields so unrelated LAST transactions cannot start the child.
- The direct target-runner wrapper is supervisor-internal and receives the same explicitly passed TOML that the supervisor validates; it rejects a direct launch rather than leaving a quiet-period bot running.
- `notarb-last-grpc-live.example.toml`, `assert-last-live.mjs`, and the live wrappers provide a local ignored ordinary-RPC sender profile with `transaction_executor.threads = 0` (NotArb's dynamic cached executor thread pool), one enabled `[[sender]]` selected through `[[swap.strategy]].senders`, an enabled SOL strategy, and `flash_loan = true`; the sender/swap execution path remains enabled.
- Each Linux live child starts a detached, best-effort `getBalance` diagnostic which derives the fee-payer public key from the local configured keypair and uses only `[blockhash_updater].rpc_url`. A zero balance produces a structured warning without delaying or blocking NotArb.
- `rust/last-route-bridge` is a compiled Linux route bridge. It owns the compact route lease, validates each outer NA instruction's ordered market-state group and ALTs through `LAST_READ_RPC_URL`, includes Orca Whirlpool's 653-byte market layout, and publishes `held/no_route_evidence` without an RPC call before the first qualified event.
- When the validated market generation is unchanged but a new LAST route check has different ALT indexes or writable account metas, the Rust bridge refreshes the route-evidence fingerprint before publishing the renewed active lease. This keeps the observer, route record, and supervisor coherent without creating a duplicate generation.
- The supervisor uses local status/markets file mtimes, not WSL payload timestamps, for a 20-second markets heartbeat and activity freshness; `held` and stale route status still end the child lease immediately.
- A lifecycle activation key combines generation and LAST signature. The supervisor never relaunches a stopped/failed child for that same key after a transient publication gap; the next fresh validated signature is required for another child.
- `npm run test:last:live-config` verifies the live ordinary-RPC contract offline: one enabled `[[sender]]` plus `senders`, a matching indexed token-account checker, and four core reader roles fixed to `http://82.39.215.201:8899`. It rejects the old `[[spam_rpc]]` / `spam_senders` path, which did not resolve an enabled onchain-bot sender. `npm run test:last:supervisor` verifies the lifecycle entirely offline with a fake child: start once, tolerate continuous activity without duplication, survive the bridge generation publication window, stop on quiet, and restart on the next activity. `npm run test:last:bridge` verifies that a partial JSONL tail and a mint-only/no-DEX event never become a route.
- The deployment target is `root@82.23.138.51`: GitHub Actions builds the compiled Linux bridge and deploys immutable releases with the two systemd unit templates. Local Windows/WSL runners remain development-only.

## Current topology

```text
82.39.215.201:10000 Yellowstone gRPC
  -> 82.23.138.51 /opt/notarb-last/current/grpc-last.mjs
  -> /var/lib/notarb-last/runtime-state/last-grpc-events.jsonl
  -> compiled rust/last-route-bridge
  -> last-target-markets.json
  -> last-target-lookup-tables.txt
  -> last-target-status.json (active/held)
  -> last-notarb-supervisor.mjs (fresh activity lease)
  -> target-only NotArb child while lease is active
  -> NotArb [[markets_file]] / [[lookup_tables_file]]

82.39.215.201:8899 Solana JSON-RPC (core read RPC)
  -> systemd-pinned `LAST_READ_RPC_URL` for Rust validation
  -> 82.23.138.51 NotArb blockhash, price, market, and ALT reads

private live TOML Helius endpoint
  -> 82.23.138.51 enabled [[sender]] spam1 transaction sending and token-account checks
```

The production pipeline unit pins `LAST_READ_RPC_URL` to
`http://82.39.215.201:8899`; the private `[blockhash_updater]` section is
asserted to the same value. A standalone local wrapper uses that TOML section
only when the environment value is absent, and neither form puts the endpoint
in the Rust command line.
The private sender URL is absent from commands, logs, and tracked
documentation; it is used only by the token-account checker and the enabled
ordinary-RPC `spam1` sender.

The Linux deployment process path is:

```text
systemd: notarb-last-pipeline.service
  -> Node gRPC observer (--no-state)
  -> last-grpc-events.jsonl
  -> compiled rust/last-route-bridge
  -> .last-grpc-state.json + target markets/ALT/status
systemd: notarb-last-live-supervisor.service
  -> activity-gated live supervisor
  -> NotArb child only during fresh active lease
```

## Evidence boundary

- A `No arbitrage profit found` transaction is route-intent evidence only. It
  can supply candidate mint/DEX/market/ALT inputs for dry-run, but it is not an
  executed DEX CPI and does not supply a realized price.
- A retained historical group is evidence only. The supervisor treats it as
  ineligible until `.last-grpc-state.json.lastRouteObservedAt` is fresh and the
  bridge publishes the same activity signature as `active`.
- `observedLookupTables` records every ALT in the LAST transaction;
  `selectedLookupTables` is the currently readable subset loaded by NotArb;
  `rejectedLookupTables` is evidence only and is never loaded.
- `last-target-status.json` is the authoritative automatic-follow result. A
  `held` result keeps the previous target group and reports unsupported DEX,
  unreadable ALT, insufficient validated markets, or a stale observer; it never
  replaces a known group with arbitrary account keys.

## Live profile inputs

1. Set the ignored server `/etc/notarb-last/notarb-last-grpc-live.toml` to the bot keypair path. No wallet key is committed to this repository.
2. Keep `[blockhash_updater].rpc_url`, `[price_updater].rpc_url`, `[market_loader].rpc_url`, and `[lookup_table_loader].rpc_url` fixed to `http://82.39.215.201:8899`. Set `[token_accounts_checker].rpc_url` and the `url` in `[[sender]]` to the same private indexed endpoint. The 82 reader lacks the bot wallet's required token-account secondary index, so it is not used for the token-account checker or sender.
3. The tracked onchain-bot ordinary-RPC profile uses exactly one enabled `[[sender]]` with `id = "spam1"` and `[[swap.strategy]].senders = [{ id = "spam1", max_retries = 0 }]`. It omits `require_profit`, uses a 563–3,593 µlamports/CU range through matching 208–1,326-lamport fee bounds, uses no Jito tip, and has a 1,000 ms cooldown. `[[spam_rpc]]` and `spam_senders` are a different path and must be absent from this profile.
4. Migration check: the deployment's `migrate-last-live-config.mjs` preserves the private endpoint while replacing `[[spam_rpc]]` with `[[sender]]`, renaming `spam_senders` to `senders`, and changing the inner selector from `rpc` to `id`. Run it, then run `assert-last-live.mjs`, against the private TOML before restarting the service. If the child log says `There are no enabled [[sender]] configs with id: spam1`, the selected strategy still has no matching enabled `[[sender]]`.
5. Durable nonces remain optional. When used, place only nonce accounts controlled by the configured bot wallet in a `[[nonce_pool]]`.

## Safe validation command

```powershell
Copy-Item .\notarb-last-grpc-dryrun.example.toml .\notarb-last-grpc-dryrun.toml
# Edit only the local copy to point at a test/unfunded keypair.
npm run extract:last:markets
npm run test:last:supervisor
npm run test:last:bridge
npm run supervise:last:dryrun
```

For the deployed live profile, copy `notarb-last-grpc-live.example.toml` to the
ignored server config, run `assert-last-live.mjs` without placing the reader
endpoint on the command line (it derives the shared value from
`[blockhash_updater]`), and enable the server supervisor after stopping any
prior live runtime. During a fresh active lease, inspect a new interval of
`notarb-last-target-live.stdout.log` and `.stderr.log`: a loaded market group
proves route wiring only; an explicit returned transaction signature is the
runtime proof of a submitted transaction.
