# Fresh-start handoff

This guide is enough to reproduce the current dry-run and activity-gated live
profiles from a clean clone. It deliberately does not include a wallet or SSH
private key.

## 2026-07-22 current handoff: NA instruction-scoped market pairs

**Code baseline before this document:** `136ea35 Restrict LAST pools to NA
instruction accounts`, pushed to
`origin/codex/last-activity-lifecycle`. This section records the exact resume
point; the remainder of this file contains the clone, deployment, and runtime
procedures.

### What changed and why

NotArb does not accept a target mint or a DEX name as a `markets_file` input.
It expects a two-dimensional group of concrete pool/market-state addresses:

```toml
[[markets_file]]
path = "last-target-markets.json"

[[lookup_tables_file]]
path = "last-target-lookup-tables.txt"
```

The target mint and DEX are bridge constraints used to identify and validate
the correct pool-state accounts. They are not a substitute for the market
addresses. A full Solana transaction account list is too broad: it can contain
unrelated accounts, accounts from another leg, and addresses loaded from an
ALT. The reliable route-local boundary is the account-meta vector of the outer
`NA247a7YE9S3p9CdKmMyETx8TTwbSdVbVYHHxpnHTUV` instruction.

`136ea35` therefore makes these two coordinated changes:

1. `grpc-last.mjs` records every top-level NotArb instruction in
   `notArb.instructions[]`, with each expanded account's instruction-relative
   `position`, global `accountIndex`, `pubkey`, `source` (`transaction` or
   `lookup_table`), `writable`, and `signer` fields.
2. `rust/last-route-bridge/src/main.rs` takes pool candidates from those
   NotArb instruction accounts first, then confirms them through the read RPC
   using DEX owner, supported binary layout, target mint, and WSOL checks.
   It writes `poolCandidateSource: "na_instruction_accounts"` and a
   `naInstructionReferences` array on every emitted
   `validatedPoolStates[]` item in `last-target-route.json`.

This deliberately preserves the whole NA account vector rather than
hard-coding an absolute account-key number. On a checked historical route, the
pool states occurred at NA-instruction-relative positions `10`, `20`, `40`,
and `50`; their global message indexes and ALT placement vary with the DEX
legs. The observed positions follow DEX-program / pool-state adjacency, but
that is evidence rather than an ABI rule to hard-code.

### Compatibility caveat

Old persisted receipts predate `notArb.instructions[]`. For those receipts
only, the bridge retains `poolCandidateSource: "legacy_transaction_accounts"`
and falls back to the complete transaction account list so old local evidence
remains readable. Treat that output as
historical compatibility evidence, not proof that the NA-scoped path works.
The next fresh gRPC receipt must produce
`poolCandidateSource: "na_instruction_accounts"`; if it does not, retain the
route as `held` and investigate the observer receipt rather than accepting a
new broad candidate set.

### Verified evidence and tests

- Historical LAST route signature:
  `5P8Y1eNNkw1pqZ86uGgiUoyYqgw7QNaJ4uSq2V8E52xgDe3d23rge8vRCepzmkLLn2moNuh4hKxikhifHi26ceh`.
- Observed target mint:
  `7V6Sk63y8Rr1MvcN5mYNp61wgFhy4EeQg5gUASk9pump`.
- Verified route protocols: Pump.fun AMM, Meteora DLMM, and Meteora CPMM.
  Example checked pool states are `9fXLKzhn5YGHYTVx1Rnm8fYPnwm2oV415ewztciKN5EE`
  (DLMM, 904 bytes),
  `AakC3joD4NEYmwXc6by5xmtVcxbZBrBJW4FCWxZBoGj7` (DLMM, 904 bytes),
  `EDX18gJCdijqSLAJA2pp5C2VmA3bTRrx4utxkeJuFRtQ` (Pump, 301 bytes), and
  `Gov3BLH9edvuSrSLj4a74ExM7KBrYQ2Z2eAsYff2bLuE` (CPMM, 1112 bytes).
