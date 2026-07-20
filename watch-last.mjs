#!/usr/bin/env node
/**
 * Durable, read-only transaction watcher for LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9.
 *
 * It makes only Solana JSON-RPC read calls plus optional public DexScreener
 * quote lookups. It never reads a keypair, signs, simulates, sends, or alters
 * an on-chain transaction. State is cursor-based so bursts larger than one RPC
 * page are paginated instead of silently discarded.
 *
 * Examples:
 *   node watch-last.mjs --interval=3000
 *   node watch-last.mjs --reconcile=1000 --max-txs=1000 --once
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const WATCHED_ADDRESS = 'LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9';
const NOTARB_PROGRAM = 'NA247a7YE9S3p9CdKmMyETx8TTwbSdVbVYHHxpnHTUV';
const args = parseArgs(process.argv.slice(2));
const RPC_URL = args.get('rpc') ?? process.env.SOLANA_RPC_URL ?? 'https://solana-rpc.publicnode.com';
const INTERVAL_MS = numberArg('interval', 3_000, 1_000, 300_000);
const RECONCILE = numberArg('reconcile', 0, 0, 50_000);
const MAX_TXS_PER_CYCLE = numberArg('max-txs', 500, 1, 5_000);
const MAX_PAGES = numberArg('max-pages', 100, 1, 1_000);
const FETCH_CONCURRENCY = numberArg('concurrency', 8, 1, 32);
const ONCE = args.has('once');
// A large historical reconciliation should prioritize complete on-chain
// coverage. External quote requests are intentionally skipped in that case;
// normal live polling still enriches new candidates with timestamped quotes.
const ENABLE_QUOTES = args.get('quotes') === 'true' || (args.get('quotes') !== 'false' && RECONCILE <= 100);
const ROOT = resolve(process.cwd());
const STATE_PATH = resolve(ROOT, '.last-watch-state.json');
const LOG_PATH = resolve(ROOT, 'last-events.jsonl');
const ERROR_PATH = resolve(ROOT, 'last-watch-errors.jsonl');
const PAGE_LIMIT = 1_000;
const MAX_SEEN = 20_000;
const MAX_RETRIES = 5_000;

// DEX labels and optional DexScreener IDs used only for timestamped candidate
// quotes. Presence in a transaction's metas is not evidence of execution.
const DEX_PROGRAMS = new Map([
  ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', { label: 'Pump.fun AMM', dexScreenerIds: ['pumpswap', 'pumpfun'] }],
  ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', { label: 'Meteora DLMM', dexScreenerIds: ['meteora'] }],
  ['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', { label: 'Meteora CPMM', dexScreenerIds: ['meteora'] }],
  ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', { label: 'Raydium AMM v4', dexScreenerIds: ['raydium'] }],
  ['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', { label: 'Raydium CPMM', dexScreenerIds: ['raydium'] }],
  ['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', { label: 'Raydium CLMM', dexScreenerIds: ['raydium'] }],
  ['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', { label: 'Orca Whirlpool', dexScreenerIds: ['orca'] }],
  ['FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq', { label: 'Futarchy AMM', dexScreenerIds: [] }],
  ['JUP6LkbZbjS1jKKwapd1P1Bq6yDga4zhshLz7G8b35', { label: 'Jupiter v6', dexScreenerIds: [] }],
]);

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const STABLE_MINTS = new Set([
  WSOL_MINT,
  USDC_MINT,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
]);

let rpcId = 0;
const altCache = new Map();
const dexScreenerCache = new Map();
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function parseArgs(argv) {
  const result = new Map();
  for (const item of argv) {
    if (!item.startsWith('--')) continue;
    const clean = item.slice(2);
    const equals = clean.indexOf('=');
    result.set(equals >= 0 ? clean.slice(0, equals) : clean, equals >= 0 ? clean.slice(equals + 1) : 'true');
  }
  return result;
}

function numberArg(name, fallback, min, max) {
  const parsed = Number(args.get(name));
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

async function rpc(method, params, attempts = 4) {
  let latestError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${method}: HTTP ${response.status} ${payload.error?.message ?? ''}`.trim());
      if (payload.error) throw new Error(`${method}: ${payload.error.message ?? JSON.stringify(payload.error)}`);
      return payload.result;
    } catch (error) {
      latestError = error;
      if (attempt < attempts) await wait(Math.min(5_000, 250 * (2 ** (attempt - 1))));
    }
  }
  throw latestError;
}

async function rpcBatch(calls) {
  const requests = calls.map(({ method, params }) => ({ jsonrpc: '2.0', id: ++rpcId, method, params }));
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requests),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(payload)) throw new Error(`JSON-RPC batch unavailable: HTTP ${response.status}`);
  const byId = new Map(payload.map((item) => [item.id, item]));
  return requests.map((request) => byId.get(request.id) ?? { error: { message: 'missing batch response' } });
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function accountKeys(message) {
  return (message.accountKeys ?? []).map((entry, index) => ({
    index,
    pubkey: typeof entry === 'string' ? entry : entry.pubkey,
    signer: typeof entry === 'string' ? false : Boolean(entry.signer),
    writable: typeof entry === 'string' ? false : Boolean(entry.writable),
  }));
}

function programId(instruction, keys) {
  return instruction.programId ?? keys[instruction.programIdIndex]?.pubkey ?? null;
}

function toUiAmount(raw, decimals) {
  const normalized = typeof raw === 'bigint' ? raw : BigInt(raw);
  const sign = normalized < 0n ? '-' : '';
  const digits = (normalized < 0n ? -normalized : normalized).toString().padStart(decimals + 1, '0');
  if (decimals === 0) return `${sign}${digits}`;
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

function tokenBalanceRows(meta) {
  const rows = new Map();
  const add = (balance, side) => {
    const key = `${balance.accountIndex}:${balance.mint}`;
    const current = rows.get(key) ?? {
      accountIndex: balance.accountIndex,
      mint: balance.mint,
      owner: balance.owner ?? null,
      programId: balance.programId ?? null,
      decimals: balance.uiTokenAmount.decimals,
      pre: 0n,
      post: 0n,
    };
    current[side] = BigInt(balance.uiTokenAmount.amount);
    rows.set(key, current);
  };
  for (const balance of meta.preTokenBalances ?? []) add(balance, 'pre');
  for (const balance of meta.postTokenBalances ?? []) add(balance, 'post');
  return [...rows.values()];
}

function walletTokenDeltas(meta) {
  const byMint = new Map();
  for (const row of tokenBalanceRows(meta)) {
    if (row.owner !== WATCHED_ADDRESS) continue;
    const item = byMint.get(row.mint) ?? { mint: row.mint, decimals: row.decimals, rawDelta: 0n };
    item.rawDelta += row.post - row.pre;
    byMint.set(row.mint, item);
  }
  return [...byMint.values()]
    .filter((item) => item.rawDelta !== 0n)
    .map(({ rawDelta, ...item }) => ({ ...item, uiDelta: toUiAmount(rawDelta, item.decimals) }));
}

function candidateMints(meta) {
  const result = new Map();
  for (const row of tokenBalanceRows(meta)) {
    if (STABLE_MINTS.has(row.mint)) continue;
    const existing = result.get(row.mint) ?? { mint: row.mint, decimals: row.decimals, evidence: new Set() };
    existing.evidence.add(row.owner === WATCHED_ADDRESS ? 'wallet_token_account' : 'transaction_token_account');
    result.set(row.mint, existing);
  }
  return [...result.values()].map((item) => ({ ...item, evidence: [...item.evidence] }));
}

function summarizeMints(meta) {
  const byMint = new Map();
  for (const row of tokenBalanceRows(meta)) {
    const existing = byMint.get(row.mint) ?? { mint: row.mint, decimals: row.decimals, accountCount: 0 };
    existing.accountCount += 1;
    byMint.set(row.mint, existing);
  }
  return [...byMint.values()];
}

function candidatePrograms(keys, invokedIds) {
  const invoked = new Set(invokedIds);
  const results = [];
  for (const key of keys) {
    const dex = DEX_PROGRAMS.get(key.pubkey);
    if (dex && !invoked.has(key.pubkey)) results.push({ programId: key.pubkey, label: dex.label, role: 'candidate_meta' });
  }
  return results;
}

function invokedDexPrograms(transaction, keys) {
  const found = new Set();
  for (const instruction of transaction.transaction.message.instructions ?? []) {
    const id = programId(instruction, keys);
    if (DEX_PROGRAMS.has(id)) found.add(id);
  }
  for (const group of transaction.meta?.innerInstructions ?? []) {
    for (const instruction of group.instructions ?? []) {
      const id = programId(instruction, keys);
      if (DEX_PROGRAMS.has(id)) found.add(id);
    }
  }
  return [...found].map((id) => ({ programId: id, label: DEX_PROGRAMS.get(id).label }));
}

function deriveRealizedPrice(deltas) {
  const target = deltas.filter((item) => !STABLE_MINTS.has(item.mint));
  const base = deltas.filter((item) => item.mint === WSOL_MINT || item.mint === USDC_MINT);
  if (target.length !== 1 || base.length !== 1) return null;
  const tokenAmount = Math.abs(Number(target[0].uiDelta));
  const baseAmount = Math.abs(Number(base[0].uiDelta));
  if (!Number.isFinite(tokenAmount) || !Number.isFinite(baseAmount) || tokenAmount === 0 || baseAmount === 0) return null;
  return {
    method: 'wallet_balance_delta',
    baseMint: base[0].mint,
    quoteMint: target[0].mint,
    price: String(baseAmount / tokenAmount),
    denomination: `${base[0].mint} per ${target[0].mint}`,
  };
}

async function resolveLookupTable(address) {
  if (altCache.has(address)) return altCache.get(address);
  // PublicNode does not expose Solana's getAddressLookupTable convenience
  // method. Decode its ordinary account data instead: ALT metadata occupies
  // 56 bytes and the remaining data is packed 32-byte public keys.
  const promise = rpc('getAccountInfo', [address, { commitment: 'finalized', encoding: 'base64' }])
    .then((result) => {
      const encoded = result?.value?.data?.[0];
      if (!encoded) return [];
      const bytes = Buffer.from(encoded, 'base64');
      const addresses = [];
      for (let offset = 56; offset + 32 <= bytes.length; offset += 32) {
        addresses.push(base58Encode(bytes.subarray(offset, offset + 32)));
      }
      return addresses;
    })
    .catch(() => []);
  altCache.set(address, promise);
  return promise;
}

function base58Encode(bytes) {
  if (bytes.length === 0) return '';
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index] * 256 + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length - 1 && bytes[leadingZeroes] === 0) leadingZeroes += 1;
  return `${'1'.repeat(leadingZeroes)}${digits.reverse().map((digit) => BASE58_ALPHABET[digit]).join('')}`;
}

async function addressLookupTables(message) {
  const lookups = message.addressTableLookups ?? [];
  return Promise.all(lookups.map(async (lookup) => {
    const addresses = await resolveLookupTable(lookup.accountKey);
    const resolveIndexes = (indexes) => indexes.map((index) => ({ index, address: addresses[index] ?? null }));
    return {
      address: lookup.accountKey,
      writableIndexes: lookup.writableIndexes ?? [],
      readonlyIndexes: lookup.readonlyIndexes ?? [],
      resolvedWritable: resolveIndexes(lookup.writableIndexes ?? []),
      resolvedReadonly: resolveIndexes(lookup.readonlyIndexes ?? []),
    };
  }));
}

async function fetchDexScreenerPairs(mint) {
  if (!ENABLE_QUOTES) return [];
  const cached = dexScreenerCache.get(mint);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
  const value = fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(10_000) })
    .then(async (response) => response.ok ? response.json() : { pairs: [] })
    .then((payload) => (payload.pairs ?? []).filter((pair) => pair.chainId === 'solana'))
    .catch(() => []);
  dexScreenerCache.set(mint, { at: Date.now(), value });
  return value;
}

async function candidatePoolQuotes(mints, programs, keys) {
  if (!ENABLE_QUOTES) return [];
  const keySet = new Set(keys.map((key) => key.pubkey));
  const allowedDexIds = new Set(programs.flatMap((program) => DEX_PROGRAMS.get(program.programId)?.dexScreenerIds ?? []));
  if (allowedDexIds.size === 0) return [];
  const results = [];
  for (const mint of mints.slice(0, 3)) {
    const pairs = await fetchDexScreenerPairs(mint.mint);
    for (const pair of pairs) {
      if (!keySet.has(pair.pairAddress) || !allowedDexIds.has(pair.dexId)) continue;
      results.push({
        address: pair.pairAddress,
        protocol: pair.dexId,
        baseMint: pair.baseToken?.address ?? null,
        quoteMint: pair.quoteToken?.address ?? null,
        confidence: 'message_meta_plus_external_pair_match',
        quote: {
          kind: 'external_candidate_quote',
          source: 'DexScreener',
          observedAt: new Date().toISOString(),
          priceNative: pair.priceNative ?? null,
          priceUsd: pair.priceUsd ?? null,
          liquidityUsd: pair.liquidity?.usd ?? null,
        },
      });
    }
  }
  return [...new Map(results.map((item) => [item.address, item])).values()];
}

async function summarize(signatureInfo, transaction) {
  const message = transaction.transaction.message;
  const keys = accountKeys(message);
  const watchedIndex = keys.findIndex((key) => key.pubkey === WATCHED_ADDRESS);
  const rawLamportDelta = watchedIndex >= 0
    ? BigInt(transaction.meta.postBalances[watchedIndex]) - BigInt(transaction.meta.preBalances[watchedIndex])
    : 0n;
  const logs = transaction.meta.logMessages ?? [];
  const noProfitLogs = logs.filter((line) => /No arbitrage profit found!/i.test(line));
  const topLevelNotArbIndexes = (message.instructions ?? [])
    .map((instruction, index) => ({ index, programId: programId(instruction, keys) }))
    .filter((item) => item.programId === NOTARB_PROGRAM)
    .map((item) => item.index);
  const invokedPrograms = invokedDexPrograms(transaction, keys);
  const deltas = walletTokenDeltas(transaction.meta);
  const mints = candidateMints(transaction.meta);
  const candidates = candidatePrograms(keys, invokedPrograms.map((item) => item.programId));
  const [lookupTables, pools] = await Promise.all([
    addressLookupTables(message),
    candidatePoolQuotes(mints, candidates, keys),
  ]);
  const executionKind = noProfitLogs.length > 0
    ? 'no_fill'
    : invokedPrograms.length > 0 && deltas.length > 0
      ? 'fill'
      : transaction.meta.err ? 'failed'
        : 'unknown';

  return {
    schemaVersion: 2,
    source: {
      rpc: RPC_URL,
      enumerationCommitment: 'finalized',
      transactionCommitment: 'finalized',
      parserVersion: '2.0.0',
    },
    observedAt: new Date().toISOString(),
    signature: signatureInfo.signature,
    slot: transaction.slot,
    blockTime: transaction.blockTime ? new Date(transaction.blockTime * 1000).toISOString() : null,
    transactionVersion: transaction.version ?? 0,
    success: transaction.meta.err === null,
    watch: {
      address: WATCHED_ADDRESS,
      feePayer: keys[0]?.pubkey ?? null,
      isSigner: Boolean(keys.find((key) => key.pubkey === WATCHED_ADDRESS)?.signer),
    },
    notArb: {
      matched: topLevelNotArbIndexes.length > 0,
      programId: topLevelNotArbIndexes.length > 0 ? NOTARB_PROGRAM : null,
      topLevelInstructionIndexes: topLevelNotArbIndexes,
      outcome: noProfitLogs.length > 0 ? 'no_arbitrage_profit' : executionKind,
      matchedLogs: noProfitLogs,
    },
    balances: {
      lamports: watchedIndex >= 0 ? {
        pre: String(transaction.meta.preBalances[watchedIndex]),
        post: String(transaction.meta.postBalances[watchedIndex]),
        rawDelta: String(rawLamportDelta),
        uiDelta: toUiAmount(rawLamportDelta, 9),
        feeLamports: transaction.meta.fee,
      } : null,
      walletTokenDeltas: deltas,
      transactionMints: summarizeMints(transaction.meta),
    },
    candidates: {
      mints,
      programs: candidates,
      pools,
    },
    execution: {
      kind: executionKind,
      invokedPrograms,
      realizedPrice: executionKind === 'fill' ? deriveRealizedPrice(deltas) : null,
    },
    addressLookupTables: lookupTables,
    computeUnitsConsumed: transaction.meta.computeUnitsConsumed ?? null,
    logTail: logs.slice(-8),
  };
}

async function readLogSignatures() {
  try {
    const text = await readFile(LOG_PATH, 'utf8');
    const found = new Set();
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.signature) found.add(parsed.signature);
      } catch {
        // A partially written JSONL tail is retried by the normal RPC path.
      }
    }
    return found;
  } catch {
    return new Set();
  }
}

async function loadState() {
  let parsed = {};
  try { parsed = JSON.parse(await readFile(STATE_PATH, 'utf8')); } catch { /* first run */ }
  const seen = new Set([...(parsed.seen ?? []), ...(parsed.signatures ?? []), ...await readLogSignatures()]);
  return {
    schemaVersion: 2,
    cursor: parsed.cursor ?? parsed.lastSignature ?? parsed.signatures?.[0] ?? null,
    seen,
    retries: [...new Set(parsed.retries ?? [])],
  };
}

