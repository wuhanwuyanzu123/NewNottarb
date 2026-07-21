#!/usr/bin/env node
/**
 * Builds a target-specific NotArb markets_file from LAST gRPC evidence.
 *
 * Input:  last-grpc-events.jsonl produced by grpc-last.mjs.
 * Read:   only the local 82 JSON-RPC tunnel for account owner/data lookup.
 * Output: last-target-markets.json (NotArb [[markets_file]] format)
 *         last-target-route.json   (human-readable route evidence)
 *         last-target-status.json  (active/held auto-follow state)
 *
 * It never loads a keypair, signs, simulates, or sends a transaction.
 * The market file contains only pool-state accounts seen in a LAST route.
 *
 * Examples:
 *   node last-route-to-notarb.mjs --once
 *   node last-route-to-notarb.mjs --interval=15000
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import process from 'node:process';

const WATCHED_ADDRESS = 'LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const ADDRESS_LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// A pool state is selected only when both its owner and known account size
// agree. This excludes DEX globals, bin arrays, vaults, and program configs.
const POOL_LAYOUTS = new Map([
  ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', { label: 'Raydium AMM v4', sizes: new Set([752]) }],
  ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', { label: 'Pump.fun AMM', sizes: new Set([301]) }],
  ['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', { label: 'Meteora CPMM', sizes: new Set([1112]) }],
  ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', { label: 'Meteora DLMM', sizes: new Set([904]) }],
]);

const args = parseArgs(process.argv.slice(2));
const ROOT = resolve(process.cwd());
const RPC_URL = args.get('rpc') ?? process.env.LAST_ROUTE_RPC_URL ?? 'http://127.0.0.1:18899';
const EVENTS_PATH = resolve(ROOT, args.get('events') ?? 'last-grpc-events.jsonl');
const MARKETS_PATH = resolve(ROOT, args.get('markets-out') ?? 'last-target-markets.json');
const ROUTE_PATH = resolve(ROOT, args.get('route-out') ?? 'last-target-route.json');
const LOOKUP_TABLES_PATH = resolve(ROOT, args.get('lookup-tables-out') ?? 'last-target-lookup-tables.txt');
const STATUS_PATH = resolve(ROOT, args.get('status-out') ?? 'last-target-status.json');
const BRIDGE_STATE_PATH = resolve(ROOT, args.get('state-out') ?? '.last-route-bridge-state.json');
const OBSERVER_STATE_PATH = resolve(ROOT, args.get('observer-state') ?? '.last-grpc-state.json');
const INTERVAL_MS = boundedNumber(args.get('interval'), 15_000, 5_000, 300_000);
const MAX_OBSERVER_STALENESS_MS = boundedNumber(args.get('max-observer-staleness-seconds'), 120, 30, 3_600) * 1_000;
const ONCE = args.has('once');
const MAX_MARKETS_PER_GROUP = boundedNumber(args.get('max-markets'), 4, 2, 8);

let rpcId = 0;
let stopping = false;

function parseArgs(argv) {
  const output = new Map();
  for (const argument of argv) {
    if (!argument.startsWith('--')) continue;
    const value = argument.slice(2);
    const separator = value.indexOf('=');
    output.set(separator < 0 ? value : value.slice(0, separator), separator < 0 ? 'true' : value.slice(separator + 1));
  }
  return output;
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function base58Decode(value) {
  if (!value) return Buffer.alloc(0);
  const bytes = [0];
  for (const character of value) {
    let carry = BASE58_ALPHABET.indexOf(character);
    if (carry < 0) throw new Error(`Invalid base58 value: ${value}`);
    for (let index = 0; index < bytes.length; index += 1) {
      const current = bytes[index] * 58 + carry;
      bytes[index] = current & 0xff;
      carry = current >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length - 1 && value[leadingZeroes] === '1') leadingZeroes += 1;
  return Buffer.from([...Array(leadingZeroes).fill(0), ...bytes.reverse()]);
}

function includesBytes(haystack, needle) {
  return needle.length > 0 && haystack.indexOf(needle) >= 0;
}

function candidateMints(event) {
  return event.arbitrageIntent?.mints ?? event.candidates?.mints ?? [];
}

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error(`${method}: ${body.error?.message ?? `HTTP ${response.status}`}`);
  return body.result;
}

async function loadLatestLastEvent() {
  const text = await readFile(EVENTS_PATH, 'utf8');
  const events = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  for (const event of events.reverse()) {
    if (event.watch?.address !== WATCHED_ADDRESS) continue;
    if (!event.success || !event.notArb?.matched || !event.accountKeys?.length || !candidateMints(event).length) continue;
    return event;
  }
  throw new Error(`No route evidence for ${WATCHED_ADDRESS} in ${EVENTS_PATH}`);
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function routeSource(event) {
  return {
    watchedAddress: WATCHED_ADDRESS,
    signature: event.signature,
    slot: event.slot,
    observedAt: event.observedAt,
  };
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function routeFingerprint(event) {
  const sortIndexes = (indexes) => [...(indexes ?? [])].sort((left, right) => left - right);
  const altSelections = (event.addressLookupTables ?? [])
    .map((table) => ({
      address: table.address,
      writableIndexes: sortIndexes(table.writableIndexes),
      readonlyIndexes: sortIndexes(table.readonlyIndexes),
    }))
    .sort((left, right) => left.address.localeCompare(right.address));
  const writableRouteAccounts = (event.accountKeys ?? [])
    .filter((key) => key.writable && !key.signer)
    .map((key) => key.pubkey)
    .sort();
  return fingerprint({
    mints: candidateMints(event).map((item) => item.mint).sort(),
    candidateDexes: (event.arbitrageIntent?.dexPrograms ?? event.candidates?.programs ?? [])
      .map((item) => item.programId)
      .sort(),
    invokedDexes: (event.execution?.invokedPrograms ?? []).map((item) => item.programId).sort(),
    executionKind: event.execution?.kind ?? null,
    altSelections,
    writableRouteAccounts,
  });
}

function unsupportedCandidateDexes(event) {
  return (event.arbitrageIntent?.dexPrograms ?? event.candidates?.programs ?? [])
    .filter((program) => !POOL_LAYOUTS.has(program.programId));
}

async function observerLiveness(fallbackObservedAt = null) {
  const observer = await readJsonIfPresent(OBSERVER_STATE_PATH);
  const lastObservedAt = observer?.lastObservedAt ?? fallbackObservedAt;
  const ageMs = lastObservedAt ? Date.now() - Date.parse(lastObservedAt) : null;
  return {
    lastObservedAt,
    stale: ageMs !== null && (!Number.isFinite(ageMs) || ageMs > MAX_OBSERVER_STALENESS_MS),
  };
}

async function getAccounts(addresses) {
  const result = [];
  for (let offset = 0; offset < addresses.length; offset += 100) {
    const chunk = addresses.slice(offset, offset + 100);
    const response = await rpc('getMultipleAccounts', [chunk, { encoding: 'base64' }]);
    for (let index = 0; index < chunk.length; index += 1) {
      const account = response.value?.[index] ?? null;
      result.push({ address: chunk[index], account });
    }
  }
  return result;
}

function routePools(event, accounts) {
  const targets = candidateMints(event).map((item) => ({ ...item, bytes: base58Decode(item.mint) }));
  const wsolBytes = base58Decode(WSOL_MINT);
  const discovered = [];
  for (const { address, account } of accounts) {
    const layout = POOL_LAYOUTS.get(account?.owner);
    const encoded = account?.data?.[0];
    if (!layout || !encoded) continue;
    const data = Buffer.from(encoded, 'base64');
    if (!layout.sizes.has(data.length)) continue;
    const matches = targets.filter((target) => includesBytes(data, target.bytes));
    if (!matches.length) continue;
    discovered.push({
      address,
      dexProgramId: account.owner,
      dex: layout.label,
      dataLength: data.length,
      targetMints: matches.map((target) => target.mint),
      containsWsol: includesBytes(data, wsolBytes),
    });
  }
  return discovered;
}

function marketGroups(targets, pools) {
  const groups = [];
  for (const target of targets) {
    const candidates = pools.filter((pool) => pool.targetMints.includes(target.mint));
    const direct = candidates.filter((pool) => pool.containsWsol);
    const chosen = (direct.length >= 2 ? direct : candidates)
      .sort((left, right) => left.address.localeCompare(right.address))
      .slice(0, MAX_MARKETS_PER_GROUP)
      .map((pool) => pool.address)
      .sort();
    if (chosen.length >= 2) groups.push(chosen);
  }
  return groups.sort((left, right) => left.join(',').localeCompare(right.join(',')));
}

async function writeJsonAtomically(path, value) {
  await writeTextAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomically(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, value, 'utf8');
  await rename(temporary, path);
}

function activeFingerprint(event, groups, lookupTables) {
  return fingerprint({
    targetMints: candidateMints(event).map((item) => item.mint).sort(),
    candidateDexes: (event.arbitrageIntent?.dexPrograms ?? event.candidates?.programs ?? [])
      .map((item) => item.programId)
      .sort(),
    groups,
    lookupTables: [...lookupTables].sort(),
  });
}

async function publishStatus(status) {
  const previous = await readJsonIfPresent(STATUS_PATH);
  if (previous?.fingerprint === status.fingerprint) return false;
  await writeJsonAtomically(STATUS_PATH, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ...status,
  });
  return true;
}

function observedLookupTables(event) {
  return [...new Set((event.addressLookupTables ?? [])
    .map((table) => table?.address)
    .filter((address) => typeof address === 'string' && address.length > 0))];
}

function validateLookupTables(accounts) {
  const valid = [];
  const rejected = [];
  for (const { address, account } of accounts) {
    let reason = null;
    if (!account) reason = 'account_not_found';
    else if (account.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM) reason = `unexpected_owner:${account.owner ?? 'unknown'}`;
    else if (typeof account.data?.[0] !== 'string' || account.data[0].length === 0) reason = 'missing_binary_account_data';
    if (reason) rejected.push({ address, reason });
    else valid.push(address);
  }
  return { valid, rejected };
}

async function writeTargetLookupTables(event, tables, generation) {
  const header = [
    '# Generated by last-route-to-notarb.mjs from one LAST gRPC route.',
    `# watched address: ${WATCHED_ADDRESS}`,
    `# source signature: ${event.signature}`,
    `# source observed at: ${event.observedAt}`,
    `# target generation: ${generation}`,
    '# These are currently valid, route-specific public ALT accounts, not a send authorization.',
  ];
  if (!tables.length) header.push('# No observed ALT account is currently usable through the local 82 read-RPC tunnel.');
  await writeTextAtomically(LOOKUP_TABLES_PATH, `${[...header, ...tables].join('\n')}\n`);
  return tables;
}

async function build() {
  const event = await loadLatestLastEvent();
  const source = routeSource(event);
  const routeId = routeFingerprint(event);
  const bridgeState = await readJsonIfPresent(BRIDGE_STATE_PATH);
  const observer = await observerLiveness(event.observedAt);
  const candidateDexPrograms = event.arbitrageIntent?.dexPrograms ?? event.candidates?.programs ?? [];
  const unsupportedDexPrograms = unsupportedCandidateDexes(event);
  const hold = async (reason, details = {}) => {
    const statusFingerprint = fingerprint({ status: 'held', reason, routeId, details });
    const status = {
      status: 'held',
      reason,
      fingerprint: statusFingerprint,
      source,
      observer,
      activeTarget: bridgeState
        ? { generation: bridgeState.generation, source: bridgeState.source }
        : null,
      ...details,
    };
    if (await publishStatus(status)) console.error(JSON.stringify({ status: 'target_route_held', reason, source, ...details }));
  };

  if (observer.stale) {
    await hold('observer_stale', { maxObserverStalenessMs: MAX_OBSERVER_STALENESS_MS });
    return;
  }
  if (unsupportedDexPrograms.length) {
    await hold('unsupported_candidate_dex', { unsupportedCandidateDexPrograms: unsupportedDexPrograms });
    return;
  }

  const addresses = [...new Set(event.accountKeys.map((key) => key.pubkey))];
  const accounts = await getAccounts(addresses);
  const observedAlts = observedLookupTables(event);
  const altAccounts = observedAlts.length ? await getAccounts(observedAlts) : [];
  const { valid: lookupTables, rejected: rejectedLookupTables } = validateLookupTables(altAccounts);
  const targets = candidateMints(event);
  const pools = routePools(event, accounts);
  const groups = marketGroups(targets, pools);
  if (rejectedLookupTables.length) {
    await hold('unreadable_route_alt', { observedLookupTables: observedAlts, rejectedLookupTables });
    return;
  }
  if (!groups.length) {
    await hold('insufficient_validated_pools', {
      validatedPoolCount: pools.length,
      candidateDexPrograms,
      observedLookupTables: observedAlts,
    });
    return;
  }

  const activeRouteFingerprint = activeFingerprint(event, groups, lookupTables);
  if (bridgeState?.activeFingerprint === activeRouteFingerprint) {
    await publishStatus({
      status: 'active',
      reason: 'unchanged',
      fingerprint: activeRouteFingerprint,
      generation: bridgeState.generation,
      source: bridgeState.source,
      observer,
    });
    return;
  }

  const generation = Number(bridgeState?.generation ?? 0) + 1;
  await writeTargetLookupTables(event, lookupTables, generation);
  const generatedAt = new Date().toISOString();
  const route = {
    schemaVersion: 1,
    generatedAt,
    source: {
      type: 'LAST Yellowstone gRPC evidence plus 82 read-RPC account ownership verification',
      watchedAddress: WATCHED_ADDRESS,
      signature: event.signature,
      slot: event.slot,
      observedAt: event.observedAt,
    },
    baseMint: WSOL_MINT,
    targets: targets.map(({ bytes, ...target }) => target),
    candidateDexPrograms,
    unsupportedCandidateDexPrograms: unsupportedDexPrograms,
    observedLookupTables: observedAlts,
    selectedLookupTables: lookupTables,
    rejectedLookupTables,
    validatedPoolStates: pools,
    selectedGroups: groups,
    automation: {
      mode: 'auto_follow',
      generation,
      fingerprint: activeRouteFingerprint,
      observerLastSeenAt: observer.lastObservedAt,
      bridgeIntervalMs: INTERVAL_MS,
    },
  };
  await writeJsonAtomically(ROUTE_PATH, route);
  // Commit the actual markets file last. The dry-run bot only acts on this
  // file, so it cannot see a new pool group before the matching ALT evidence
  // and human-readable route record have been written.
  await writeJsonAtomically(MARKETS_PATH, { update_timestamp: Date.now(), groups });
  await writeJsonAtomically(BRIDGE_STATE_PATH, {
    schemaVersion: 1,
    generation,
    activeFingerprint: activeRouteFingerprint,
    source,
    updatedAt: generatedAt,
  });
  await publishStatus({
    status: 'active',
    reason: 'target_auto_follow',
    fingerprint: activeRouteFingerprint,
    generation,
    source,
    observer,
    targetMints: targets.map((target) => target.mint),
    candidateDexPrograms,
    lookupTables,
    pools: pools.map((pool) => ({ address: pool.address, dex: pool.dex, containsWsol: pool.containsWsol })),
    groups,
  });
  console.log(JSON.stringify({
    status: 'target_route_switched',
    generation,
    signature: source.signature,
    targetMints: targets.map((target) => target.mint),
    candidateDexPrograms,
    observedLookupTables: observedAlts,
    lookupTables,
    rejectedLookupTables,
    pools: pools.map((pool) => ({ address: pool.address, dex: pool.dex, containsWsol: pool.containsWsol })),
    groups,
  }));
}

async function main() {
  do {
    try { await build(); } catch (error) { console.error(JSON.stringify({ status: 'target_markets_error', error: String(error) })); }
    if (ONCE || stopping) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, INTERVAL_MS));
  } while (!stopping);
}

process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
await main();
