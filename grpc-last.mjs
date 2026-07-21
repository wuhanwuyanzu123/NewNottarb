#!/usr/bin/env node
/**
 * Standalone, read-only Yellowstone gRPC observer for one Solana address.
 *
 * Network path: this process -> local SSH forward -> 82 gRPC :10000.
 * It intentionally makes no JSON-RPC, HTTP, WebSocket, quote, keypair,
 * simulation, signing, or transaction-send calls.  It only subscribes to
 * Yellowstone transaction updates and writes local evidence files.
 *
 * Default endpoint assumes this tunnel is running:
 *   ssh ... -L 127.0.0.1:18100:82.39.215.201:10000 ...
 *
 * Run:
 *   npm run listen:last:grpc
 *   node grpc-last.mjs --duration=20       # validation run, seconds
 */

import Client, { CommitmentLevel } from '@triton-one/yellowstone-grpc';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const WATCHED_ADDRESS = 'LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9';
const NOTARB_PROGRAM = 'NA247a7YE9S3p9CdKmMyETx8TTwbSdVbVYHHxpnHTUV';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLE_MINTS = new Set([
  WSOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1
]);
const DEX_PROGRAMS = new Map([
  ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'Pump.fun AMM'],
  ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', 'Meteora DLMM'],
  ['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', 'Meteora CPMM'],
  ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'Raydium AMM v4'],
  ['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', 'Raydium CPMM'],
  ['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', 'Raydium CLMM'],
  ['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', 'Orca Whirlpool'],
  ['FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq', 'Futarchy AMM'],
]);
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const args = parseArgs(process.argv.slice(2));
const ENDPOINT = args.get('endpoint') ?? process.env.YELLOWSTONE_GRPC_ENDPOINT ?? 'http://127.0.0.1:18100';
const X_TOKEN = process.env.YELLOWSTONE_X_TOKEN || undefined;
const DURATION_SECONDS = boundedNumber(args.get('duration'), 0, 0, 86_400);
const MAX_SEEN = boundedNumber(args.get('max-seen'), 20_000, 1_000, 200_000);
const ROOT = resolve(args.get('root') ?? process.cwd());
// The Rust route bridge can own the small lifecycle state in a Linux runtime.
// In that mode this observer remains an append-only gRPC evidence producer and
// skips the large Windows-replace state snapshot entirely.
const STATE_PATH = args.has('no-state') ? null : resolve(ROOT, args.get('state') ?? '.last-grpc-state.json');
const EVENTS_PATH = resolve(ROOT, 'last-grpc-events.jsonl');
const ALT_USES_PATH = resolve(ROOT, 'last-grpc-alt-uses.jsonl');
const SUMMARIES_PATH = resolve(ROOT, 'last-grpc-summaries.jsonl');
const ERRORS_PATH = resolve(ROOT, 'last-grpc-errors.jsonl');
const SUMMARY_INTERVAL_MS = 60_000;
const STATE_SAVE_INTERVAL_MS = 5_000;

let stream;
let state = {
  schemaVersion: 4,
  seen: new Set(),
  lastSlot: null,
  lastSignature: null,
  lastObservedAt: null,
  // Activity used to control the target-only dry-run lifecycle.  It advances
  // only for successful NotArb route checks with a candidate mint and DEX,
  // not for unrelated transactions that merely mention the watched address.
  lastRouteSlot: null,
  lastRouteSignature: null,
  lastRouteObservedAt: null,
  lastRouteFingerprint: null,
  activeRoute: null,
  knownAltTables: new Set(),
  window: newWindow(),
  lastSummaryAt: 0,
  lastStateSavedAt: 0,
};
let stopped = false;
let serial = Promise.resolve();

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

const pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));

function newWindow() {
  return {
    startedAt: new Date().toISOString(),
    total: 0,
    noFill: 0,
    fills: 0,
    failed: 0,
    other: 0,
  };
}

function base58Encode(bytes) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (source.length === 0) return '';
  const digits = [0];
  for (const byte of source) {
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
  while (leadingZeroes < source.length - 1 && source[leadingZeroes] === 0) leadingZeroes += 1;
  return `${'1'.repeat(leadingZeroes)}${digits.reverse().map((digit) => BASE58_ALPHABET[digit]).join('')}`;
}

