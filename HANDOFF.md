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
# Yellowstone gRPC: market discovery and LAST observer
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

The observer records NotArb's no-profit checks as route-intent evidence. A
`No arbitrage profit found` log means no settled trade price; it does not mean
the mint, DEX, or ALT data is discarded.

## Start native NotArb market discovery in dry run

Create a noncommitted local config and replace only the keypair placeholder
with your unfunded/test keypair path:

```powershell
Copy-Item .\notarb-last-grpc-dryrun.example.toml .\notarb-last-grpc-dryrun.toml
notepad .\notarb-last-grpc-dryrun.toml
& "$env:LOCALAPPDATA\notarb\bin\notarb.bat" onchain-bot .\notarb-last-grpc-dryrun.toml
```

Expected output appears roughly every five seconds:

```text
[notarb_markets] Update #...
Mints: ... | Markets: ... | ALTs: ...
Transactions (notarb_0_enabled)
```

This proves gRPC market discovery and NotArb market-group construction are
connected. It does **not** send a transaction: `dry_run = true`, no sender is
configured, the strategy defaults to disabled, the executor has zero threads,
and no nonce pool exists.

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
