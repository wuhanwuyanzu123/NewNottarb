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

// A market state is selected only when both its owner and known account size
// agree. The offset is instruction-relative: it follows the DEX program in
// NotArb's outer NA instruction. Meteora CPMM has one event-authority account
// between its program and the concrete market-state account.
const POOL_LAYOUTS = new Map([
  ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', { label: 'Raydium AMM v4', sizes: new Set([752]), marketOffset: 1 }],
  ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', { label: 'Pump.fun AMM', sizes: new Set([301]), marketOffset: 1 }],
  ['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', { label: 'Meteora CPMM', sizes: new Set([1112]), marketOffset: 2 }],
  ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', { label: 'Meteora DLMM', sizes: new Set([904]), marketOffset: 1 }],
  ['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', { label: 'Orca Whirlpool', sizes: new Set([653]), marketOffset: 1 }],
  // Raydium CLMM uses +1 for readonly AmmConfig and +2 for writable
  // PoolState. The exact size/discriminator were checked against observed
  // LAST route accounts before enabling this legacy bridge fallback.
  ['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', {
    label: 'Raydium CLMM',
    sizes: new Set([1544]),
    discriminator: Buffer.from('f7ede3f5d7c3de46', 'hex'),
    marketOffset: 2,
  }],
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
  const lines = text.split(/\r?\n/);
  const endsWithNewline = /\r?\n$/.test(text);
  const events = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      // appendFile can be observed between the bytes of its final JSONL row.
      // Ignore only that unfinished tail; a malformed completed row remains a
      // hard failure rather than silently selecting arbitrary evidence.
      if (index === lines.length - 1 && !endsWithNewline) continue;
      throw error;
    }
  }
  for (const event of events.reverse()) {
    if (event.watch?.address !== WATCHED_ADDRESS) continue;
    const dexPrograms = event.arbitrageIntent?.dexPrograms ?? event.candidates?.programs ?? [];
    if (!event.success || !event.notArb?.matched || !event.accountKeys?.length || !candidateMints(event).length || !dexPrograms.length) continue;
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

// This intentionally matches grpc-last.mjs:routeFingerprint.  It lets the
// bridge prove that a newer unlogged no-profit check has the same complete
// route evidence as the latest durable snapshot before reusing its pool set.
function routeEvidenceFingerprint(event) {
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
  return JSON.stringify({
    mints: candidateMints(event).map((item) => item.mint).sort(),
    intendedDexes: (event.arbitrageIntent?.dexPrograms ?? []).map((item) => item.programId).sort(),
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
  const hasRouteActivity = Object.prototype.hasOwnProperty.call(observer ?? {}, 'lastRouteObservedAt');
  const lastObservedAt = hasRouteActivity
    ? observer.lastRouteObservedAt ?? fallbackObservedAt
    : observer?.lastObservedAt ?? fallbackObservedAt;
  const ageMs = lastObservedAt ? Date.now() - Date.parse(lastObservedAt) : null;
  return {
    lastObservedAt,
    lastSignature: hasRouteActivity
      ? observer?.lastRouteSignature ?? null
      : observer?.lastSignature ?? null,
    lastSlot: hasRouteActivity
      ? observer?.lastRouteSlot ?? null
      : observer?.lastSlot ?? null,
    routeEvidenceFingerprint: hasRouteActivity
      ? observer?.lastRouteFingerprint ?? null
      : null,
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

function hasNaInstructionVector(event) {
  return Array.isArray(event.notArb?.instructions);
}

function naInstructionMarketCandidates(event) {
  const candidates = [];
  for (const instruction of event.notArb?.instructions ?? []) {
    const accounts = Array.isArray(instruction?.accounts) ? instruction.accounts : [];
    for (const programAccount of accounts) {
      const layout = POOL_LAYOUTS.get(programAccount?.pubkey);
      const dexProgramPosition = programAccount?.position;
      if (!layout || !Number.isInteger(dexProgramPosition)) continue;
      const marketPosition = dexProgramPosition + layout.marketOffset;
      const market = accounts.find((account) => account?.position === marketPosition);
      if (typeof market?.pubkey !== 'string' || market.writable !== true) continue;
      candidates.push({
        address: market.pubkey,
        expectedProgramId: programAccount.pubkey,
        instructionIndex: Number.isInteger(instruction?.index) ? instruction.index : null,
        dexProgramPosition,
        marketPosition,
        marketOffset: layout.marketOffset,
        accountIndex: Number.isInteger(market.accountIndex) ? market.accountIndex : null,
        source: typeof market.source === 'string' ? market.source : null,
        writable: true,
      });
    }
  }
  candidates.sort((left, right) => (left.instructionIndex ?? -1) - (right.instructionIndex ?? -1)
    || left.marketPosition - right.marketPosition
    || left.address.localeCompare(right.address));
  return candidates.filter((candidate, index) => index === 0
    || candidate.instructionIndex !== candidates[index - 1].instructionIndex
    || candidate.marketPosition !== candidates[index - 1].marketPosition
    || candidate.address !== candidates[index - 1].address);
}

function marketCandidates(event) {
  if (hasNaInstructionVector(event)) {
    return { source: 'na_instruction_market_pairs', candidates: naInstructionMarketCandidates(event) };
  }
  // Historical receipts did not retain the ordered NA instruction metas. Keep
  // this fallback only for inspecting old evidence; fresh records never use it.
  const addresses = [...new Set((event.accountKeys ?? []).map((key) => key?.pubkey)
    .filter((address) => typeof address === 'string' && address.length > 0))].sort();
  return {
    source: 'legacy_transaction_accounts',
    candidates: addresses.map((address) => ({
      address,
      expectedProgramId: null,
      instructionIndex: null,
      dexProgramPosition: null,
      marketPosition: null,
      marketOffset: null,
      accountIndex: null,
      source: null,
      writable: false,
    })),
  };
}

function routePools(event, candidates, accounts) {
  const targets = candidateMints(event).map((item) => ({ ...item, bytes: base58Decode(item.mint) }));
  const wsolBytes = base58Decode(WSOL_MINT);
  const discovered = [];
  for (let index = 0; index < candidates.length && index < accounts.length; index += 1) {
    const candidate = candidates[index];
    const { address, account } = accounts[index];
    if (candidate.expectedProgramId && account?.owner !== candidate.expectedProgramId) continue;
    const layout = POOL_LAYOUTS.get(account?.owner);
    const encoded = account?.data?.[0];
    if (!layout || !encoded) continue;
    const data = Buffer.from(encoded, 'base64');
    if (!layout.sizes.has(data.length)) continue;
    if (layout.discriminator && !data.subarray(0, layout.discriminator.length).equals(layout.discriminator)) continue;
    const matches = targets.filter((target) => includesBytes(data, target.bytes));
    // A fresh NA instruction supplies the complete market route. Intermediate
    // WSOL-USDC or target-USDC legs may not contain the headline target mint.
    if (!matches.length && candidate.instructionIndex === null) continue;
    discovered.push({
      address,
      dexProgramId: account.owner,
      dex: layout.label,
      dataLength: data.length,
      targetMints: matches.map((target) => target.mint),
      containsWsol: includesBytes(data, wsolBytes),
      instructionIndex: candidate.instructionIndex,
      dexProgramPosition: candidate.dexProgramPosition,
      marketPosition: candidate.marketPosition,
      marketOffset: candidate.marketOffset,
    });
  }
  return discovered;
}

function marketGroups(source, targets, pools) {
  if (source === 'na_instruction_market_pairs') {
    const byInstruction = new Map();
    for (const pool of pools) {
      if (!Number.isInteger(pool.instructionIndex)) continue;
      const current = byInstruction.get(pool.instructionIndex) ?? [];
      current.push(pool);
      byInstruction.set(pool.instructionIndex, current);
    }
    return [...byInstruction.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, markets]) => {
        const seen = new Set();
        return markets
          .sort((left, right) => left.marketPosition - right.marketPosition || left.address.localeCompare(right.address))
          .map((market) => market.address)
          .filter((address) => {
            if (seen.has(address)) return false;
            seen.add(address);
            return true;
          });
      })
      .filter((group) => group.length >= 2);
  }
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
  const sameActivity = previous?.activity?.signature === status.activity?.signature
    && previous?.activity?.observedAt === status.activity?.observedAt
    && previous?.activity?.routeEvidenceFingerprint === status.activity?.routeEvidenceFingerprint;
  if (previous?.fingerprint === status.fingerprint
    && previous?.status === status.status
    && previous?.reason === status.reason
    && sameActivity) return false;
  await writeJsonAtomically(STATUS_PATH, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ...status,
  });
  return true;
}

async function refreshActiveMarketsHeartbeat() {
  const current = await readJsonIfPresent(MARKETS_PATH);
  const groups = current?.groups;
  if (!Array.isArray(groups) || groups.length === 0) return false;
  // NotArb treats markets_file.update_timestamp as a liveness heartbeat. This
  // is called only after a current, fully validated LAST route has passed all
  // gates below; a quiet or held observer must never keep a bot alive.
  await writeJsonAtomically(MARKETS_PATH, { update_timestamp: Date.now(), groups });
  return true;
}

function observerActivity(observer, fallbackSource, fallbackRouteEvidenceFingerprint) {
  return {
    signature: observer.lastSignature ?? fallbackSource.signature,
    slot: observer.lastSlot ?? fallbackSource.slot,
    observedAt: observer.lastObservedAt ?? fallbackSource.observedAt,
    routeEvidenceFingerprint: observer.routeEvidenceFingerprint ?? fallbackRouteEvidenceFingerprint,
  };
}

async function ensureRouteEvidenceFingerprint(eventEvidenceFingerprint, observer) {
  const current = await readJsonIfPresent(ROUTE_PATH);
  if (!current || current.automation?.routeEvidenceFingerprint === eventEvidenceFingerprint) return;
  await writeJsonAtomically(ROUTE_PATH, {
    ...current,
    automation: {
      ...current.automation,
      routeEvidenceFingerprint: eventEvidenceFingerprint,
      observerLastSeenAt: observer.lastObservedAt,
      bridgeIntervalMs: INTERVAL_MS,
    },
  });
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
  const eventEvidenceFingerprint = routeEvidenceFingerprint(event);
  const bridgeState = await readJsonIfPresent(BRIDGE_STATE_PATH);
  const observer = await observerLiveness(event.observedAt);
  const activity = observerActivity(observer, source, eventEvidenceFingerprint);
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
      activity,
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
  if (observer.routeEvidenceFingerprint && observer.routeEvidenceFingerprint !== eventEvidenceFingerprint) {
    await hold('observer_route_snapshot_pending', {
      observerRouteEvidenceFingerprint: observer.routeEvidenceFingerprint,
      latestSnapshotRouteEvidenceFingerprint: eventEvidenceFingerprint,
    });
    return;
  }
  if (unsupportedDexPrograms.length) {
    await hold('unsupported_candidate_dex', { unsupportedCandidateDexPrograms: unsupportedDexPrograms });
    return;
  }

  const candidateMarkets = marketCandidates(event);
  if (candidateMarkets.source === 'na_instruction_market_pairs' && candidateMarkets.candidates.length === 0) {
    await hold('missing_na_market_pairs', {
      candidateDexPrograms,
      message: 'expanded NA instruction accounts contained no writable supported DEX market-state at its required relative offset',
    });
    return;
  }
  const addresses = candidateMarkets.candidates.map((candidate) => candidate.address);
  const accounts = await getAccounts(addresses);
  const observedAlts = observedLookupTables(event);
  const altAccounts = observedAlts.length ? await getAccounts(observedAlts) : [];
  const { valid: lookupTables, rejected: rejectedLookupTables } = validateLookupTables(altAccounts);
  const targets = candidateMints(event);
  const pools = routePools(event, candidateMarkets.candidates, accounts);
  if (candidateMarkets.source === 'na_instruction_market_pairs'
    && pools.length !== candidateMarkets.candidates.length) {
    await hold('invalid_na_market_pair', {
      candidateMarketCount: candidateMarkets.candidates.length,
      validatedMarketCount: pools.length,
      candidateMarkets: candidateMarkets.candidates.map((candidate) => ({
        address: candidate.address,
        dexProgramId: candidate.expectedProgramId,
        dexProgramPosition: candidate.dexProgramPosition,
        marketPosition: candidate.marketPosition,
        marketOffset: candidate.marketOffset,
      })),
    });
    return;
  }
  const groups = marketGroups(candidateMarkets.source, targets, pools);
  if (rejectedLookupTables.length) {
    await hold('unreadable_route_alt', { observedLookupTables: observedAlts, rejectedLookupTables });
    return;
  }
  if (!groups.length) {
    await hold('insufficient_validated_pools', {
      validatedPoolCount: pools.length,
      marketCandidateSource: candidateMarkets.source,
      candidateDexPrograms,
      observedLookupTables: observedAlts,
    });
    return;
  }

  const activeRouteFingerprint = activeFingerprint(event, groups, lookupTables);
  if (bridgeState?.activeFingerprint === activeRouteFingerprint) {
    await refreshActiveMarketsHeartbeat();
    await ensureRouteEvidenceFingerprint(eventEvidenceFingerprint, observer);
    await publishStatus({
      status: 'active',
      reason: 'unchanged',
      fingerprint: activeRouteFingerprint,
      generation: bridgeState.generation,
      source: bridgeState.source,
      observer,
      activity,
    });
    return;
  }

  const generation = Number(bridgeState?.generation ?? 0) + 1;
  await writeTargetLookupTables(event, lookupTables, generation);
  const generatedAt = new Date().toISOString();
  const validatedMarkets = pools.map((pool) => ({
    ...pool,
    naInstructionReferences: candidateMarkets.candidates
      .filter((candidate) => candidate.address === pool.address)
      .map((candidate) => ({
        topLevelInstructionIndex: candidate.instructionIndex,
        dexProgramId: candidate.expectedProgramId,
        dexProgramPosition: candidate.dexProgramPosition,
        marketPosition: candidate.marketPosition,
        marketOffset: candidate.marketOffset,
        accountIndex: candidate.accountIndex,
        source: candidate.source,
        writable: candidate.writable,
      })),
  }));
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
    marketCandidateSource: candidateMarkets.source,
    validatedMarketStates: validatedMarkets,
    // Compatibility aliases for existing route-inspection tooling.
    poolCandidateSource: candidateMarkets.source,
    validatedPoolStates: validatedMarkets,
    selectedGroups: groups,
    automation: {
      mode: 'auto_follow',
      generation,
      fingerprint: activeRouteFingerprint,
      observerLastSeenAt: observer.lastObservedAt,
      bridgeIntervalMs: INTERVAL_MS,
      routeEvidenceFingerprint: eventEvidenceFingerprint,
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
    activity,
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