function toUiAmount(raw, decimals) {
  const amount = typeof raw === 'bigint' ? raw : BigInt(raw ?? 0);
  const sign = amount < 0n ? '-' : '';
  const digits = (amount < 0n ? -amount : amount).toString().padStart(decimals + 1, '0');
  if (decimals === 0) return `${sign}${digits}`;
  const integer = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return `${sign}${integer}${fraction ? `.${fraction}` : ''}`;
}

function decimalRatio(numerator, denominator, precision = 12) {
  if (denominator === 0n) return null;
  const integer = numerator / denominator;
  let remainder = numerator % denominator;
  let decimals = '';
  for (let index = 0; index < precision && remainder !== 0n; index += 1) {
    remainder *= 10n;
    decimals += (remainder / denominator).toString();
    remainder %= denominator;
  }
  return `${integer}${decimals ? `.${decimals.replace(/0+$/, '')}` : ''}`;
}

function bigintAbsolute(value) {
  return value < 0n ? -value : value;
}

function expandedAccountKeys(message, meta) {
  const staticKeys = message?.accountKeys ?? [];
  const header = message?.header ?? {};
  const required = header.numRequiredSignatures ?? 0;
  const readonlySigned = header.numReadonlySignedAccounts ?? 0;
  const readonlyUnsigned = header.numReadonlyUnsignedAccounts ?? 0;
  const writableSignedUntil = required - readonlySigned;
  const writableUnsignedUntil = staticKeys.length - readonlyUnsigned;
  const resolvedStatic = staticKeys.map((key, index) => ({
    index,
    pubkey: base58Encode(key),
    source: 'transaction',
    signer: index < required,
    writable: index < required ? index < writableSignedUntil : index < writableUnsignedUntil,
  }));
  const writableLoaded = (meta?.loadedWritableAddresses ?? []).map((key, offset) => ({
    index: resolvedStatic.length + offset,
    pubkey: base58Encode(key),
    source: 'lookup_table',
    signer: false,
    writable: true,
  }));
  const readonlyLoaded = (meta?.loadedReadonlyAddresses ?? []).map((key, offset) => ({
    index: resolvedStatic.length + writableLoaded.length + offset,
    pubkey: base58Encode(key),
    source: 'lookup_table',
    signer: false,
    writable: false,
  }));
  return [...resolvedStatic, ...writableLoaded, ...readonlyLoaded];
}

function instructionProgramId(instruction, keys) {
  return keys[instruction?.programIdIndex]?.pubkey ?? null;
}

function allInvokedDexes(message, meta, keys) {
  const invoked = new Set();
  for (const instruction of message?.instructions ?? []) {
    const programId = instructionProgramId(instruction, keys);
    if (DEX_PROGRAMS.has(programId)) invoked.add(programId);
  }
  for (const group of meta?.innerInstructions ?? []) {
    for (const instruction of group.instructions ?? []) {
      const programId = instructionProgramId(instruction, keys);
      if (DEX_PROGRAMS.has(programId)) invoked.add(programId);
    }
  }
  return [...invoked].map((programId) => ({ programId, label: DEX_PROGRAMS.get(programId) }));
}

function candidateDexes(keys, invokedDexes) {
  const invoked = new Set(invokedDexes.map((item) => item.programId));
  const candidates = [];
  for (const key of keys) {
    const label = DEX_PROGRAMS.get(key.pubkey);
    if (label && !invoked.has(key.pubkey)) candidates.push({ programId: key.pubkey, label, role: 'candidate_meta' });
  }
  return candidates;
}

function tokenBalanceRows(meta) {
  const rows = new Map();
  const add = (balance, side) => {
    if (!balance?.mint) return;
    const ui = balance.uiTokenAmount ?? {};
    const key = `${balance.accountIndex}:${balance.mint}`;
    const current = rows.get(key) ?? {
      accountIndex: balance.accountIndex,
      mint: balance.mint,
      owner: balance.owner || null,
      programId: balance.programId || null,
      decimals: Number(ui.decimals ?? 0),
      pre: 0n,
      post: 0n,
    };
    current[side] = BigInt(ui.amount ?? 0);
    rows.set(key, current);
  };
  for (const balance of meta?.preTokenBalances ?? []) add(balance, 'pre');
  for (const balance of meta?.postTokenBalances ?? []) add(balance, 'post');
  return [...rows.values()];
}

