#!/usr/bin/env node
/**
 * Builds a target-specific NotArb markets_file from LAST gRPC evidence.
 *
 * Input:  last-grpc-events.jsonl produced by grpc-last.mjs.
 * Read:   only the local 82 JSON-RPC tunnel for account owner/data lookup.
 * Output: last-target-markets.json (NotArb [[markets_file]] format)
 *         last-target-route.json   (human-readable route evidence)
 *
 * It never loads a keypair, signs, simulates, or sends a transaction.
 * The market file contains only pool-state accounts seen in a LAST route.
 *
 * Examples:
 *   node last-route-to-notarb.mjs --once
 *   node last-route-to-notarb.mjs --interval=15000
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const WATCHED_ADDRESS = 'LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
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
const INTERVAL_MS = boundedNumber(args.get('interval'), 15_000, 5_000, 300_000);
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
    if (!event.notArb?.matched || !event.accountKeys?.length || !candidateMints(event).length) continue;
    return event;
  }
  throw new Error(`No route evidence for ${WATCHED_ADDRESS} in ${EVENTS_PATH}`);
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
      .slice(0, MAX_MARKETS_PER_GROUP)
      .map((pool) => pool.address);
    if (chosen.length >= 2) groups.push(chosen);
  }
  return groups;
}

async function writeJsonAtomically(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function build() {
  const event = await loadLatestLastEvent();
  const addresses = [...new Set(event.accountKeys.map((key) => key.pubkey))];
  const accounts = await getAccounts(addresses);
  const targets = candidateMints(event);
  const pools = routePools(event, accounts);
  const groups = marketGroups(targets, pools);
  if (!groups.length) throw new Error('No LAST candidate route has at least two validated pool-state accounts. Keeping the previous markets file.');
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
    candidateDexPrograms: event.arbitrageIntent?.dexPrograms ?? event.candidates?.programs ?? [],
    validatedPoolStates: pools,
    selectedGroups: groups,
  };
  await writeJsonAtomically(MARKETS_PATH, { update_timestamp: Date.now(), groups });
  await writeJsonAtomically(ROUTE_PATH, route);
  console.log(JSON.stringify({
    status: 'target_markets_written',
    signature: event.signature,
    targetMints: targets.map((target) => target.mint),
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
