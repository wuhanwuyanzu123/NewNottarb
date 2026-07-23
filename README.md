# LAST-targeted NotArb runner

This project follows the observed route of one address, not the whole chain:

1. `grpc-last.mjs` watches `LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9` through Yellowstone gRPC.
2. The compiled `rust/last-route-bridge` derives DEX-owned market-state accounts from the outer NotArb instruction's relative positions, validates them through the read RPC, and writes a NotArb `markets_file` plus a route-specific ALT file.
3. `last-notarb-supervisor.mjs` starts the selected target-only NotArb profile
   only during a fresh, bridge-validated LAST activity window, and stops its
   own child tree when the window closes. The global `[notarb_markets]` stream
   scanner is disabled.

No other project is used. The intended server runtime is `82.23.138.51`.
GitHub Actions builds the Linux release, uploads it to the server, and switches
`/opt/notarb-last/current` only after configuration validation. The Windows/WSL
commands below are retained only for local development.

## 82.23 deployment topology

`82.23.138.51` runs both systemd services directly. It reaches the upstream
services without a local SSH forward:

```text
82.39.215.201:10000 Yellowstone gRPC
  -> 82.23.138.51 /opt/notarb-last/current/grpc-last.mjs
  -> /var/lib/notarb-last/runtime-state/last-grpc-events.jsonl
  -> /var/lib/notarb-last/runtime-state/last-grpc-activity.json (LAST signer heartbeat)
  -> compiled Rust bridge
  -> target route / markets / ALT / status files
  -> activity-gated NotArb supervisor

82.39.215.201:8899 Solana JSON-RPC (core read RPC)
  -> inherited `LAST_READ_RPC_URL` for Rust market-state/ALT validation
  -> 82.23.138.51 NotArb blockhash, price, market, and ALT reader roles

Private live TOML Helius endpoint
  -> `token_accounts_checker` account-index reads and live `spam1`
     `[[spam_rpc]]` transaction sending
```

The four core NotArb reader roles are `[blockhash_updater]`,
`[price_updater]`, `[market_loader]`, and `[lookup_table_loader]`. Production
requires all four to use `http://82.39.215.201:8899`; the bridge inherits that
same value as `LAST_READ_RPC_URL`. `[token_accounts_checker]` and
`[[spam_rpc]] spam1` instead share the private indexed Helius endpoint because
the 82 reader excludes this bot from token-account secondary indexes. The
literal Helius endpoint stays only in the mode-`0600` live TOML: do not put it
in command lines, process arguments, logs, examples, or committed
documentation.

The deployment templates create `notarb-last-pipeline.service` and
`notarb-last-live-supervisor.service`. After an explicit deployment, check
them from an authorized machine:

```powershell
ssh root@82.23.138.51 "systemctl --no-pager status notarb-last-pipeline.service notarb-last-live-supervisor.service"
```

The two local ports `127.0.0.1:18100` and `127.0.0.1:18899` are not part of
the deployed runtime. They remain an optional legacy local-development
topology only; the latter does not select the production reader.

The live TOML is private under `/etc/notarb-last`, whereas the bridge writes
the rotating markets and ALT files beneath the CI-managed
`/opt/notarb-last/current` release pointer. The live systemd unit maintains
two stable leaf symlinks in `/etc/notarb-last` before starting the supervisor.
Keep the TOML paths relative (`last-target-markets.json` and
`last-target-lookup-tables.txt`); do not point the private config at an
individual release directory.

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

This Node bridge is retained for local-development troubleshooting. The 82.23
deployment uses the Rust bridge described below.

Run this alongside the observer:

```powershell
npm run extract:last:markets
```

On Windows, `run-last-route-to-notarb.cmd` is the same read-only bridge in a
long-running wrapper; it writes `last-route-to-notarb.*.log` and does
not start NotArb or a transaction sender.

It emits ignored runtime files:

- `last-target-route.json` — the LAST signature, target mint, candidate DEXes,
  and validated market-state evidence.
- `last-target-markets.json` — a NotArb `markets_file` containing the exact
  market-state group from each validated outer NotArb instruction.
- `last-target-lookup-tables.txt` contains only the currently readable public
  ALT IDs from that selected LAST route, not an accumulated historical ALT
  list.
- `last-target-status.json` records whether the newest LAST route is active or
  safely held, plus the generation and reason. It is generated locally and
  ignored by Git.

### Automatic route rotation

There is no fixed target mint in the NotArb config. When LAST changes mint,
validated market set, DEX set, or ALT selection, the gRPC observer writes a
new route snapshot. For every outer NotArb instruction, the bridge finds each
supported DEX program and takes its instruction-relative market-state account
(`+1` for Raydium, Pump, DLMM, and Orca; `+2` for Meteora CPMM), then validates
owner and binary layout through `127.0.0.1:18899`. It preserves that NA route
order in one NotArb group and atomically replaces each target file only when
the complete route is usable. NotArb polls the market file every 15 seconds
and the ALT file every 30 seconds.

The generated JSON uses NotArb's documented object form:

```json
{
  "update_timestamp": 1706540400000,
  "groups": [["market-state-1", "market-state-2"]]
}
```

The bridge is deliberately fail-closed: an unsupported candidate DEX, an
unreadable route ALT, a missing/invalid NA market-state, or fewer than two
validated markets leaves the prior target group in place and writes
`status: "held"` with the reason instead of loading unverified accounts.
Current automatic market layouts cover Pump.fun AMM, Meteora DLMM/CPMM,
Raydium AMM v4, and Orca Whirlpool. A newly observed protocol is surfaced in
`unsupportedCandidateDexPrograms`; it must receive an explicit verified market
layout before it can be loaded.

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
   Later confirmed transactions signed by LAST, including
   `setLoadedAccounts`, renew `last-grpc-activity.json` and keep this same
   validated route lease alive; they never create a route from their own
   account list.
3. The supervisor starts one target-only NotArb child. It keeps that child
   running while LAST activity remains fresh.
4. After 120 seconds without a new confirmed LAST-signed activity, or
   immediately on `held` or stale markets, the supervisor stops only the child
   tree it created. A route/market publication mismatch gets at most a
   seven-second coherence grace while the bridge atomically finishes the next
   generation.

The supervisor never derives a route from generic wallet activity: it requires
one prior bridge-validated route and continues using its exact mint/DEX/pool/
ALT set while LAST remains active. During continuous activity, a validated
route rotation updates the market/ALT files in place rather than creating duplicate
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

## Linux Rust route bridge

The production route bridge is Linux-compatible and runs in the 82.23 pipeline.
It reads the local gRPC JSONL evidence, uses `LAST_READ_RPC_URL` for account
and ALT validation, writes the target route lease, and supports Orca Whirlpool
market states (`653` bytes) in addition to the existing Pump, Meteora, and
Raydium layouts. When no explicit local-development override is supplied,
`run-last-rust-pipeline.sh` derives the asserted
`http://82.39.215.201:8899` value from the private live TOML's
`[blockhash_updater].rpc_url` and exports it to the bridge. It never supplies
the reader endpoint as a bridge command-line argument or writes it to a log.

For local WSL development, run the Linux pipeline only after stopping any
legacy Windows observer and bridge:

```powershell
wsl.exe -e bash /mnt/g/old-program/notarb/run-last-rust-pipeline.sh
```

The observer runs with `--no-state`; it writes the tiny
`last-grpc-activity.json` signer heartbeat while the compiled Rust bridge owns
the `.last-grpc-state.json` route/lease record used by the lifecycle
supervisor. In the 82.23 deployment, GitHub Actions supplies the compiled bridge at
`/opt/notarb-last/current/bin/last-route-bridge`, while generated evidence is
kept under `/var/lib/notarb-last/runtime-state` and linked into the release.