function walletTokenDeltas(rows) {
  const byMint = new Map();
  for (const row of rows) {
    if (row.owner !== WATCHED_ADDRESS) continue;
    const current = byMint.get(row.mint) ?? { mint: row.mint, decimals: row.decimals, rawDelta: 0n };
    current.rawDelta += row.post - row.pre;
    byMint.set(row.mint, current);
  }
  return [...byMint.values()].filter((item) => item.rawDelta !== 0n);
}

function presentTokenDeltas(deltas) {
  return deltas.map((item) => ({
    mint: item.mint,
    decimals: item.decimals,
    rawDelta: item.rawDelta.toString(),
    uiDelta: toUiAmount(item.rawDelta, item.decimals),
  }));
}

function transactionMints(rows) {
  const result = new Map();
  for (const row of rows) {
    const current = result.get(row.mint) ?? { mint: row.mint, decimals: row.decimals, tokenAccountCount: 0, walletOwned: false };
    current.tokenAccountCount += 1;
    current.walletOwned ||= row.owner === WATCHED_ADDRESS;
    result.set(row.mint, current);
  }
  return [...result.values()];
}

function candidateMints(rows) {
  const result = new Map();
  for (const row of rows) {
    if (STABLE_MINTS.has(row.mint)) continue;
    const current = result.get(row.mint) ?? { mint: row.mint, decimals: row.decimals, evidence: new Set() };
    current.evidence.add(row.owner === WATCHED_ADDRESS ? 'wallet_token_account' : 'transaction_token_account');
    result.set(row.mint, current);
  }
  return [...result.values()].map((item) => ({ ...item, evidence: [...item.evidence] }));
}

function realizedPrice(deltas) {
  const targets = deltas.filter((item) => !STABLE_MINTS.has(item.mint));
  const quotes = deltas.filter((item) => STABLE_MINTS.has(item.mint));
  if (targets.length !== 1 || quotes.length !== 1) return null;
  const target = targets[0];
  const quote = quotes[0];
  if ((target.rawDelta > 0n) === (quote.rawDelta > 0n)) return null;
  const numerator = bigintAbsolute(quote.rawDelta) * (10n ** BigInt(target.decimals));
  const denominator = bigintAbsolute(target.rawDelta) * (10n ** BigInt(quote.decimals));
  const price = decimalRatio(numerator, denominator);
  if (price === null) return null;
  return {
    method: 'wallet_balance_delta',
    side: target.rawDelta > 0n ? 'buy_target' : 'sell_target',
    baseMint: target.mint,
    quoteMint: quote.mint,
    price,
    denomination: `${quote.mint} per ${target.mint}`,
  };
}

function lookupTables(message, meta) {
  const writable = (meta?.loadedWritableAddresses ?? []).map(base58Encode);
  const readonly = (meta?.loadedReadonlyAddresses ?? []).map(base58Encode);
  let writableOffset = 0;
  let readonlyOffset = 0;
  return (message?.addressTableLookups ?? []).map((lookup) => {
    const writableIndexes = Array.from(lookup.writableIndexes ?? []);
    const readonlyIndexes = Array.from(lookup.readonlyIndexes ?? []);
    const resolvedWritable = writableIndexes.map((index, offset) => ({ index, address: writable[writableOffset + offset] ?? null }));
    const resolvedReadonly = readonlyIndexes.map((index, offset) => ({ index, address: readonly[readonlyOffset + offset] ?? null }));
    writableOffset += writableIndexes.length;
    readonlyOffset += readonlyIndexes.length;
    return {
      address: base58Encode(lookup.accountKey),
      writableIndexes,
      readonlyIndexes,
      resolvedWritable,
      resolvedReadonly,
    };
  });
}

