#!/usr/bin/env node
/**
 * Real-time, read-only log stream for LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9.
 *
 * The address submits far more transactions than a public RPC can fully decode
 * per minute. This stream captures every confirmed logsSubscribe notification
 * first, fetches every non-no-profit anomaly after finalized confirmation, and samples one
 * no-profit candidate route periodically for mint/DEX/ALT/quote changes.
 * It never loads a keypair or sends a transaction.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const WATCHED_ADDRESS = 'LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9';
const NOTARB_PROGRAM = 'NA247a7YE9S3p9CdKmMyETx8TTwbSdVbVYHHxpnHTUV';
const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://solana-rpc.publicnode.com';
const WS_URL = process.env.SOLANA_WS_URL ?? 'wss://solana-rpc.publicnode.com';
const STREAM_ALL_FOR_DIAGNOSTIC = process.env.SOLANA_WS_ALL === '1';
const ROOT = resolve(process.cwd());
const STATE_PATH = resolve(ROOT, '.last-stream-state.json');
const SUMMARY_PATH = resolve(ROOT, 'last-stream-summary.jsonl');
const SAMPLE_PATH = resolve(ROOT, 'last-stream-samples.jsonl');
const CHANGE_PATH = resolve(ROOT, 'last-stream-changes.jsonl');
const ANOMALY_PATH = resolve(ROOT, 'last-stream-anomalies.jsonl');
const SAMPLE_MS = 30_000;
const SUMMARY_MS = 60_000;

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const STABLE_MINTS = new Set([
  WSOL_MINT,
  USDC_MINT,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
]);
const DEX_PROGRAMS = new Map([
  ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', { label: 'Pump.fun AMM', dexIds: ['pumpswap', 'pumpfun'] }],
  ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', { label: 'Meteora DLMM', dexIds: ['meteora'] }],
  ['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', { label: 'Meteora CPMM', dexIds: ['meteora'] }],
  ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', { label: 'Raydium AMM v4', dexIds: ['raydium'] }],
  ['FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq', { label: 'Futarchy AMM', dexIds: [] }],
]);

let rpcId = 0;
let socket;
let reconnectDelay = 1_000;
let sampleInFlight = false;
let anomalyInFlight = 0;
let diagnosticOtherSeen = false;
const MAX_CONCURRENT_ANOMALIES = 4;
const quoteCache = new Map();
let state = {
  schemaVersion: 1,
  lastSignature: null,
  lastSlot: null,
  lastSeenAt: null,
  lastSampleAt: 0,
  profile: null,
  window: { total: 0, noProfit: 0, anomalies: 0 },
};

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

async function appendJsonLine(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}

async function saveState() {
  const temporary = `${STATE_PATH}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...state, savedAt: new Date().toISOString() }, null, 2));
  await rename(temporary, STATE_PATH);
}

async function loadState() {
  try { state = { ...state, ...JSON.parse(await readFile(STATE_PATH, 'utf8')) }; } catch { /* first run */ }
}

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(`${method}: ${payload.error?.message ?? `HTTP ${response.status}`}`);
  return payload.result;
}

function keysOf(message) {
  return (message.accountKeys ?? []).map((entry) => typeof entry === 'string' ? entry : entry.pubkey);
}

function candidateMints(meta) {
  const mints = new Map();
  for (const balance of [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])]) {
    if (STABLE_MINTS.has(balance.mint)) continue;
    mints.set(balance.mint, balance.uiTokenAmount.decimals);
  }
  return [...mints].map(([mint, decimals]) => ({ mint, decimals }));
}

async function quotePairs(mint) {
  const cached = quoteCache.get(mint);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
  const value = fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(10_000) })
    .then(async (response) => response.ok ? response.json() : { pairs: [] })
    .then((payload) => (payload.pairs ?? []).filter((pair) => pair.chainId === 'solana'))
    .catch(() => []);
  quoteCache.set(mint, { at: Date.now(), value });
  return value;
}

