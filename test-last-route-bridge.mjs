#!/usr/bin/env node
// Offline bridge parser/gate test.  Its observer state is deliberately stale,
// so the bridge must never issue an RPC request while checking these fixtures.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const ROOT = resolve(process.cwd());
const BRIDGE = resolve(ROOT, 'last-route-to-notarb.mjs');
const WATCHED_ADDRESS = 'LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9';
const directory = await mkdtemp(join(tmpdir(), 'last-route-bridge-'));
const execFileAsync = promisify(execFile);

function routeEvent(signature, observedAt, dexPrograms) {
  return {
    watch: { address: WATCHED_ADDRESS },
    success: true,
    notArb: { matched: true },
    signature,
    slot: '1',
    observedAt,
    accountKeys: [{ pubkey: 'PoolFixture111111111111111111111111111111111', writable: true, signer: false }],
    arbitrageIntent: {
      mints: [{ mint: 'TargetFixture111111111111111111111111111111111', decimals: 6 }],
      dexPrograms,
    },
    candidates: {
      mints: [{ mint: 'TargetFixture111111111111111111111111111111111', decimals: 6 }],
      programs: dexPrograms,
    },
    execution: { kind: 'no_fill', invokedPrograms: [] },
    addressLookupTables: [],
  };
}

try {
  const valid = routeEvent('qualified-route-A', '2020-01-01T00:00:00.000Z', [{ programId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', label: 'Pump.fun AMM' }]);
  const noDex = routeEvent('unqualified-route-B', '2020-01-01T00:00:01.000Z', []);
  // The trailing row deliberately lacks a newline and valid JSON.  The bridge
  // should ignore only this unfinished append and select qualified route A.
  await writeFile(join(directory, 'events.jsonl'), `${JSON.stringify(valid)}\n${JSON.stringify(noDex)}\n{"partial":`, 'utf8');
  await writeFile(join(directory, 'observer.json'), JSON.stringify({
    schemaVersion: 4,
    lastRouteSignature: valid.signature,
    lastRouteObservedAt: valid.observedAt,
    lastRouteFingerprint: null,
  }), 'utf8');

  await execFileAsync(process.execPath, [
    BRIDGE,
    '--once',
    `--events=${join(directory, 'events.jsonl')}`,
    `--observer-state=${join(directory, 'observer.json')}`,
    `--markets-out=${join(directory, 'markets.json')}`,
    `--route-out=${join(directory, 'route.json')}`,
    `--lookup-tables-out=${join(directory, 'lookups.txt')}`,
    `--status-out=${join(directory, 'status.json')}`,
    `--state-out=${join(directory, 'bridge-state.json')}`,
    '--max-observer-staleness-seconds=30',
  ], { cwd: directory, timeout: 10_000, maxBuffer: 256 * 1024 });

  const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
  if (status.status !== 'held' || status.reason !== 'observer_stale' || status.source?.signature !== valid.signature) {
    throw new Error(`unexpected_bridge_status:${JSON.stringify(status)}`);
  }
  console.log(JSON.stringify({ status: 'last_route_bridge_test_passed' }));
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