async function saveState(state) {
  const serializable = {
    schemaVersion: 2,
    cursor: state.cursor,
    seen: [...state.seen].slice(-MAX_SEEN),
    retries: state.retries.slice(-MAX_RETRIES),
    savedAt: new Date().toISOString(),
  };
  const temporary = `${STATE_PATH}.tmp`;
  await writeFile(temporary, JSON.stringify(serializable, null, 2));
  await rename(temporary, STATE_PATH);
}

async function appendJsonLine(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}

async function logEvent(event) {
  await appendJsonLine(LOG_PATH, event);
  console.log(JSON.stringify({
    status: 'event',
    signature: event.signature,
    slot: event.slot,
    outcome: event.notArb.outcome,
    mints: event.candidates.mints.map((mint) => mint.mint),
    candidatePrograms: event.candidates.programs.map((program) => program.label),
    invokedPrograms: event.execution.invokedPrograms.map((program) => program.label),
    alts: event.addressLookupTables.map((lookup) => lookup.address),
  }));
}

async function logError(value) {
  await appendJsonLine(ERROR_PATH, { observedAt: new Date().toISOString(), ...value });
  console.error(JSON.stringify(value));
}

function markSeen(state, signature) {
  state.seen.delete(signature);
  state.seen.add(signature);
}

