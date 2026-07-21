# LAST-targeted NotArb runner

This project follows the observed route of one address, not the whole chain:

1. `grpc-last.mjs` watches `LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9` through Yellowstone gRPC.
2. `last-route-to-notarb.mjs` validates the DEX-owned pool-state accounts from those LAST transactions through the same 82 read-RPC tunnel and writes a NotArb `markets_file` plus a route-specific ALT file.
3. `last-notarb-supervisor.mjs` starts the selected target-only NotArb profile
   only during a fresh, bridge-validated LAST activity window, and stops its
   own child tree when the window closes. The global `[notarb_markets]` stream
   scanner is disabled.

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
npm ci --ignore-scripts
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

A retained group is evidence only while the watcher is quiet. The lifecycle
supervisor requires fresh route activity plus a matching `active` bridge status
before it starts its child; `held` immediately ends that child activity.

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

## Activity-gated NotArb dry run

Copy the safe template locally, set an unfunded/test keypair path, keep the
observer and bridge running, then start the lifecycle supervisor:

```powershell
Copy-Item .\notarb-last-grpc-dryrun.example.toml .\notarb-last-grpc-dryrun.toml
npm run supervise:last:dryrun
```

`run-last-notarb-supervisor.cmd` is the Windows wrapper. It reads only local
observer/bridge evidence and uses `run-notarb-last-target-dryrun.cmd` for a
child start. That child wrapper still checks the local target-only/no-send
config before it launches NotArb and writes the canonical
`notarb-last-target-dryrun.*.log` files.

The normal lifecycle is:

1. A successful LAST NotArb route check with a mint and DEX updates
   `.last-grpc-state.json.lastRoute*`.
2. The bridge validates the route and publishes `status: "active"` with a
   matching activity signature, exact pool group, and route-specific ALT set.
3. The supervisor starts one target-only dry-run child. It keeps that child
   running while LAST activity remains fresh.
4. After 30 seconds without a new qualifying LAST route check, or immediately
   on `held` or stale markets, the supervisor stops only the child tree it
   created. A route/market publication mismatch gets at most a seven-second
   coherence grace while the bridge atomically finishes the next generation.

The supervisor does not revive a stale historical group. A fresh activity must
pass the bridge gates again. During continuous activity, a validated route
rotation updates the market/ALT files in place rather than creating duplicate
NotArb children. `npm run test:last:supervisor` is an offline fake-child test
for this start → stay-running → quiet-stop → restart behavior;
`npm run test:last:bridge` verifies the bridge ignores an unfinished JSONL tail
and never promotes a mint-only, no-DEX event into a route.

`run-notarb-last-target-dryrun.cmd` is an internal child runner and rejects a
direct launch; use the supervisor entry point for every normal run.

The template is deliberately non-live:

- the global `[notarb_markets]` scanner is disabled;
- `[[markets_file]]` points only to `last-target-markets.json`;
- `[[lookup_tables_file]]` points only to `last-target-lookup-tables.txt`;
- no `[[sender]]` exists;
- every swap strategy is disabled;
- `transaction_executor.threads = 0`;
- no durable nonce pool exists;
- WSOL unwrapper is off.

## WSL Rust route bridge

The production route bridge now has a Linux/WSL Rust implementation in
`rust/last-route-bridge`. It reads the same local gRPC JSONL evidence, uses
only `127.0.0.1:18899` for account/ALT validation, writes the target route
lease, and supports Orca Whirlpool pool states (`653` bytes) in addition to
the existing Pump, Meteora, and Raydium layouts.

Run the Linux pipeline after stopping the legacy Windows observer and bridge:

```powershell
wsl.exe -e bash /mnt/g/old-program/notarb/run-last-rust-pipeline.sh
```

The WSL observer runs with `--no-state`; the compiled Rust bridge owns the
small `.last-grpc-state.json` lease used by the existing lifecycle supervisor.
This removes the former large Windows state-snapshot replacement path. Build
artifacts live under the WSL home cache, outside the mounted worktree.

When a fresh no-profit route check changes only its ALT indexes or writable
account metas, the derived mint/DEX/pool/ALT set keeps its existing generation.
Before publishing that renewed active lease, the Rust bridge atomically refreshes
the route-evidence fingerprint in `last-target-route.json`. This keeps the
observer, route record, and supervisor activity evidence coherent without
starting a duplicate NotArb child.

## Activity-gated live sender and flash loan

`notarb-last-grpc-live.example.toml` is the tracked LAST-only live profile.
Its local runnable copy is ignored by Git. It keeps the global scanner off and
uses only the bridge-written `last-target-markets.json` plus its exact active
ALT file. The profile enables one executor, one official Jito sender, an
enabled SOL strategy, and `flash_loan = true`.

```powershell
Copy-Item .\notarb-last-grpc-live.example.toml .\notarb-last-grpc-live.toml
notepad .\notarb-last-grpc-live.toml # set the local bot keypair and token-account RPC
node .\assert-last-live.mjs .\notarb-last-grpc-live.toml
npm run supervise:last:live
```

On Windows, `run-last-notarb-live-supervisor.cmd` is the long-running entry
point. Keep the dry-run supervisor stopped when this profile is running. The
live supervisor uses the same fresh route lease as the dry-run profile: quiet,
held, stale, or incoherent LAST evidence leaves the Java child absent; a fresh
bridge-validated route starts one `run-notarb-last-target-live.cmd` child.

The Jito sender intentionally permits an empty UUID, matching NotArb's bundled
base configuration. Tips and priority fees are capped at 25,000 lamports and
the no-UUID cooldown is 1,000 ms. `token_accounts_checker` is configured
separately because the live bot needs current token-account visibility for its
own keypair.

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

For a clean-machine setup from `git clone` through the activity-gated profiles,
follow [HANDOFF.md](HANDOFF.md).

## Historical diagnostics

`watch-last.mjs` and `stream-last.mjs` are retained as earlier diagnostics and
evidence helpers. They are not part of the active runner and must not replace
the Yellowstone gRPC path above. `LAST-findings.md` and `lookup-tables.txt`
contain public historical observations only; no wallet or credential is stored
in this repository.