- The current change passed `node --check grpc-last.mjs`, `git diff --check`,
  Rust `cargo fmt --check`, and all 18 locked Rust tests.

### Runtime status at handoff

There is no recorded real `sendTransaction` signature at this handoff point.
The most recent retained LAST route had exceeded its activity lease, so the
bridge status was `held` with `observer_stale`; an absent NotArb child in that
state is expected. A `No arbitrage profit found` log is still useful route
intent evidence, but it is not an executed fill or a realized price.

The deployed baseline before `136ea35` was `ecaf38a` at
`/opt/notarb-last/releases/ecaf38ab8aeccc0d08f193afd84a36964f8010d6` on
`82.23.138.51`. The new commit is pushed but must be treated as deployed only
after its GitHub Actions run succeeds and `/opt/notarb-last/current` resolves
to its release. The runtime itself is on `82.23.138.51`; it directly reads
Yellowstone from `82.39.215.201:10000` and the read RPC from
`82.39.215.201:8899`.

### Resume checklist after a fresh LAST event

1. Pull `codex/last-activity-lifecycle`, install dependencies with
   `npm ci --ignore-scripts`, and run:

   ```powershell
   npm run test:last:live-config
   npm run test:last:live-config-migration
   npm run test:last:bridge
   wsl.exe -d Ubuntu --cd /mnt/g/old-program/notarb/rust/last-route-bridge cargo test --locked
   ```

2. After CI deployment, confirm the release and both services without exposing
   private TOML or key material:

   ```bash
   readlink -f /opt/notarb-last/current
   systemctl is-active notarb-last-pipeline.service notarb-last-live-supervisor.service
   ```

3. When a new observer event arrives, inspect
   `/var/lib/notarb-last/runtime-state/last-target-route.json`. Require all of
   the following before treating it as a usable current route:

   - `poolCandidateSource == "na_instruction_accounts"`;
   - each selected pool has one or more `naInstructionReferences`;
   - the target status is `active`, its signature/generation matches the
     observer state, and the market file contains the same group;
   - all selected ALT IDs are readable and appear in
     `last-target-lookup-tables.txt`.

4. Only during that fresh active lease should the live supervisor create the
   NotArb child. Follow the current logs:

   ```bash
   tail -F /var/lib/notarb-last/runtime-state/last-grpc-rust-runtime.stderr.log \
           /var/lib/notarb-last/runtime-state/last-route-rust.stderr.log \
           /var/lib/notarb-last/runtime-state/notarb-last-target-live.stderr.log
   ```

   Record the Helius transaction signature only if the sender actually returns
   one. A running Java process, `[markets_file] Groups: 1`, or an active route
   alone does not establish that a transaction was sent.

5. If the old token-account `-32010` error returns, verify that only
   `[token_accounts_checker]` and `[[spam_rpc]]` use the indexed Helius URL;
   leave blockhash, price, market, and ALT readers on the 82 read RPC. The
   live profile uses `[[spam_rpc]]` plus `spam_senders`, omits
   `require_profit`, has no Jito tip, and uses `threads = 0` as NotArb's
   dynamic executor setting.

## 82.23.138.51 deployment target

The production target is `root@82.23.138.51`, not the Windows workstation.
GitHub Actions builds an immutable Linux release and atomically switches the
server's `current` release link. The deployment job validates the private
configuration before stopping services, keeps generated runtime evidence
outside a release, waits for both services to remain healthy, and restores the
prior release, units, and enabled/active state if activation fails.

```bash
systemctl status notarb-last-pipeline.service
systemctl status notarb-last-live-supervisor.service
```

`notarb-last-pipeline.service` runs the Yellowstone observer plus compiled Rust
bridge. `notarb-last-live-supervisor.service` runs continuously but starts the
NotArb Java child only for a fresh, bridge-validated `active` LAST lease.
`held`, quiet, stale, or incoherent status is normal and leaves the child
absent. The current server paths are:

```text
/opt/notarb-last/current         symlink to the active immutable release
/opt/notarb-last/releases/<sha>  immutable release directories
/opt/notarb-last/incoming        uploaded release archives
/etc/notarb-last                 0700 private config directory
/etc/notarb-last/keypair.json    0600 bot keypair
/etc/notarb-last/notarb-last-grpc-live.toml  0600 live config
/var/lib/notarb-last             0700 runtime state and NotArb JAR
/var/lib/notarb-last/runtime-state  generated observer/bridge/supervisor state
```

When deployed, the server connects directly to `82.39.215.201:10000` (gRPC) and
`82.39.215.201:8899` (read RPC). The blockhash, price, market, and ALT loaders
stay on that read RPC. The token-account checker matches the indexed Helius
`[[spam_rpc]]` URL because the 82 read node does not index this bot wallet.
For NotArb v1.1.2, `spam1` is
selected through `[[spam_rpc]]` plus
`spam_senders = [{ rpc = "spam1", ... }]`; it is the single ordinary Helius
sending endpoint, not a `[[sender]]` / `senders` profile. There are no
Windows/WSL observer processes or local SSH tunnels in this deployment.

## CI/CD deployment to 82.23

1. Install `/usr/bin/node` major version 22 and `/usr/bin/java` major version
   25 on the server. Rust and Cargo are not needed on the server: the workflow
   ships a compiled Linux bridge.
2. Create `/etc/notarb-last` with mode `0700`, then create
   `/etc/notarb-last/keypair.json` and
   `/etc/notarb-last/notarb-last-grpc-live.toml` as `root:root`, mode `0600`.
   Start the live TOML from the tracked example, set the bot keypair and
   Helius API key, set `blockhash_updater`, `price_updater`, `market_loader`,
    `lookup_table_loader`, and `grpc_url` to the direct 82.39 endpoints; set
    `[token_accounts_checker].rpc_url` and `[[spam_rpc]].url` to the same
    indexed Helius endpoint. Keep the markets and ALT paths relative; the live service
    maintains their stable `/etc/notarb-last` links. Do not commit this file or
    the keypair.
3. For the first deployment only, place the matching NotArb JAR at
   `/opt/notarb-last/.notarb-1.1.2.jar`. The workflow verifies it and installs
   the private runtime copy under `/var/lib/notarb-last/`.
4. In GitHub, create the `production` environment and add these environment
   secrets:

   - `DEPLOY_SSH_KEY`: a dedicated private key authorized for
     `root@82.23.138.51`.
   - `DEPLOY_KNOWN_HOSTS`: the pinned OpenSSH `known_hosts` entry for
     `82.23.138.51`.

5. Push a change to `codex/last-activity-lifecycle` that matches the workflow
   path filters, or invoke **Build and deploy LAST runtime** manually from the
   Actions tab. The `production` job uploads, activates, and checks the
   release.
6. Verify the config without printing its secret URL, then inspect the two
   service states and logs:

   ```bash
   LAST_READ_RPC_URL=http://82.39.215.201:8899 \
     /usr/bin/node /opt/notarb-last/current/assert-last-live.mjs \
       /etc/notarb-last/notarb-last-grpc-live.toml
   systemctl --no-pager --full status notarb-last-pipeline.service notarb-last-live-supervisor.service
   tail -n 50 /opt/notarb-last/current/last-route-rust.stderr.log
   tail -n 50 /opt/notarb-last/current/last-notarb-live-supervisor.stdout.log
   ```

The initial migration accepts the older direct `/opt/notarb-last` layout as a
rollback source. It does not replace an existing non-symlink `current` path.

Before enabling this server on a migration, stop every prior live supervisor
and its child tree elsewhere so two runtimes never send at the same time.

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

