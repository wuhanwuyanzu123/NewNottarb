#!/usr/bin/env node
// Offline parser contract for the configured core-reader extractor. It
// exercises the same section boundaries used by the Linux live child runner.

import { blockhashReaderRpc } from './last-live-reader-rpc.mjs';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const reader = 'http://82.39.215.201:8899';
const readerLine = 'rpc_url = "' + reader + '" # shared reader';
const base = [
  '',
  '[price_updater]',
  'rpc_url = "https://other.invalid"',
  '',
  '[blockhash_updater]',
  readerLine,
  '',
  '[market_loader]',
  'rpc_url = "https://other.invalid"',
  '',
].join('\n');

if (blockhashReaderRpc(base) !== reader) {
  throw new Error('blockhash_reader_not_extracted');
}
if (blockhashReaderRpc(base.replace(readerLine, 'rpc_url = "not-a-url"')) !== null) {
  throw new Error('invalid_reader_accepted');
}
if (blockhashReaderRpc('[market_loader]\nrpc_url = "https://reader.invalid"\n') !== null) {
  throw new Error('reader_outside_blockhash_section_accepted');
}

const execFileAsync = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'last-live-reader-rpc-'));
const helper = join(dirname(fileURLToPath(import.meta.url)), 'last-live-reader-rpc.mjs');
try {
  const config = join(directory, 'live.toml');
  await writeFile(config, base, 'utf8');
  const direct = await execFileAsync(process.execPath, [helper, config]);
  if (direct.stdout !== reader) throw new Error('reader_cli_output_mismatch');
  await writeFile(config, '[blockhash_updater]\nrpc_url = "not-a-url"\n', 'utf8');
  try {
    await execFileAsync(process.execPath, [helper, config]);
    throw new Error('invalid_reader_cli_accepted');
  } catch (error) {
    if (error.message === 'invalid_reader_cli_accepted') throw error;
    if (error.code !== 2) throw new Error('invalid_reader_cli_exit:' + error.code);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'last_live_reader_rpc_test_passed' }));