function queueRetry(state, signature) {
  if (!state.retries.includes(signature)) state.retries.push(signature);
}

function clearRetry(state, signature) {
  state.retries = state.retries.filter((item) => item !== signature);
}

async function signaturePage(extra = {}) {
  return rpc('getSignaturesForAddress', [WATCHED_ADDRESS, { limit: PAGE_LIMIT, commitment: 'finalized', ...extra }]);
}

async function enumerateRecent(limit) {
  const all = [];
  let before;
  for (let pageIndex = 0; all.length < limit && pageIndex < MAX_PAGES; pageIndex += 1) {
    const page = await signaturePage(before ? { before } : {});
    if (page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE_LIMIT) break;
    before = page.at(-1).signature;
  }
  return all.slice(0, limit);
}

async function enumerateSinceCursor(cursor) {
  if (!cursor) return enumerateRecent(PAGE_LIMIT);
  const all = [];
  let before;
  let reachedCursor = false;
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const page = await signaturePage(before ? { before } : {});
    if (page.length === 0) { reachedCursor = true; break; }
    const cursorIndex = page.findIndex((item) => item.signature === cursor);
    if (cursorIndex >= 0) {
      all.push(...page.slice(0, cursorIndex));
      reachedCursor = true;
      break;
    }
    all.push(...page);
    if (page.length < PAGE_LIMIT) { reachedCursor = true; break; }
    before = page.at(-1).signature;
  }
  if (!reachedCursor) throw new Error(`Cursor ${cursor} was not reached within ${MAX_PAGES} pages; refusing to advance state.`);
  return all;
}

