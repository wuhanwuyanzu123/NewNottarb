# LAST + NotArb gRPC runner

This project has two connected pieces:

1. `grpc-last.mjs` observes `LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9` through Yellowstone gRPC.
2. NotArb's native `[notarb_markets]` module consumes the same Yellowstone stream to discover markets, collect fee data, and select market groups for the onchain bot.

No other project is used.

## 82 network topology

The 82 host is reached through `82.23.138.51` with two local SSH forwards:

```powershell
# Yellowstone market discovery
ssh -i C:\Users\test\.ssh\id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -N -L 127.0.0.1:18100:82.39.215.201:10000 root@82.23.138.51

# Required read-only Solana RPC for blockhash, market account, and ALT reads
ssh -i C:\Users\test\.ssh\id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -N -L 127.0.0.1:18899:82.39.215.201:8899 root@82.23.138.51
```

`18100` is the only market-discovery source. `18899` is a required read RPC; it is not a transaction sender.

## LAST observer

```powershell
npm install
npm run listen:last:grpc
```

`No arbitrage profit found` is retained as useful arbitrage-intent evidence:

- target mint(s);
- DEX programs intended by the evaluated route;
- ALT tables and loaded addresses;
- a `not_executed` price status rather than a fabricated realized fill price.

Runtime evidence is intentionally ignored by Git:

- `last-grpc-events.jsonl` — full snapshots on a route/ALT/fill/failure change;
- `last-grpc-summaries.jsonl` — minute-level high-frequency summaries;
- `last-grpc-alt-uses.jsonl` — selected ALT addresses;
- `last-grpc-active-lookup-tables.txt` — public ALT IDs safe to share.

## Native NotArb onchain-bot dry run

Copy the safe template locally, set an unfunded/test keypair path, then run:

```powershell
Copy-Item .\notarb-last-grpc-dryrun.example.toml .\notarb-last-grpc-dryrun.toml
& "$env:LOCALAPPDATA\notarb\bin\notarb.bat" onchain-bot .\notarb-last-grpc-dryrun.toml
```

The template is deliberately non-live:

- `notarb_markets.dry_run = true`;
- no `[[sender]]` exists;
- the strategy is disabled by default;
- `transaction_executor.threads = 0`;
- no durable nonce pool exists;
- WSOL unwrapper is off.

See [PLAN.md](PLAN.md) before changing any of those controls.

For a clean-machine setup from `git clone` through a verified dry run, follow
[HANDOFF.md](HANDOFF.md).

## Historical diagnostics

`watch-last.mjs` and `stream-last.mjs` are retained as earlier diagnostics and
evidence helpers. They are not part of the active runner and must not replace
the Yellowstone gRPC path above. `LAST-findings.md` and `lookup-tables.txt`
contain public historical observations only; no wallet or credential is stored
in this repository.
