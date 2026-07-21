# LAST-targeted NotArb runner

This project follows the observed route of one address, not the whole chain:

1. `grpc-last.mjs` watches `LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9` through Yellowstone gRPC.
2. `last-route-to-notarb.mjs` validates the DEX-owned pool-state accounts from those LAST transactions through the same 82 read-RPC tunnel and writes a NotArb `markets_file` plus a route-specific ALT file.
3. The NotArb dry-run loads only that generated group. The global `[notarb_markets]` stream scanner is disabled.

No other project is used.

## 82 network topology

The 82 host is reached through `82.23.138.51` with two local SSH forwards:

```powershell
# Yellowstone LAST observer
ssh -i C:\Users\test\.ssh\id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -N -L 127.0.0.1:18100:82.39.215.201:10000 root@82.23.138.51

# Required read-only Solana RPC for account and ALT reads
ssh -i C:\Users\test\.ssh\id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -N -L 127.0.0.1:18899:82.39.215.201:8899 root@82.23.138.51
```

`18100` is the only market-discovery source. `18899` is a required read RPC;
it is not a transaction sender.

## LAST observer

```powershell
npm install
npm run listen:last:grpc
```

`run-grpc-last.cmd` is the equivalent long-running Windows wrapper; it writes
the canonical `last-grpc.stdout.log` and `last-grpc.stderr.log` files.

`No arbitrage profit found` is still useful arbitrage-intent evidence. It
captures the target mint, intended DEX program(s), and ALT use; it has a
`not_executed` price status rather than a fabricated realized fill price.

## LAST route to NotArb markets bridge

Run this alongside the observer:

```powershell
npm run extract:last:markets
```

On Windows, `run-last-route-to-notarb.cmd` is the same read-only bridge in a
long-running wrapper; it writes `last-route-to-notarb.*.log` and does
not start NotArb or a transaction sender.

It emits ignored runtime files:

- `last-target-route.json` — the LAST signature, target mint, candidate DEXes,
  and validated pool-state evidence.
- `last-target-markets.json` — a NotArb `markets_file` containing only direct
  pool states from the observed LAST route.
- `last-target-lookup-tables.txt` contains only the currently readable public
  ALT IDs from that selected LAST route, not an accumulated historical ALT
  list.
- `last-target-status.json` records whether the newest LAST route is active or
  safely held, plus the generation and reason. It is generated locally and
  ignored by Git.

### Automatic route rotation

There is no fixed target mint in the NotArb config. When LAST changes mint,
validated pool set, DEX set, or ALT selection, the gRPC observer writes a new
route snapshot. The bridge normalizes account ordering, validates the new
pool-state accounts and ALT tables through `127.0.0.1:18899`, then atomically
replaces each target file only when the complete route is usable. NotArb polls
the market file every 15 seconds and the ALT file every 30 seconds.

The bridge is deliberately fail-closed: an unsupported candidate DEX, an
unreadable route ALT, or fewer than two validated pools leaves the prior target
group in place and writes `status: "held"` with the reason instead of loading
unverified accounts. Current automatic pool layouts cover Pump.fun AMM,
Meteora DLMM/CPMM, and Raydium AMM v4. A newly observed protocol is surfaced
in `unsupportedCandidateDexPrograms`; it must receive an explicit verified
pool layout before it can be loaded.

The runtime source of truth is always the ignored `last-target-route.json` and
`last-target-status.json`, not the illustrative addresses below.

One historical route example selected target mint
`5UoWzex7rVky9ZSHGQXQgAPsm8jDZQMFBGqch8L7pump` with one direct WSOL group:

- Pump.fun AMM: `k1F3d5WQAtbrzkYtJuV7FJKcWuE72n3Rf4wWfGvy2kv`
- Meteora DLMM: `3MmyGFt8PLggposcCredKePikHYof34LQP6d5jBHcZua`
- Meteora DLMM: `4d8Vp7UdpkjG8aYKHPsnzjXSaxNhwHomrPD8Q612ixek`

That historical route carried these three ALT IDs:
`GFcivC9XqVNS5pmEgZ8sgUL8b2JPbVyPYi5DzGBJPkZW`,
`GrYRNa8tyCJ34t3Q9VzWwtc8YG7RSwcarYUt4mPyiDt5`, and
`DshhssRRimFGxsQcWrfMr8yz9J6ux1zmxXrJqx6jmA5p`.
The bridge checks each table through the local read-RPC before loading it. At
the time this example was recorded, the first two were valid and went into
`last-target-lookup-tables.txt`; `Dshh…` is retained as route evidence but is
currently absent, so it is reported under `rejectedLookupTables` in
`last-target-route.json` and is not sent to NotArb.

## Native NotArb onchain-bot dry run

Copy the safe template locally, set an unfunded/test keypair path, keep the
bridge running, then start NotArb:

```powershell
Copy-Item .\notarb-last-grpc-dryrun.example.toml .\notarb-last-grpc-dryrun.toml
npm run extract:last:markets
& "$env:LOCALAPPDATA\notarb\bin\notarb.bat" onchain-bot .\notarb-last-grpc-dryrun.toml
```

`run-notarb-last-target-dryrun.cmd` is a Windows wrapper for that last command.
It first checks the local config still has the target-only/no-send controls,
then writes the canonical `notarb-last-target-dryrun.*.log` files used by the
monitor.

The template is deliberately non-live:

- the global `[notarb_markets]` scanner is disabled;
- `[[markets_file]]` points only to `last-target-markets.json`;
- `[[lookup_tables_file]]` points only to `last-target-lookup-tables.txt`;
- no `[[sender]]` exists;
- every swap strategy is disabled;
- `transaction_executor.threads = 0`;
- no durable nonce pool exists;
- WSOL unwrapper is off.

## Runtime evidence

Git intentionally ignores the high-frequency runtime evidence:

- `last-grpc-events.jsonl` — full route/ALT/fill/failure snapshots;
- `last-grpc-summaries.jsonl` — minute-level high-frequency summaries;
- `last-grpc-alt-uses.jsonl` — selected ALT addresses;
- `last-grpc-active-lookup-tables.txt` — public ALT IDs safe to share;
- `last-target-route.json` / `last-target-markets.json` — target-only route
  evidence and the generated NotArb markets file.
- `last-target-lookup-tables.txt` — the exact ALT set loaded with that target
  market group.

See [PLAN.md](PLAN.md) before changing any safety control. For a clean-machine
setup from `git clone` through a verified dry run, follow [HANDOFF.md](HANDOFF.md).

## Historical diagnostics

`watch-last.mjs` and `stream-last.mjs` are retained as earlier diagnostics and
evidence helpers. They are not part of the active runner and must not replace
the Yellowstone gRPC path above. `LAST-findings.md` and `lookup-tables.txt`
contain public historical observations only; no wallet or credential is stored
in this repository.