async function fetchTransactions(signatureInfos) {
  const results = new Map();
  for (let offset = 0; offset < signatureInfos.length; offset += 25) {
    const batch = signatureInfos.slice(offset, offset + 25);
    const calls = batch.map((info) => ({
      method: 'getTransaction',
      params: [info.signature, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
    }));
    try {
      const responses = await rpcBatch(calls);
      responses.forEach((response, index) => results.set(batch[index].signature, response.error ? { error: response.error } : { transaction: response.result }));
    } catch {
      const fallback = await mapConcurrent(batch, FETCH_CONCURRENCY, async (info) => {
        try {
          const transaction = await rpc('getTransaction', [info.signature, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
          return { signature: info.signature, transaction };
        } catch (error) {
          return { signature: info.signature, error };
        }
      });
      fallback.forEach((item) => results.set(item.signature, item));
    }
  }
  return results;
}

async function poll(state, firstPoll) {
  const discoveredNewestFirst = firstPoll && RECONCILE > 0
    ? await enumerateRecent(RECONCILE)
    : await enumerateSinceCursor(state.cursor);
  const freshOldestFirst = discoveredNewestFirst
    .slice()
    .reverse()
    .filter((item) => !state.seen.has(item.signature));
  const selectedFresh = freshOldestFirst.slice(0, MAX_TXS_PER_CYCLE);
  const retryInfos = state.retries
    .filter((signature) => !state.seen.has(signature))
    .map((signature) => ({ signature, blockTime: null, slot: null }));
  const ordered = [...new Map([...retryInfos, ...selectedFresh].map((item) => [item.signature, item])).values()];

  if (ordered.length === 0) {
    if (!state.cursor && discoveredNewestFirst[0]) state.cursor = discoveredNewestFirst[0].signature;
    await saveState(state);
    return { discovered: discoveredNewestFirst.length, processed: 0, retries: state.retries.length };
  }

  const fetched = await fetchTransactions(ordered);
  const enriched = await mapConcurrent(ordered, Math.min(FETCH_CONCURRENCY, 6), async (info) => {
    const result = fetched.get(info.signature);
    if (result?.error) return { info, error: String(result.error.message ?? result.error) };
    if (!result?.transaction) return { info, unavailable: true };
    try {
      return { info, event: await summarize(info, result.transaction) };
    } catch (error) {
      return { info, error: String(error) };
    }
  });

  let processed = 0;
  for (const item of enriched) {
    if (item.unavailable || item.error) {
      queueRetry(state, item.info.signature);
      await logError({ status: item.unavailable ? 'not_available_yet' : 'parse_error', signature: item.info.signature, error: item.error ?? null });
      continue;
    }
    await logEvent(item.event);
    markSeen(state, item.info.signature);
    clearRetry(state, item.info.signature);
    processed += 1;
  }

  // Advance only through the oldest contiguous fresh selection. Any unavailable
  // transaction remains in retries, so the durable cursor cannot hide it.
  if (selectedFresh.length > 0) state.cursor = selectedFresh.at(-1).signature;
  await saveState(state);
  return { discovered: discoveredNewestFirst.length, processed, retries: state.retries.length };
}

async function main() {
  const state = await loadState();
  console.log(JSON.stringify({
    status: 'watching',
    schemaVersion: 2,
    address: WATCHED_ADDRESS,
    rpc: RPC_URL,
    intervalMs: INTERVAL_MS,
    reconcile: RECONCILE,
    quotesEnabled: ENABLE_QUOTES,
    maxTxsPerCycle: MAX_TXS_PER_CYCLE,
    cursor: state.cursor,
    log: LOG_PATH,
  }));
  let firstPoll = true;
  for (;;) {
    try {
      const result = await poll(state, firstPoll);
      console.log(JSON.stringify({ status: 'poll_complete', ...result, cursor: state.cursor }));
      firstPoll = false;
      if (ONCE) return;
    } catch (error) {
      await logError({ status: 'poll_error', error: String(error), cursor: state.cursor });
      if (ONCE) process.exitCode = 1;
      if (ONCE) return;
    }
    await wait(INTERVAL_MS);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
