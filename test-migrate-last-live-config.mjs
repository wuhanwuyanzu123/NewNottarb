#!/usr/bin/env node
// Exercises the deployment-only migration without contacting an RPC or
// starting NotArb.  It covers the exact hybrid configuration that previously
// selected [[sender]] metadata for a v1.1.2 [[spam_rpc]].

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(process.cwd());
const migration = join(root, 'migrate-last-live-config.mjs');
const assertion = join(root, 'assert-last-live.mjs');
const templatePath = join(root, 'notarb-last-grpc-live.example.toml');
const heliusUrl = 'https://mainnet.helius-rpc.com/?api-key=fixture-indexed-key';
const readerUrl = 'http://82.39.215.201:8899';
const directory = await mkdtemp(join(tmpdir(), 'last-live-migration-'));
const configPath = join(directory, 'notarb-last-grpc-live.toml');
const { LAST_READ_RPC_URL: _ignoredReadRpcUrl, ...environmentWithoutReadRpc } = process.env;

async function run(command, args) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: directory,
      // The assertion derives the shared reader from the private config when
      // this variable is intentionally absent.
      env: environmentWithoutReadRpc,
    });
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    return {
      code: Number.isInteger(error.code) ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

try {
  const template = await readFile(templatePath, 'utf8');
  const configured = template
    .replace('REPLACE_WITH_DEDICATED_FUNDED_KEYPAIR.json', 'fixture-keypair.json')
    .replaceAll('https://mainnet.helius-rpc.com/?api-key=REPLACE_WITH_HELIUS_API_KEY', heliusUrl);
  // Model the deployed predecessor: direct reader URLs plus the old sender
  // schema. Migration must keep the sender/token index direct but move the
  // four core read roles to the recovered 82 reader.
  const hybrid = configured
    .replaceAll(readerUrl, heliusUrl)
    .replace('threads = 0', 'threads = 1')
    .replace('delay_ms = 1000', 'delay_ms = 250')
    .replace(
      'spam_senders = [{ rpc = "spam1", max_retries = 0 }]',
      'senders = [{ id = "spam1", max_retries = 0, require_profit = true }]',
    );
  await writeFile(join(directory, 'fixture-keypair.json'), '[]\n', 'utf8');
  await writeFile(configPath, hybrid, 'utf8');

  const migrationArgs = [migration, configPath];
  const migrated = await run(process.execPath, migrationArgs);
  if (migrated.code !== 0 || !migrated.stdout.includes('last_live_config_migrated_v1_1_2')) {
    throw new Error(`hybrid_profile_not_migrated:${migrated.stderr || migrated.stdout}`);
  }
  if (!migrated.stdout.includes('blockhash_updater_delay_ms')) {
    throw new Error(`blockhash_delay_not_migrated:${migrated.stderr || migrated.stdout}`);
  }
  const migratedText = await readFile(configPath, 'utf8');
  for (const expected of [
    'threads = 0',
    'delay_ms = 1000',
    'spam_senders = [ { rpc = "spam1", max_retries = 0 } ]',
  ]) {
    if (!migratedText.includes(expected)) throw new Error(`missing_expected_migration:${expected}`);
  }
  for (const forbidden of ['senders = [{', 'id = "spam1", max_retries']) {
    if (migratedText.includes(forbidden)) throw new Error(`hybrid_field_survived:${forbidden}`);
  }
  if (/require_profit\s*=/i.test(migratedText)) {
    throw new Error('hybrid_field_survived:require_profit');
  }
  const tokenLines = migratedText.split(/\r?\n/);
  const tokenStart = tokenLines.findIndex((line) => line.trim() === '[token_accounts_checker]');
  const tokenRest = tokenStart < 0 ? [] : tokenLines.slice(tokenStart + 1);
  const tokenEnd = tokenRest.findIndex((line) => /^\s*\[/.test(line));
  const tokenChecker = tokenStart < 0
    ? ''
    : tokenRest.slice(0, tokenEnd < 0 ? tokenRest.length : tokenEnd).join('\n');
  if (!tokenChecker.includes(`rpc_url = "${heliusUrl}"`)) {
    throw new Error('token_checker_not_migrated_to_spam_rpc');
  }
  for (const section of ['blockhash_updater', 'price_updater', 'market_loader', 'lookup_table_loader']) {
    const expression = new RegExp(`\\[${section.replace('.', '\\.') }\\][\\s\\S]*?rpc_url\\s*=\\s*"${readerUrl.replace(/[./]/g, '\\$&')}"`);
    if (!expression.test(migratedText)) throw new Error(`reader_not_migrated_to_last_reader:${section}`);
  }

  const asserted = await run(process.execPath, [assertion, configPath]);
  if (asserted.code !== 0 || !asserted.stdout.includes('last_live_config_valid')) {
    throw new Error(`migrated_profile_not_valid:${asserted.stderr || asserted.stdout}`);
  }

  const idempotent = await run(process.execPath, migrationArgs);
  if (idempotent.code !== 0 || !idempotent.stdout.includes('last_live_config_already_v1_1_2')) {
    throw new Error(`migration_not_idempotent:${idempotent.stderr || idempotent.stdout}`);
  }

  console.log(JSON.stringify({ status: 'last_live_config_migration_test_passed' }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
