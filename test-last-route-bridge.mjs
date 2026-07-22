#!/usr/bin/env node
// Offline bridge parser/gate test.  Its observer state is deliberately stale,
// so the bridge must never issue an RPC request while checking these fixtures.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
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

function encodedAccount(owner, size) {
  return { owner, data: [Buffer.alloc(size).toString('base64'), 'base64'] };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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

  // Exercise the current NA route path end to end. These are 1-based Solscan
  // accounts #11/#19/#28/#37/#45, expressed as 0-based instruction positions.
  const raydium = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
  const dlmm = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
  const orca = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
  const marketAccounts = new Map([
    ['market-11-raydium', encodedAccount(raydium, 752)],
    ['market-19-dlmm', encodedAccount(dlmm, 904)],
    ['market-28-dlmm', encodedAccount(dlmm, 904)],
    ['market-37-orca', encodedAccount(orca, 653)],
    ['market-45-dlmm', encodedAccount(dlmm, 904)],
  ]);
  const rpcServer = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const payload = JSON.parse(text);
    if (payload.method !== 'getMultipleAccounts') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { message: 'unexpected_method' } }));
      return;
    }
    const addresses = payload.params?.[0] ?? [];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: payload.id,
      result: { value: addresses.map((address) => marketAccounts.get(address) ?? null) },
    }));
  });
  const port = await listen(rpcServer);
  try {
    const observedAt = new Date().toISOString();
    const fresh = {
      watch: { address: WATCHED_ADDRESS },
      success: true,
      notArb: {
        matched: true,
        instructions: [{
          index: 2,
          accounts: [
            { position: 9, accountIndex: 109, pubkey: raydium, source: 'lookup_table', writable: false, signer: false },
            { position: 10, accountIndex: 110, pubkey: 'market-11-raydium', source: 'lookup_table', writable: true, signer: false },
            { position: 17, accountIndex: 117, pubkey: dlmm, source: 'lookup_table', writable: false, signer: false },
            { position: 18, accountIndex: 118, pubkey: 'market-19-dlmm', source: 'lookup_table', writable: true, signer: false },
            { position: 26, accountIndex: 126, pubkey: dlmm, source: 'lookup_table', writable: false, signer: false },
            { position: 27, accountIndex: 127, pubkey: 'market-28-dlmm', source: 'lookup_table', writable: true, signer: false },
            { position: 35, accountIndex: 135, pubkey: orca, source: 'lookup_table', writable: false, signer: false },
            { position: 36, accountIndex: 136, pubkey: 'market-37-orca', source: 'lookup_table', writable: true, signer: false },
            { position: 43, accountIndex: 143, pubkey: dlmm, source: 'lookup_table', writable: false, signer: false },
            { position: 44, accountIndex: 144, pubkey: 'market-45-dlmm', source: 'lookup_table', writable: true, signer: false },
          ],
        }],
      },
      signature: 'na-market-pairs',
      slot: '2',
      observedAt,
      accountKeys: [{ pubkey: 'route-evidence', writable: true, signer: false }],
      arbitrageIntent: {
        mints: [{ mint: 'So11111111111111111111111111111111111111112', decimals: 9 }],
        dexPrograms: [
          { programId: raydium, label: 'Raydium AMM v4' },
          { programId: dlmm, label: 'Meteora DLMM' },
          { programId: orca, label: 'Orca Whirlpool' },
        ],
      },
      execution: { kind: 'no_fill', invokedPrograms: [] },
      addressLookupTables: [],
    };
    await writeFile(join(directory, 'fresh-events.jsonl'), `${JSON.stringify(fresh)}\n`, 'utf8');
    await writeFile(join(directory, 'fresh-observer.json'), JSON.stringify({
      schemaVersion: 4,
      lastRouteSignature: fresh.signature,
      lastRouteObservedAt: observedAt,
    }), 'utf8');
    await execFileAsync(process.execPath, [
      BRIDGE,
      '--once',
      `--rpc=http://127.0.0.1:${port}`,
      `--events=${join(directory, 'fresh-events.jsonl')}`,
      `--observer-state=${join(directory, 'fresh-observer.json')}`,
      `--markets-out=${join(directory, 'fresh-markets.json')}`,
      `--route-out=${join(directory, 'fresh-route.json')}`,
      `--lookup-tables-out=${join(directory, 'fresh-lookups.txt')}`,
      `--status-out=${join(directory, 'fresh-status.json')}`,
      `--state-out=${join(directory, 'fresh-bridge-state.json')}`,
      '--max-observer-staleness-seconds=30',
    ], { cwd: directory, timeout: 10_000, maxBuffer: 256 * 1024 });

    const markets = JSON.parse(await readFile(join(directory, 'fresh-markets.json'), 'utf8'));
    const expectedGroup = [[
      'market-11-raydium',
      'market-19-dlmm',
      'market-28-dlmm',
      'market-37-orca',
      'market-45-dlmm',
    ]];
    if (!Number.isInteger(markets.update_timestamp) || JSON.stringify(markets.groups) !== JSON.stringify(expectedGroup)) {
      throw new Error(`unexpected_notarb_markets_file:${JSON.stringify(markets)}`);
    }
    const route = JSON.parse(await readFile(join(directory, 'fresh-route.json'), 'utf8'));
    if (route.marketCandidateSource !== 'na_instruction_market_pairs'
      || route.validatedMarketStates?.length !== expectedGroup[0].length
      || route.selectedGroups?.[0]?.join(',') !== expectedGroup[0].join(',')) {
      throw new Error(`unexpected_na_market_route:${JSON.stringify(route)}`);
    }
  } finally {
    await close(rpcServer);
  }
  console.log(JSON.stringify({ status: 'last_route_bridge_test_passed' }));
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