function summarizeUpdate(update) {
  const updateTransaction = update.transaction;
  const info = updateTransaction?.transaction;
  const transaction = info?.transaction;
  const message = transaction?.message;
  const meta = info?.meta;
  if (!info || !message || !meta) return null;
  const signature = base58Encode(info.signature);
  const keys = expandedAccountKeys(message, meta);
  const rows = tokenBalanceRows(meta);
  const deltas = walletTokenDeltas(rows);
  const topLevelNotArbIndexes = (message.instructions ?? [])
    .map((instruction, index) => ({ index, programId: instructionProgramId(instruction, keys) }))
    .filter((item) => item.programId === NOTARB_PROGRAM)
    .map((item) => item.index);
  const noProfitLogs = (meta.logMessages ?? []).filter((line) => /No arbitrage profit found!/i.test(line));
  const invokedPrograms = allInvokedDexes(message, meta, keys);
  const intendedMints = candidateMints(rows);
  const intendedDexPrograms = candidateDexes(keys, invokedPrograms);
  const usedLookupTables = lookupTables(message, meta);
  const price = invokedPrograms.length > 0 && !meta.err ? realizedPrice(deltas) : null;
  const executionKind = meta.err
    ? 'failed'
    : noProfitLogs.length > 0
      ? 'no_fill'
      : invokedPrograms.length === 0
        ? 'unknown'
        : price
          ? 'fill'
          : 'executed_unpriced';
  const watchedKey = keys.find((key) => key.pubkey === WATCHED_ADDRESS);
  const watchedIndex = watchedKey?.index ?? -1;
  const lamportPre = watchedIndex >= 0 ? BigInt(meta.preBalances?.[watchedIndex] ?? 0) : null;
  const lamportPost = watchedIndex >= 0 ? BigInt(meta.postBalances?.[watchedIndex] ?? 0) : null;
  const rawLamportDelta = lamportPre === null || lamportPost === null ? null : lamportPost - lamportPre;
  return {
    schemaVersion: 1,
    source: {
      transport: 'yellowstone_grpc',
      endpoint: ENDPOINT,
      commitment: 'confirmed',
      parserVersion: 'grpc-last/1.0.0',
    },
    observedAt: new Date().toISOString(),
    signature,
    slot: String(updateTransaction.slot),
    transactionVersion: message.versioned ? 0 : 'legacy',
    success: !meta.err,
    watch: {
      address: WATCHED_ADDRESS,
      feePayer: keys[0]?.pubkey ?? null,
      isSigner: Boolean(watchedKey?.signer),
    },
    notArb: {
      matched: topLevelNotArbIndexes.length > 0,
      programId: topLevelNotArbIndexes.length > 0 ? NOTARB_PROGRAM : null,
      topLevelInstructionIndexes: topLevelNotArbIndexes,
      outcome: noProfitLogs.length > 0 ? 'no_arbitrage_profit' : executionKind,
      matchedLogs: noProfitLogs,
    },
    accountKeys: keys,
    balances: {
      lamports: rawLamportDelta === null ? null : {
        pre: lamportPre.toString(),
        post: lamportPost.toString(),
        rawDelta: rawLamportDelta.toString(),
        uiDelta: toUiAmount(rawLamportDelta, 9),
        feeLamports: String(meta.fee ?? 0),
      },
      walletTokenDeltas: presentTokenDeltas(deltas),
      transactionMints: transactionMints(rows),
    },
    // A no-profit log still proves that NotArb evaluated this candidate route.
    // These fields deliberately describe intent, not a settled swap.
    arbitrageIntent: {
      kind: noProfitLogs.length > 0 ? 'notarb_no_profit_route_check' : topLevelNotArbIndexes.length > 0 ? 'notarb_route_check' : 'unknown',
      mints: intendedMints,
      dexPrograms: intendedDexPrograms,
      altTables: usedLookupTables.map((table) => table.address),
      price: noProfitLogs.length > 0
        ? { kind: 'not_executed', value: null, reason: 'No arbitrage profit found; no on-chain swap price exists for this check.' }
        : price
          ? { kind: 'realized', value: price.price, denomination: price.denomination }
          : { kind: 'not_derivable', value: null, reason: 'The transaction did not expose one unambiguous executed wallet-delta price.' },
    },
    candidates: {
      mints: intendedMints,
      programs: intendedDexPrograms,
    },
    execution: {
      kind: executionKind,
      invokedPrograms,
      realizedPrice: price,
      priceStatus: price ? 'derived_from_executed_wallet_deltas' : executionKind === 'no_fill' ? 'no_realized_price_no_fill' : 'not_derivable_from_transaction',
    },
    addressLookupTables: usedLookupTables,
    computeUnitsConsumed: meta.computeUnitsConsumed == null ? null : String(meta.computeUnitsConsumed),
  };
}

