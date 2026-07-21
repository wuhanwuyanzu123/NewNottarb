# LAST-targeted NotArb runner

This project follows the observed route of one address, not the whole chain:

1. `grpc-last.mjs` watches `LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9` through Yellowstone gRPC.
2. `last-route-to-notarb.mjs` validates the DEX-owned pool-state accounts from those LAST transactions through the same 82 read-RPC tunnel and writes a NotArb `markets_file`.
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

`No arbitrage profit found` is still useful arbitrage-intent evidence. It
captures the target mint, intended DEX program(s), and ALT use; it has a
`not_executed` price status rather than a fabricated realized fill price.

## LAST route to NotArb markets bridge

Run this alongside the observer:

```powershell
npm run extract:last:markets
```

It emits ignored runtime files:

- `last-target-route.json` — the LAST signature, target mint, candidate DEXes,
  and validated pool-state evidence.
- `last-target-markets.json` — a NotArb `markets_file` containing only direct
  pool states from the observed LAST route.

For the currently observed route, the bridge selected target mint
`5UoWzex7rVky9ZSHGQXQgAPsm8jDZQMFBGqch8L7pump` with one direct WSOL group:

- Pump.fun AMM: `k1F3d5WQAtbrzkYtJuV7FJKcWuE72n3Rf4wWfGvy2kv`
- Meteora DLMM: `3MmyGFt8PLggposcCredKePikHYof34LQP6d5jBHcZua`
- Meteora DLMM: `4d8Vp7UdpkjG8aYKHPsnzjXSaxNhwHomrPD8Q612ixek`

## Native NotArb onchain-bot dry run

Copy the safe template locally, set an unfunded/test keypair path, keep the
bridge running, then start NotArb:

```powershell
Copy-Item .\notarb-last-grpc-dryrun.example.toml .\notarb-last-grpc-dryrun.toml
npm run extract:last:markets
& "$env:LOCALAPPDATA\notarb\bin\notarb.bat" onchain-bot .\notarb-last-grpc-dryrun.toml
```

The template is deliberately non-live:

- the global `[notarb_markets]` scanner is disabled;
- `[[markets_file]]` points only to `last-target-markets.json`;
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

See [PLAN.md](PLAN.md) before changing any safety control. For a clean-machine
setup from `git clone` through a verified dry run, follow [HANDOFF.md](HANDOFF.md).

## Historical diagnostics

`watch-last.mjs` and `stream-last.mjs` are retained as earlier diagnostics and
evidence helpers. They are not part of the active runner and must not replace
the Yellowstone gRPC path above. `LAST-findings.md` and `lookup-tables.txt`
contain public historical observations only; no wallet or credential is stored
in this repository.
