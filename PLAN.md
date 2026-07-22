# Status and remaining work

## Completed

- A standalone Yellowstone gRPC observer tracks `LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9` through the 82 endpoint.
- The observer keeps no-profit NotArb checks as arbitrage-intent evidence: mint, intended DEX programs, ALT tables, and a distinct `not_executed` price status.
- The observed public ALT IDs are stored in `last-grpc-active-lookup-tables.txt`.
- `last-route-to-notarb.mjs` converts LAST gRPC evidence into an exact NotArb `markets_file` and route-specific ALT file; it verifies DEX account owner/pool-state size and excludes unreadable ALT accounts through the 82 read-RPC tunnel before using an address.
- The observer normalizes route fingerprints to suppress account-order noise while retaining writable route accounts, and the bridge switches generations only when the validated mint/DEX/pool/ALT set actually changes.
- The active target is intentionally dynamic. Read `last-target-route.json` together with `last-target-status.json` rather than hard-coding a historical mint or pool group.
- NotArb `onchain-bot` loads only that target-specific `markets_file`; the global `[notarb_markets]` scan is disabled. The dry-run profile keeps all sender and executor paths off.
- `last-notarb-supervisor.mjs` owns the lifecycle for both the dry-run and live profiles: it starts one child only after current LAST route activity is bridge-validated, and stops that child after 30 seconds of quiet activity or on any held/stale/mismatched local evidence. The observer records dedicated `lastRoute*` activity fields so unrelated LAST transactions cannot start the child.
- The direct target-runner wrapper is supervisor-internal and receives the same explicitly passed TOML that the supervisor validates; it rejects a direct launch rather than leaving a quiet-period bot running.
- `notarb-last-grpc-live.example.toml`, `assert-last-live.mjs`, and the live wrappers provide a local ignored ordinary-Helius-RPC sender profile with `transaction_executor.threads = 0` (NotArb v1.1.2's dynamic cached executor thread pool), an enabled SOL strategy, and `flash_loan = true`; the sender/swap execution path remains enabled.
- `rust/last-route-bridge` is a compiled Linux route bridge. It owns the compact route lease, validates the same target-only pools/ALTs through `LAST_READ_RPC_URL`, includes Orca Whirlpool's 653-byte pool layout, and publishes `held/no_route_evidence` without an RPC call before the first qualified event.
- When the validated market generation is unchanged but a new LAST route check has different ALT indexes or writable account metas, the Rust bridge refreshes the route-evidence fingerprint before publishing the renewed active lease. This keeps the observer, route record, and supervisor coherent without creating a duplicate generation.
- The supervisor uses local status/markets file mtimes, not WSL payload timestamps, for a 20-second markets heartbeat and activity freshness; `held` and stale route status still end the child lease immediately.
- A lifecycle activation key combines generation and LAST signature. The supervisor never relaunches a stopped/failed child for that same key after a transient publication gap; the next fresh validated signature is required for another child.
- `npm run test:last:live-config` verifies the live ordinary-RPC contract offline: one `[[spam_rpc]]` plus `spam_senders`, a matching indexed Helius token-account checker, and the four direct 82 reader RPC roles. `npm run test:last:supervisor` verifies the lifecycle entirely offline with a fake child: start once, tolerate continuous activity without duplication, survive the bridge generation publication window, stop on quiet, and restart on the next activity. `npm run test:last:bridge` verifies that a partial JSONL tail and a mint-only/no-DEX event never become a route.
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

82.39.215.201:8899 Solana JSON-RPC (account/blockhash/ALT reads)
  -> 82.23.138.51 Rust validation and NotArb blockhash, price, market, and ALT reads

Helius ordinary JSON-RPC
  -> 82.23.138.51 [[spam_rpc]] spam1 transaction sending and token-account checks
```

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
  can supply candidate mint/DEX/pool/ALT inputs for dry-run, but it is not an
  executed DEX CPI and does not supply a realized price.
- A retained historical group is evidence only. The supervisor treats it as
  ineligible until `.last-grpc-state.json.lastRouteObservedAt` is fresh and the
  bridge publishes the same activity signature as `active`.
- `observedLookupTables` records every ALT in the LAST transaction;
  `selectedLookupTables` is the currently readable subset loaded by NotArb;
  `rejectedLookupTables` is evidence only and is never loaded.
- `last-target-status.json` is the authoritative automatic-follow result. A
  `held` result keeps the previous target group and reports unsupported DEX,
  unreadable ALT, insufficient validated pools, or a stale observer; it never
  replaces a known group with arbitrary account keys.

## Live profile inputs

1. Set the ignored server `/etc/notarb-last/notarb-last-grpc-live.toml` to the bot keypair path. No wallet key is committed to this repository.
2. Set `[token_accounts_checker].rpc_url` to exactly match the indexed Helius `[[spam_rpc]].url`. The 82 node does not expose the bot wallet through token-account secondary indexes; blockhash, price, market, and ALT reads stay on 82.
3. The tracked NotArb v1.1.2 ordinary-RPC profile uses one Helius `[[spam_rpc]]` sender and `spam_senders = [{ rpc = "spam1", ... }]` (not `[[sender]]` / `senders`), omits `require_profit`, caps priority fee at 25,000 lamports, uses no Jito tip, and has a 1,000 ms cooldown. Adjust the ignored local copy if different runtime limits are desired.
4. Durable nonces remain optional. When used, place only nonce accounts controlled by the configured bot wallet in a `[[nonce_pool]]`.

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
ignored server config, run `assert-last-live.mjs` with
`LAST_READ_RPC_URL=http://82.39.215.201:8899`, and enable the server supervisor
after stopping any prior live runtime.