async function inspectSignature(record, reason) {
  const tx = await rpc('getTransaction', [record.signature, {
    commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0,
  }]);
  if (!tx) throw new Error('transaction not available at finalized commitment');
  const keys = keysOf(tx.transaction.message);
  const candidatePrograms = keys
    .filter((key) => DEX_PROGRAMS.has(key))
    .map((programId) => ({ programId, label: DEX_PROGRAMS.get(programId).label }));
  const mints = candidateMints(tx.meta);
  const allowedDexes = new Set(candidatePrograms.flatMap((item) => DEX_PROGRAMS.get(item.programId).dexIds));
  const pools = [];
  for (const mint of mints.slice(0, 3)) {
    for (const pair of await quotePairs(mint.mint)) {
      if (!keys.includes(pair.pairAddress) || !allowedDexes.has(pair.dexId)) continue;
      pools.push({
        address: pair.pairAddress,
        protocol: pair.dexId,
        baseMint: pair.baseToken?.address ?? null,
        quoteMint: pair.quoteToken?.address ?? null,
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
  const profile = JSON.stringify({
    mints: mints.map((item) => item.mint).sort(),
    programs: candidatePrograms.map((item) => item.programId).sort(),
    alts: (tx.transaction.message.addressTableLookups ?? []).map((item) => item.accountKey).sort(),
    pools: pools.map((item) => item.address).sort(),
  });
  const event = {
    observedAt: new Date().toISOString(),
    reason,
    signature: record.signature,
    slot: tx.slot,
    blockTime: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
    noProfit: (tx.meta.logMessages ?? []).some((line) => /No arbitrage profit found!/i.test(line)),
    success: tx.meta.err === null,
    candidateMints: mints,
    candidatePrograms,
    candidatePools: [...new Map(pools.map((item) => [item.address, item])).values()],
    invokedDexPrograms: [],
    addressLookupTables: (tx.transaction.message.addressTableLookups ?? []).map((item) => ({
      address: item.accountKey,
      writableIndexes: item.writableIndexes ?? [],
      readonlyIndexes: item.readonlyIndexes ?? [],
    })),
    profileChanged: state.profile !== profile,
  };
  if (event.profileChanged) {
    state.profile = profile;
    await appendJsonLine(CHANGE_PATH, event);
    console.log(JSON.stringify({ status: 'candidate_change', signature: event.signature, mints: mints.map((item) => item.mint), dexes: candidatePrograms.map((item) => item.label) }));
  }
  await appendJsonLine(reason === 'anomaly' ? ANOMALY_PATH : SAMPLE_PATH, event);
  return event;
}

async function onLogs(value, slot) {
  const logs = value.logs ?? [];
  const isNotArb = logs.some((line) => line.includes(NOTARB_PROGRAM));
  if (!isNotArb) {
    if (STREAM_ALL_FOR_DIAGNOSTIC && !diagnosticOtherSeen) {
      diagnosticOtherSeen = true;
      console.log(JSON.stringify({ status: 'stream_other_log_received', signature: value.signature, slot }));
    }
    return;
  }
  const noProfit = logs.some((line) => /No arbitrage profit found!/i.test(line));
  const record = {
    observedAt: new Date().toISOString(),
    signature: value.signature,
    slot,
    err: value.err ?? null,
    noProfit,
  };
  state.lastSignature = record.signature;
  state.lastSlot = slot;
  state.lastSeenAt = record.observedAt;
  state.window.total += 1;
  if (noProfit) state.window.noProfit += 1;

  if (!noProfit || record.err) {
    state.window.anomalies += 1;
    if (anomalyInFlight < MAX_CONCURRENT_ANOMALIES) {
      anomalyInFlight += 1;
      inspectSignature(record, 'anomaly').catch(async (error) => appendJsonLine(ANOMALY_PATH, { ...record, error: String(error) }))
        .finally(() => { anomalyInFlight -= 1; });
    } else {
      await appendJsonLine(ANOMALY_PATH, { ...record, status: 'anomaly_queue_full' });
    }
    return;
  }
  if (!sampleInFlight && Date.now() - state.lastSampleAt >= SAMPLE_MS) {
    sampleInFlight = true;
    state.lastSampleAt = Date.now();
    inspectSignature(record, 'sample').catch(async (error) => appendJsonLine(SAMPLE_PATH, { ...record, error: String(error) }))
      .finally(() => { sampleInFlight = false; });
  }
}

function connect() {
  socket = new WebSocket(WS_URL);
  socket.addEventListener('open', () => {
    reconnectDelay = 1_000;
    socket.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
      // PublicNode streams confirmed logs promptly; subsequent enrichment uses
      // finalized getTransaction calls before treating a result as evidence.
      params: [STREAM_ALL_FOR_DIAGNOSTIC ? 'all' : { mentions: [WATCHED_ADDRESS] }, { commitment: 'confirmed' }],
    }));
    console.log(JSON.stringify({ status: 'stream_connected', ws: WS_URL }));
  });
  socket.addEventListener('message', async (message) => {
    let payload;
    try {
      const raw = typeof message.data === 'string'
        ? message.data
        : message.data instanceof ArrayBuffer
          ? Buffer.from(message.data).toString('utf8')
          : ArrayBuffer.isView(message.data)
            ? Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength).toString('utf8')
            : await message.data.text();
      payload = JSON.parse(raw);
    } catch (error) {
      console.error(JSON.stringify({ status: 'stream_message_parse_error', error: String(error), dataType: typeof message.data, constructor: message.data?.constructor?.name ?? null }));
      return;
    }
    if (payload.error) {
      console.error(JSON.stringify({ status: 'stream_subscription_error', error: payload.error }));
      return;
    }
    if (payload.id === 1 && payload.result) {
      console.log(JSON.stringify({ status: 'stream_subscribed', subscriptionId: payload.result }));
      return;
    }
    if (payload.method !== 'logsNotification') return;
    const result = payload.params?.result;
    if (result?.value) onLogs(result.value, result.context?.slot).catch((error) => console.error(String(error)));
  });
  socket.addEventListener('error', () => { /* close handler reconnects */ });
  socket.addEventListener('close', () => {
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    console.error(JSON.stringify({ status: 'stream_closed', reconnectInMs: delay }));
    setTimeout(connect, delay);
  });
}

async function emitSummary() {
  const summary = {
    observedAt: new Date().toISOString(),
    source: 'logsSubscribe/confirmed',
    address: WATCHED_ADDRESS,
    lastSignature: state.lastSignature,
    lastSlot: state.lastSlot,
    lastSeenAt: state.lastSeenAt,
    ...state.window,
  };
  await appendJsonLine(SUMMARY_PATH, summary);
  await saveState();
  state.window = { total: 0, noProfit: 0, anomalies: 0 };
}

await loadState();
console.log(JSON.stringify({ status: 'stream_starting', address: WATCHED_ADDRESS, rpc: RPC_URL, ws: WS_URL, diagnosticAll: STREAM_ALL_FOR_DIAGNOSTIC }));
connect();
setInterval(() => { emitSummary().catch((error) => console.error(String(error))); }, SUMMARY_MS);