Before the first qualified event, or when the stream contains no qualifying
route evidence, the bridge publishes `status: "held"` with
`reason: "no_route_evidence"`. That is a normal quiet state: it performs no
read-RPC lookup and creates no active route, markets, or ALT output.

When a fresh no-profit route check changes only its ALT indexes or writable
account metas, the derived mint/DEX/pool/ALT set keeps its existing generation.
Before publishing that renewed active lease, the Rust bridge atomically refreshes
the route-evidence fingerprint in `last-target-route.json`. This keeps the
observer, route record, and supervisor activity evidence coherent without
starting a duplicate NotArb child.

The lifecycle supervisor uses the host mtimes of the bridge-written status and
markets files for lease freshness. Its markets heartbeat default is 20 seconds;
a `held` or stale route status still stops the child immediately.
If a heartbeat gap stops a child, the supervisor records that activity key and
will not start it again for the same generation/signature. Only a new validated
LAST activity key may launch the next child.

## Activity-gated live sender and flash loan

`notarb-last-grpc-live.example.toml` is the tracked LAST-only live profile.
Its local runnable copy is ignored by Git. It keeps the global scanner off and
uses only the bridge-written `last-target-markets.json` plus its exact active
ALT file. The profile uses `transaction_executor.threads = 0`, which selects
NotArb v1.1.2's dynamic cached executor thread pool. Its ordinary Helius
JSON-RPC sender (`[[spam_rpc]]`, referenced by
`spam_senders = [{ rpc = "spam1", ... }]`), SOL strategy, and `flash_loan = true`
remain enabled for live execution.

### v1.1.2 configuration contract

The deployed JAR is pinned to the official
[`v1.1.2` distribution](https://github.com/NotArb/Release/releases/download/v1.1.2/notarb-1.1.2.tar.gz).
Its bundled `onchain-bot/example.toml` pairs `[[spam_rpc]]` with
`[[swap.strategy]].spam_senders`:

```toml
[[spam_rpc]]
id = "spam1"
# Its endpoint is stored only in the private live TOML.

[[swap.strategy]]
spam_senders = [{ rpc = "spam1", max_retries = 0 }]
```

Do not cross this with the distinct `[[sender]]` / `senders` schema. The
deployment validates the v1.1.2 pair, omits `require_profit`, and requires the
four core reader/load sections to use `http://82.39.215.201:8899`.

```powershell
Copy-Item .\notarb-last-grpc-live.example.toml .\notarb-last-grpc-live.toml
notepad .\notarb-last-grpc-live.toml # set the local bot keypair and private Helius value
node .\assert-last-live.mjs .\notarb-last-grpc-live.toml
npm run supervise:last:live
```

On 82.23, `notarb-last-live-supervisor.service` runs
`run-last-notarb-live-supervisor.sh`; it uses the same fresh route lease as the
dry-run profile. Quiet, held, stale, or incoherent LAST evidence leaves the
Java child absent; a fresh bridge-validated route starts one
`run-notarb-last-target-live.sh` child. The Windows `.cmd` wrapper remains for
local development only.

For NotArb v1.1.2, the ordinary-RPC sender is `[[spam_rpc]] spam1`; do not
substitute `[[sender]]` / `senders` for this profile.
`[[swap.strategy]].spam_senders` maps to it with `rpc = "spam1"`, keeps
`max_retries = 0`, omits `require_profit`, and has no Jito tip. The private
Helius endpoint backs only `token_accounts_checker` and `[[spam_rpc]]`; all
four core reader/load sections remain on `http://82.39.215.201:8899`. Priority
fees remain capped at 25,000 lamports and the cooldown is
1,000 ms.

## Runtime evidence

Git intentionally ignores the high-frequency runtime evidence:

- `last-grpc-activity.json` — latest confirmed transaction signed by LAST,
  used only to renew a validated-route lifecycle lease;
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