async function appendJsonLine(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}

async function loadState() {
  if (!STATE_PATH) return;
  try {
    const saved = JSON.parse(await readFile(STATE_PATH, 'utf8'));
    state = {
      schemaVersion: 4,
      seen: new Set(saved.seen ?? []),
      lastSlot: saved.lastSlot ?? null,
      lastSignature: saved.lastSignature ?? null,
      lastObservedAt: saved.lastObservedAt ?? null,
      lastRouteSlot: saved.lastRouteSlot ?? null,
      lastRouteSignature: saved.lastRouteSignature ?? null,
      lastRouteObservedAt: saved.lastRouteObservedAt ?? null,
      lastRouteFingerprint: saved.lastRouteFingerprint ?? null,
      activeRoute: saved.activeRoute ?? null,
      knownAltTables: new Set(saved.knownAltTables ?? []),
      window: saved.window ?? newWindow(),
      lastSummaryAt: saved.lastSummaryAt ?? 0,
      lastStateSavedAt: 0,
    };
  } catch {
    // First run is expected.
  }
}

async function saveState() {
  if (!STATE_PATH) return;
  const payload = {
    schemaVersion: 4,
    seen: [...state.seen],
    lastSlot: state.lastSlot,
    lastSignature: state.lastSignature,
    lastObservedAt: state.lastObservedAt,
    lastRouteSlot: state.lastRouteSlot,
    lastRouteSignature: state.lastRouteSignature,
    lastRouteObservedAt: state.lastRouteObservedAt,
    lastRouteFingerprint: state.lastRouteFingerprint,
    activeRoute: state.activeRoute,
    knownAltTables: [...state.knownAltTables],
    window: state.window,
    lastSummaryAt: state.lastSummaryAt,
    savedAt: new Date().toISOString(),
  };
  const temporary = `${STATE_PATH}.tmp`;
  await writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8');
  await rename(temporary, STATE_PATH);
}

async function maybeSaveState(force = false) {
  const now = Date.now();
  if (!force && now - state.lastStateSavedAt < STATE_SAVE_INTERVAL_MS) return false;
  await saveState();
  state.lastStateSavedAt = now;
  return true;
}

function markSeen(signature) {
  state.seen.delete(signature);
  state.seen.add(signature);
  while (state.seen.size > MAX_SEEN) state.seen.delete(state.seen.values().next().value);
}

function routeFingerprint(event) {
  const sortIndexes = (indexes) => [...(indexes ?? [])].sort((left, right) => left - right);
  const altSelections = (event.addressLookupTables ?? [])
    .map((item) => ({
      address: item.address,
      writableIndexes: sortIndexes(item.writableIndexes),
      readonlyIndexes: sortIndexes(item.readonlyIndexes),
    }))
    .sort((left, right) => left.address.localeCompare(right.address));
  // Pool accounts can be static rather than ALT-loaded. Preserve their
  // identity in the route fingerprint so a pool rotation produces a new
  // target snapshot even when mint/DEX/ALT selections stay the same.
  const writableRouteAccounts = (event.accountKeys ?? [])
    .filter((key) => key.writable && !key.signer)
    .map((key) => key.pubkey)
    .sort();
  return JSON.stringify({
    mints: event.arbitrageIntent.mints.map((item) => item.mint).sort(),
    intendedDexes: event.arbitrageIntent.dexPrograms.map((item) => item.programId).sort(),
    invokedDexes: event.execution.invokedPrograms.map((item) => item.programId).sort(),
    executionKind: event.execution.kind,
    // Normalizing table/index ordering avoids treating equivalent account
    // metas as a changed route. The selected indexes and writable static keys
    // still make a genuine pool rotation a new snapshot.
    altSelections,
    writableRouteAccounts,
  });
}