## Optional legacy local-development tunnels

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

## Start the WSL observer and compiled Rust bridge

For the Linux runtime, keep the two SSH forwards running, stop any Windows
`grpc-last.mjs` and `last-route-to-notarb.mjs` instances, then run:

```powershell
wsl.exe -e bash /mnt/g/old-program/notarb/run-last-rust-pipeline.sh
```

The script starts the WSL Node Yellowstone reader in append-only `--no-state`
mode and compiles/runs `rust/last-route-bridge` from the WSL cargo cache. The
Rust process writes the lifecycle state and target markets, supports Orca
Whirlpool (`whirLb...`, 653-byte pool state), and uses the same local
`127.0.0.1:18899` read-RPC tunnel. Its logs are
`last-grpc-rust-runtime.*.log` and `last-route-rust.*.log`.

The observer records NotArb's no-profit checks as route-intent evidence. A
`No arbitrage profit found` log means no settled trade price; it does not mean
the mint, DEX, or ALT data is discarded.

If a fresh check changes only ALT index selections or writable route-account
metas while its validated markets stay the same, the Rust bridge preserves the
generation and refreshes `last-target-route.json.automation.routeEvidenceFingerprint`
before it publishes the active lease. That exact three-way fingerprint match is
required by `last-notarb-supervisor.mjs` before it starts or keeps a child.

The Windows supervisor evaluates the local status/markets file mtimes for
lease freshness instead of comparing WSL payload timestamps to the host clock.
It permits a 20-second markets heartbeat by default and still stops immediately
when the route status becomes `held` or stale.

An activity key is the route generation plus observed signature. Once its
child has been attempted, a temporary heartbeat loss cannot relaunch that same
key; the next launch requires a new validated activity key.

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
its own child after 120 seconds of quiet activity, immediately when the bridge
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

## Start the activity-gated live sender / flash-loan profile

The live profile remains LAST-only and is controlled by the same route lease as
the dry run. Create the ignored local config, set its keypair path and
token-account checker RPC, then validate and start the live supervisor. Use
this profile instead of the dry-run supervisor, not alongside it.

```powershell
Copy-Item .\notarb-last-grpc-live.example.toml .\notarb-last-grpc-live.toml
notepad .\notarb-last-grpc-live.toml
node .\assert-last-live.mjs .\notarb-last-grpc-live.toml
npm run supervise:last:live
```

The profile has `transaction_executor.threads = 0`, which selects NotArb
v1.1.2's dynamic cached executor thread pool. It has one ordinary Helius
`[[spam_rpc]]` sender selected with `spam_senders = [{ rpc = "spam1", ... }]`
(the NotArb v1.1.2 ordinary-RPC pair, rather than `[[sender]]` / `senders`), an
enabled SOL strategy, and `[swap.strategy_defaults] flash_loan = true`; the
sender/swap execution path remains enabled.
It keeps `[notarb_markets] enabled = false`, loading only the current
`last-target-markets.json` and `last-target-lookup-tables.txt` written by the
LAST bridge. The profile omits `require_profit`, keeps a 1,000 ms cooldown,
and a 25,000-lamport priority-fee cap; ordinary RPC sends have no Jito tip.

The live child starts only for a fresh bridge-validated LAST route and stops
when the lease becomes quiet, held, stale, or incoherent. Its logs are
`notarb-last-target-live.stdout.log` and
`notarb-last-target-live.stderr.log`; supervisor logs are
`last-notarb-live-supervisor.stdout.log` and
`last-notarb-live-supervisor.stderr.log`.

`[token_accounts_checker]` must match the indexed Helius `[[spam_rpc]]` URL.
The 82 read RPC returns an account-secondary-index error for this bot wallet;
the bridge and blockhash, price, market, and ALT reader roles remain on 82.

No private material should ever be committed. `.gitignore` excludes the local
run config, wallet JSON files, event data, logs, and dependencies.
