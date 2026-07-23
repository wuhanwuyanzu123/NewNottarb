# Fresh-start handoff

This guide is enough to reproduce the current dry-run and activity-gated live
profiles from a clean clone. It deliberately does not include a wallet or SSH
private key.

## 2026-07-23 current handoff: NA instruction-scoped market pairs and reader RPC

**Server baseline observed while updating this document:** `6390f47 Emit NA
instruction market pairs for NotArb`, deployed at
`/opt/notarb-last/releases/6390f470e79b1c371b9b3ca2dcb13243f471b83c` on
`82.23.138.51`. The reader-RPC, retry, and Raydium CLMM changes documented
below need their own successful CI deployment before that server pointer is
expected to change. The remainder of this file contains the clone, deployment,
and runtime procedures.

### Reader-RPC operational update

The Yellowstone observer remains directly connected to
`82.39.215.201:10000`. The current core JSON-RPC reader is directly
`http://82.39.215.201:8899`; it supplies the Rust bridge and NotArb blockhash,
price, market, and ALT reads.

The current production reader/sender contract is:

1. `[blockhash_updater]`, `[price_updater]`, `[market_loader]`, and
   `[lookup_table_loader]` in the ignored
   `/etc/notarb-last/notarb-last-grpc-live.toml` must all be
   `http://82.39.215.201:8899`. `assert-last-live.mjs` rejects a mismatch.
2. `run-last-rust-pipeline.sh` derives `LAST_READ_RPC_URL` from the asserted
   blockhash section when no local-development override is supplied and passes
   it only as inherited process environment to the Rust bridge. The endpoint is
   not a bridge CLI argument.
3. `[token_accounts_checker]` and `[[spam_rpc]] spam1` share the private
   indexed Helius endpoint for token-account index reads and ordinary-RPC
   sending. The 82 reader excludes this bot from its token-account secondary
   index.

Do not print, commit, put into a shell command, include in process arguments,
or copy the private Helius endpoint into logs or documentation. The tracked
example contains placeholders only; the private live TOML remains mode `0600`.

### What changed and why

NotArb does not accept a target mint or a DEX name as a `markets_file` input.
It expects a two-dimensional group of concrete pool/market-state addresses:

```toml
[[markets_file]]
path = "last-target-markets.json"

[[lookup_tables_file]]
path = "last-target-lookup-tables.txt"
```

The target mint and DEX are bridge constraints used to validate market-state
accounts. They are not a substitute for the market addresses. A full Solana
transaction account list is too broad: it can contain unrelated accounts,
accounts from another leg, and addresses loaded from an ALT. The reliable
route-local boundary is the account-meta vector of the outer
`NA247a7YE9S3p9CdKmMyETx8TTwbSdVbVYHHxpnHTUV` instruction.

The instruction-scoped market-pair implementation makes these two coordinated
changes:

1. `grpc-last.mjs` records every top-level NotArb instruction in
   `notArb.instructions[]`, with each expanded account's instruction-relative
   `position`, global `accountIndex`, `pubkey`, `source` (`transaction` or
   `lookup_table`), `writable`, and `signer` fields.
2. `rust/last-route-bridge/src/main.rs` scans those accounts for a supported
   DEX program and takes only its market-state account at the verified
   instruction-relative offset: `+1` for Raydium AMM v4, Pump AMM, Meteora
   DLMM, and Orca Whirlpool; `+2` for Meteora CPMM (the skipped `+1` account
   is its event authority) and Raydium CLMM (the skipped `+1` account is
   AmmConfig). Raydium CLMM additionally requires the 1,544-byte PoolState
   discriminator, so configuration accounts never become market inputs. The
   bridge confirms the expected DEX owner and binary layout through the read
   RPC. Every validated outer NA instruction becomes one NotArb `groups[]`
   entry in its original market order; it is not reduced to a target-mint or
   WSOL-only subset. The route record writes
   `marketCandidateSource: "na_instruction_market_pairs"`,
   `validatedMarketStates[]`, and a `naInstructionReferences` array with the
   DEX-program and market positions. The older `pool*` fields remain aliases
   for inspection compatibility.

This deliberately uses instruction-relative positions rather than an absolute
message account-key number. On a checked historical route, market states
occurred at positions `10`, `20`, `40`, and `50`; another route can use
`10`, `18`, `27`, `36`, `44`, and `49`. Global message indexes and ALT
placement vary with the DEX legs. The protocol-specific program-to-market
offset is the verified rule; absolute positions are only route evidence.

### Compatibility caveat