function isStartableRouteEvidence(event) {
  return Boolean(
    event.success
    && event.notArb?.matched
    && event.arbitrageIntent?.mints?.length
    && event.arbitrageIntent?.dexPrograms?.length,
  );
}

function recordWindow(event) {
  state.window ??= newWindow();
  state.window.total += 1;
  if (event.execution.kind === 'no_fill') state.window.noFill += 1;
  else if (event.execution.kind === 'fill') state.window.fills += 1;
  else if (event.execution.kind === 'failed') state.window.failed += 1;
  else state.window.other += 1;
}

async function maybeEmitSummary(event) {
  const now = Date.now();
  if (now - state.lastSummaryAt < SUMMARY_INTERVAL_MS) return false;
  const summary = {
    schemaVersion: 1,
    observedAt: event.observedAt,
    latestSignature: event.signature,
    latestSlot: event.slot,
    window: state.window,
    route: {
      intentKind: event.arbitrageIntent.kind,
      mints: event.arbitrageIntent.mints.map((item) => item.mint),
      intendedDexes: event.arbitrageIntent.dexPrograms.map((item) => item.label),
      invokedDexes: event.execution.invokedPrograms.map((item) => item.label),
      altTables: event.addressLookupTables.map((item) => item.address),
    },
  };
  await appendJsonLine(SUMMARIES_PATH, summary);
  console.log(JSON.stringify({ status: 'summary', ...summary }));
  state.window = newWindow();
  state.lastSummaryAt = now;
  return true;
}

async function persistEvent(event) {
  const fingerprint = routeFingerprint(event);
  const routeChanged = fingerprint !== state.activeRoute;
  const newAltTables = event.addressLookupTables.filter((table) => !state.knownAltTables.has(table.address));
  const notable = routeChanged || newAltTables.length > 0 || event.execution.kind !== 'no_fill';
  if (notable) {
    await appendJsonLine(EVENTS_PATH, {
      ...event,
      observation: {
        kind: 'route_snapshot',
        routeChanged,
        newAltTables: newAltTables.map((table) => table.address),
      },
    });
    for (const table of newAltTables) {
      await appendJsonLine(ALT_USES_PATH, {
        observedAt: event.observedAt,
        signature: event.signature,
        slot: event.slot,
        ...table,
      });
    }
  }
  for (const table of event.addressLookupTables) state.knownAltTables.add(table.address);
  state.activeRoute = fingerprint;
  markSeen(event.signature);
  state.lastSlot = event.slot;
  state.lastSignature = event.signature;
  state.lastObservedAt = event.observedAt;
  if (isStartableRouteEvidence(event)) {
    state.lastRouteSlot = event.slot;
    state.lastRouteSignature = event.signature;
    state.lastRouteObservedAt = event.observedAt;
    state.lastRouteFingerprint = fingerprint;
  }
  recordWindow(event);
  const summaryEmitted = await maybeEmitSummary(event);
  await maybeSaveState(notable || summaryEmitted);
  return { notable, summaryEmitted };
}

function compactEvent(event) {
  return {
    status: 'event',
    signature: event.signature,
    slot: event.slot,
    outcome: event.notArb.outcome,
    intentKind: event.arbitrageIntent.kind,
    mints: event.arbitrageIntent.mints.map((item) => item.mint),
    intendedDexes: event.arbitrageIntent.dexPrograms.map((item) => item.label),
    invokedDexes: event.execution.invokedPrograms.map((item) => item.label),
    price: event.execution.realizedPrice?.price ?? null,
    priceStatus: event.execution.priceStatus,
    alts: event.addressLookupTables.map((item) => item.address),
  };
}

async function recordError(status, error) {
  const value = { observedAt: new Date().toISOString(), status, error: String(error?.stack ?? error) };
  await appendJsonLine(ERRORS_PATH, value).catch(() => undefined);
  console.error(JSON.stringify(value));
}

