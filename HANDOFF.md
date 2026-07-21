# Fresh-start handoff

This guide is enough to reproduce the current **dry-run** system from a clean
clone. It deliberately does not include a wallet, SSH private key, API key, or
live trading authorization.

## What you need outside this repository

1. Git and Node.js 20.18 or newer.
2. The official NotArb CLI installed locally. Verify it with:

   ```powershell
   & "$env:LOCALAPPDATA\notarb\bin\notarb.bat" version
   ```

   If that path does not exist, install NotArb following the official
   [onchain-bot documentation](https://notarb.com/docs/onchain-bot/tab.html).
3. SSH access to `root@82.23.138.51`, with an authorized private key, and
   network reachability from that jump host to `82.39.215.201`.
4. A separate local Solana keypair file. Use an unfunded/test keypair for the
   dry run; do not put it in this repository.

## Start from a clean clone

```powershell
git clone https://github.com/wuhanwuyanzu123/NewNottarb.git
Set-Location .\NewNottarb
npm ci --ignore-scripts
node --version
```

The package lock pins the Yellowstone client used by `grpc-last.mjs`.

## Create the two 82 tunnels

Run each in a separate PowerShell window and keep both windows open. Replace
the key path if yours differs.

```powershell
# Yellowstone gRPC: LAST observer
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -N -L 127.0.0.1:18100:82.39.215.201:10000 root@82.23.138.51

# Standard Solana JSON-RPC: read-only blockhash, market account, and ALT reads
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -N -L 127.0.0.1:18899:82.39.215.201:8899 root@82.23.138.51
```

Quick checks:

```powershell
Test-NetConnection 127.0.0.1 -Port 18100
Test-NetConnection 127.0.0.1 -Port 18899
```

## Start the LAST observer

In a third PowerShell window:

```powershell
npm run listen:last:grpc
```

On Windows, `run-grpc-last.cmd` is the equivalent long-running wrapper and
writes the canonical observer logs used by the monitor.

The observer records NotArb's no-profit checks as route-intent evidence. A
`No arbitrage profit found` log means no settled trade price; it does not mean
the mint, DEX, or ALT data is discarded.

## Build the LAST-only NotArb markets file

In a fourth PowerShell window, keep the bridge running:

```powershell
npm run extract:last:markets
```

Or use `run-last-route-to-notarb.cmd` on Windows to keep the same bridge in a
background command process. It logs to `last-route-to-notarb.stdout.log` and
`last-route-to-notarb.stderr.log`.

It reads only `last-grpc-events.jsonl`, validates candidate pool-state accounts
through the local 82 read-RPC tunnel, and writes `last-target-markets.json`
plus `last-target-lookup-tables.txt`.
Inspect the generated `last-target-route.json` and `last-target-status.json`
for the current mint, pool group, ALT set, and whether it is active or held.
The global NotArb market scanner is not used.

## Start activity-gated target-specific NotArb dry run

Create a noncommitted local config and replace only the keypair placeholder
with your unfunded/test keypair path:

```powershell
Copy-Item .\notarb-last-grpc-dryrun.example.toml .\notarb-last-grpc-dryrun.toml
notepad .\notarb-last-grpc-dryrun.toml
npm run supervise:last:dryrun
```

For Windows, `run-last-notarb-supervisor.cmd` is the equivalent long-running
wrapper. It leaves NotArb stopped while LAST is quiet. When fresh LAST route
activity passes the bridge validation, it starts one child through
`run-notarb-last-target-dryrun.cmd`; that child performs the no-send preflight
before invoking NotArb.

When LAST becomes active, expected NotArb output includes the target group:

```text
[markets_file] Groups: 1
[on-chain-bot-...] INFO NotArb - Starting bot...
```

This proves LAST route extraction and NotArb market-file loading are connected.
The template also loads `last-target-lookup-tables.txt`, which contains only
the currently valid ALT IDs from the selected LAST route rather than an
accumulated historical ALT list. Any observed ALT that is no longer readable
is recorded as rejected in `last-target-route.json` and is not loaded.
It does **not** send a transaction: the global scanner is disabled, every swap
is disabled, no sender is configured, the executor has zero threads, and no
nonce pool exists.

The normal supervisor entry point does not keep a bot alive from a historical
route. It requires all of the following local evidence to agree: fresh
`.last-grpc-state.json.lastRoute*`, `last-target-status.json` set to `active`
for that same activity signature, a matching route generation, and fresh
`last-target-markets.json` groups identical to the validated route. It stops
its own child after 30 seconds of quiet activity, immediately when the bridge
reports `held` or markets go stale. It permits at most seven seconds for a
route/market publication generation to become coherent before stopping. The
observer and bridge remain running during those quiet periods.
`run-notarb-last-target-dryrun.cmd` is supervisor-internal and rejects direct
launches, so a normal clean-clone workflow cannot accidentally keep a target
bot running through a quiet LAST period.

Run the local offline lifecycle test after a clean clone:

```powershell
npm run test:last:supervisor
npm run test:last:bridge
```

## Automatic route changes

No mint or pool is hard-coded in the bot config. The bridge switches to a new
LAST route only after verifying a complete, supported pool group and every
route ALT through the local read-RPC tunnel. It writes `last-target-status.json`
with `active` or `held`; a held status preserves the previous group and names
the reason (for example, unsupported DEX or unreadable ALT). This is expected
for an unknown protocol and is safer than loading arbitrary accounts.
The supervisor sees a validated route rotation as an in-place update while
activity continues; it does not start a second NotArb child.

## Before any live change

Do not simply set `dry_run = false`. Complete every item in [PLAN.md](PLAN.md):

1. Use a dedicated funded wallet with an offline backup.
2. Use an indexed Solana RPC for `[token_accounts_checker]`; the current 82
   JSON-RPC node intentionally does not expose arbitrary-wallet token-account
   secondary indexes.
3. Agree explicit DEX allow-lists, fee/tip caps, cooldowns, and loss/spend
   limits.
4. Add a sender only after those decisions. Add durable nonces only if they
   are newly created under the bot wallet's authority.

No private material should ever be committed. `.gitignore` excludes the local
run config, wallet JSON files, event data, logs, and dependencies.
