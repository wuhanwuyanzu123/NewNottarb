#!/usr/bin/env node
// Best-effort balance diagnostic for the Linux LAST live child.  It derives
// the public fee payer locally from the configured Solana keypair, then asks
// only the same [blockhash_updater] reader used by NotArb for getBalance.
// This helper never signs or sends a transaction and deliberately exits
// successfully even when the diagnostic itself is unavailable: the caller
// starts it in the background and must not delay the live child.

import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { blockhashReaderRpc } from './last-live-reader-rpc.mjs';

const DEFAULT_TIMEOUT_MS = 5_000;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

class PreflightError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function normalizedLines(toml) {
  return toml.split(/\r?\n/).map((sourceLine) => sourceLine.replace(/\s+#.*$/, '').trim());
}

function quotedAssignment(line, key) {
  const assignment = line.match(new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`));
  if (!assignment) return null;
  try {
    return JSON.parse(assignment[1]);
  } catch {
    return null;
  }
}

export function tomlStringInSection(toml, wantedSection, wantedKey) {
  let section = null;
  for (const line of normalizedLines(toml)) {
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1];
      continue;
    }
    if (section !== wantedSection) continue;
    const value = quotedAssignment(line, wantedKey);
    if (value !== null) return value;
  }
  return null;
}

export function configuredFeePayerInputs(toml, configPath) {
  const readerRpcUrl = blockhashReaderRpc(toml);
  if (!readerRpcUrl) throw new PreflightError('configured_blockhash_reader_missing');

  const keypairPath = tomlStringInSection(toml, 'user', 'keypair_path');
  if (!keypairPath) throw new PreflightError('configured_keypair_path_missing');

  return {
    readerRpcUrl,
    keypairPath: resolve(dirname(resolve(configPath)), keypairPath),
  };
}

export function base58Encode(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new PreflightError('keypair_public_key_invalid');

  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;

  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);

  let encoded = '';
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    value /= 58n;
  }
  return '1'.repeat(leadingZeroes) + encoded;
}

export function feePayerFromKeypairJson(keypairJson) {
  let keypair;
  try {
    keypair = JSON.parse(keypairJson);
  } catch {
    throw new PreflightError('keypair_json_invalid');
  }
  if (!Array.isArray(keypair) || keypair.length !== 64
    || keypair.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new PreflightError('keypair_secret_key_invalid');
  }

  // Solana keypair files store the 32-byte secret followed by the 32-byte
  // public key.  Use the embedded public half rather than logging or using
  // the secret half for anything beyond this local derivation.
  return base58Encode(Uint8Array.from(keypair.slice(32)));
}

export async function getFeePayerLamports({
  readerRpcUrl,
  feePayer,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== 'function') throw new PreflightError('fetch_unavailable');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new PreflightError('timeout_invalid');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(readerRpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'last-live-fee-payer-balance',
          method: 'getBalance',
          params: [feePayer, { commitment: 'processed' }],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        throw new PreflightError('balance_rpc_timeout');
      }
      throw new PreflightError('balance_rpc_request_failed');
    }
    if (!response?.ok) throw new PreflightError('balance_rpc_http_failed');

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new PreflightError('balance_rpc_response_invalid');
    }
    if (payload?.error) throw new PreflightError('balance_rpc_error');

    const lamports = payload?.result?.value;
    if (!Number.isInteger(lamports) || lamports < 0) {
      throw new PreflightError('balance_rpc_response_invalid');
    }
    return lamports;
  } finally {
    clearTimeout(timeout);
  }
}

function unavailableRecord(reason) {
  return {
    status: 'last_live_fee_payer_preflight_unavailable',
    severity: 'warning',
    reason,
    message: 'Fee-payer balance diagnostic did not complete; the live child was not delayed.',
  };
}

export async function runFeePayerPreflight({
  configPath,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof configPath !== 'string' || configPath.length === 0) {
    return unavailableRecord('invalid_arguments');
  }

  try {
    let toml;
    try {
      toml = await readFile(configPath, 'utf8');
    } catch {
      throw new PreflightError('live_config_read_failed');
    }
    const { readerRpcUrl, keypairPath } = configuredFeePayerInputs(toml, configPath);

    let keypairJson;
    try {
      keypairJson = await readFile(keypairPath, 'utf8');
    } catch {
      throw new PreflightError('keypair_read_failed');
    }
    const feePayer = feePayerFromKeypairJson(keypairJson);
    const lamports = await getFeePayerLamports({ readerRpcUrl, feePayer, fetchImpl, timeoutMs });

    if (lamports === 0) {
      return {
        status: 'last_live_fee_payer_unfunded',
        severity: 'warning',
        fee_payer: feePayer,
        reader_role: 'blockhash_updater',
        lamports: 0,
        message: 'Configured fee payer has zero lamports; network and priority fees cannot be paid.',
      };
    }
    return {
      status: 'last_live_fee_payer_balance_checked',
      fee_payer: feePayer,
      reader_role: 'blockhash_updater',
      balance_state: 'positive',
    };
  } catch (error) {
    return unavailableRecord(error instanceof PreflightError ? error.reason : 'unexpected_error');
  }
}

async function main() {
  const [configPath, ...extra] = process.argv.slice(2);
  const record = extra.length === 0
    ? await runFeePayerPreflight({ configPath })
    : unavailableRecord('invalid_arguments');
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function invokedAsMain() {
  if (!process.argv[1]) return false;

  const invokedPath = resolve(process.argv[1]);
  const modulePath = fileURLToPath(import.meta.url);
  if (invokedPath === modulePath) return true;

  // `/opt/notarb-last/current` is a symlink to an immutable release.  Node's
  // ESM URL can resolve that link while argv[1] keeps its lexical path, so use
  // canonical filesystem paths before deciding whether to run the CLI entry.
  // A failed canonicalization means this module was imported or its invocation
  // path is gone; in either case it must not execute a diagnostic implicitly.
  try {
    return (await realpath(invokedPath)) === (await realpath(modulePath));
  } catch {
    return false;
  }
}

if (await invokedAsMain()) {
  await main();
}