function subscriptionRequest() {
  return {
    accounts: {},
    slots: {},
    transactions: {
      last: {
        vote: false,
        // Omit `failed` deliberately: the observer keeps failed transactions
        // as evidence too, rather than filtering them out at the server.
        accountInclude: [WATCHED_ADDRESS],
        accountExclude: [],
        accountRequired: [],
      },
    },
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    commitment: CommitmentLevel.CONFIRMED,
    accountsDataSlice: [],
  };
}

function enqueueUpdate(update) {
  serial = serial
    .then(async () => {
      if (update.ping) {
        stream?.write({ ...subscriptionRequest(), ping: { id: update.ping.id } });
        return;
      }
      const event = summarizeUpdate(update);
      if (!event || state.seen.has(event.signature)) return;
      const result = await persistEvent(event);
      if (result.notable) console.log(JSON.stringify(compactEvent(event)));
    })
    .catch((error) => recordError('update_processing_error', error));
}

async function stop(exitCode, reason) {
  if (stopped) return;
  stopped = true;
  console.log(JSON.stringify({ status: 'stopping', reason }));
  try { await serial; } catch { /* serial errors are already recorded */ }
  try { await saveState(); } catch (error) { await recordError('state_save_error', error); }
  try { stream?.end(); stream?.destroy(); } catch { /* stream may already be closed */ }
  process.exit(exitCode);
}

async function openSubscription() {
  console.log(JSON.stringify({
    status: 'connecting',
    transport: 'yellowstone_grpc',
    endpoint: ENDPOINT,
    address: WATCHED_ADDRESS,
    commitment: 'confirmed',
    xTokenProvided: Boolean(X_TOKEN),
  }));
  const client = new Client(ENDPOINT, X_TOKEN, {
    'grpc.max_receive_message_length': 64 * 1024 * 1024,
    'grpc.max_send_message_length': 64 * 1024 * 1024,
  });
  const nextStream = await client.subscribe();
  stream = nextStream;
  let settled = false;
  const terminal = new Promise((resolveTerminal) => {
    const settle = (reason) => {
      if (settled) return;
      settled = true;
      resolveTerminal(reason);
    };
    nextStream.on('data', enqueueUpdate);
    nextStream.on('error', (error) => { void recordError('grpc_stream_error', error); settle('error'); });
    nextStream.on('end', () => { console.error(JSON.stringify({ status: 'grpc_stream_end' })); settle('end'); });
    nextStream.on('close', () => { console.error(JSON.stringify({ status: 'grpc_stream_close' })); settle('close'); });
  });
  try {
    await new Promise((resolveRequest, rejectRequest) => nextStream.write(subscriptionRequest(), (error) => error ? rejectRequest(error) : resolveRequest()));
  } catch (error) {
    nextStream.destroy();
    throw error;
  }
  console.log(JSON.stringify({ status: 'subscribed', filter: 'transactions.accountInclude', address: WATCHED_ADDRESS }));
  return terminal;
}

async function main() {
  await loadState();
  if (DURATION_SECONDS > 0) {
    setTimeout(() => { void stop(0, 'duration_elapsed'); }, DURATION_SECONDS * 1_000).unref();
  }
  let reconnectDelay = 1_000;
  while (!stopped) {
    try {
      const reason = await openSubscription();
      if (stopped) break;
      console.error(JSON.stringify({ status: 'grpc_reconnect_scheduled', reason, delayMs: reconnectDelay }));
    } catch (error) {
      await recordError('grpc_connect_error', error);
      if (stopped) break;
      console.error(JSON.stringify({ status: 'grpc_reconnect_scheduled', reason: 'connect_error', delayMs: reconnectDelay }));
    }
    await pause(reconnectDelay);
    reconnectDelay = Math.min(15_000, Math.round(reconnectDelay * 1.8));
  }
}

process.on('SIGINT', () => { void stop(0, 'SIGINT'); });
process.on('SIGTERM', () => { void stop(0, 'SIGTERM'); });

main().catch(async (error) => {
  await recordError('startup_error', error);
  await stop(1, 'startup_error');
});