Old persisted receipts predate `notArb.instructions[]`. For those receipts
only, the bridge retains a `marketCandidateSource` value of
`legacy_transaction_accounts` and falls back to the complete transaction
account list so old local evidence remains readable. Treat that output as
historical compatibility evidence, not proof that the NA-scoped path works.
The next fresh gRPC receipt must produce
`marketCandidateSource: "na_instruction_market_pairs"`; if it does not,
retain the route as `held` and investigate the observer receipt rather than
accepting a new broad candidate set.

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
- The current source change passes the offline Node configuration, lifecycle,
  and bridge tests plus `git diff --check`. GitHub Actions uses stable Rust to
  run the locked Rust test suite and build the Linux bridge; the server's old
  Cargo 1.75 is intentionally not used for the release build.

### Runtime status at handoff

There is no recorded real `sendTransaction` signature at this handoff point.
A fresh `active` lease is expected to create the Java child; `held`, quiet, or
stale evidence is expected to leave that child absent. A `No arbitrage profit
found` log is still useful route-intent evidence, but it is not an executed
fill or a realized price. If a core-reader validation fails, the bridge first
publishes `held(reader_retry)` to stop any prior child, then retries that same
route with a bounded 1--30 second backoff; a fresh LAST route bypasses the
backoff immediately.

The runtime reads Yellowstone from `82.39.215.201:10000` and uses
`http://82.39.215.201:8899` for bridge and core NotArb reads. Its private
Helius endpoint remains limited to token-account checking and the `spam1`
ordinary-RPC sender. Treat a source commit as deployed only after its GitHub
Actions run succeeds and `/opt/notarb-last/current` resolves to the matching
release directory.

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

   - `marketCandidateSource == "na_instruction_market_pairs"`;
   - each selected market has one or more `naInstructionReferences`, including
     its DEX-program position, market position, and protocol offset;
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

5. If a core blockhash, market, ALT, or price-reader error returns, verify that
   `[blockhash_updater]`, `[price_updater]`, `[market_loader]`, and
   `[lookup_table_loader]` exactly match `http://82.39.215.201:8899`. If a
   token-account error returns, confirm that `[token_accounts_checker]` and
   `[[spam_rpc]]` use the same private indexed Helius endpoint. The live
   profile uses `[[spam_rpc]]` plus `spam_senders`, omits `require_profit`, has
   no Jito tip, and uses `threads = 0` as NotArb's dynamic executor setting.

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

When deployed, the server connects directly to `82.39.215.201:10000` for
Yellowstone gRPC and to `http://82.39.215.201:8899` for core reads. The
blockhash, price, market, and ALT loader sections must all use the 8899 reader,
and the Rust bridge derives that same value without placing it in its command
line. The token-account checker matches the private indexed Helius
`[[spam_rpc]]` endpoint because the 82 reader does not index this bot wallet.
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
    Start the live TOML from the tracked example, set the bot keypair, and keep
    `[blockhash_updater]`, `[price_updater]`, `[market_loader]`, and
    `[lookup_table_loader]` at `http://82.39.215.201:8899`. Set
    `[token_accounts_checker].rpc_url` and `[[spam_rpc]].url` to the same
    private indexed Helius endpoint. Keep `[notarb_markets]` disabled and the
    markets and ALT paths relative; the separate systemd observer remains on
    Yellowstone gRPC `82.39.215.201:10000`. The live service maintains stable
    `/etc/notarb-last` links. Do not commit this file, its private endpoint, or
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
6. Verify the config without printing its private endpoint or putting it on a
   command line, then inspect the two service states and logs:

   ```bash
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

# Legacy local-development JSON-RPC only: read-only blockhash, market account,
# and ALT reads. Do not use this tunnel as the production reader.
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

For the local WSL runtime, keep the two SSH forwards running, stop any Windows
`grpc-last.mjs` and `last-route-to-notarb.mjs` instances, then run:

```powershell
wsl.exe -e bash /mnt/g/old-program/notarb/run-last-rust-pipeline.sh
```

The script starts the WSL Node Yellowstone reader in append-only `--no-state`
mode and compiles/runs `rust/last-route-bridge` from the WSL cargo cache. The
Rust process writes the lifecycle state and target markets, supports Orca
Whirlpool (`whirLb...`, 653-byte pool state), and uses the same local
`127.0.0.1:18899` legacy development read-RPC tunnel. Its logs are
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
through the configured local development reader, and writes `last-target-markets.json`
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
route ALT through the configured core reader (`http://82.39.215.201:8899` in
production; the local tunnel is development-only). It writes `last-target-status.json`
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

`[token_accounts_checker]` must match the private indexed Helius `[[spam_rpc]]`
endpoint. `[blockhash_updater]`, `[price_updater]`, `[market_loader]`, and
`[lookup_table_loader]` must all use `http://82.39.215.201:8899`. The 82 reader
is intentionally excluded only from the bot-wallet token-account index path.

No private material should ever be committed. `.gitignore` excludes the local
run config, wallet JSON files, event data, logs, and dependencies.
