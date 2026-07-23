#!/usr/bin/env node
// Exercises the deployment-only migration without contacting an RPC or
// starting NotArb. It covers the legacy spam-RPC profile that the v1.1.2
// onchain-bot does not load into its [[sender]] map.

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
  // Model the deployed predecessor: direct reader URLs plus the old spam-RPC
  // schema. Migration must preserve the private sender/token-index URL while
  // moving the four core read roles and unwrap reader to the recovered 82
  // reader. Its legacy unwrap section has a disabled switch, a stale reader,
  // and no sender RPC list.
  const legacyUnwrapper = [
    '[wsol_unwrapper]',
    'enabled = false',
    `reader_rpc_url = "${heliusUrl}"`,
  ].join('\n');
  const hybrid = configured
    .replaceAll(readerUrl, heliusUrl)
    .replace('threads = 0', 'threads = 1')
    .replace('delay_ms = 1000', 'delay_ms = 250')
    .replace(/\[wsol_unwrapper\][\s\S]*?(?=\n\[notarb_markets\])/, legacyUnwrapper)
    .replace(/^\[\[sender\]\]$/m, '[[spam_rpc]]')
    .replace(
      /^(\[\[spam_rpc\]\][\s\S]*?^url\s*=\s*"https:\/\/mainnet\.helius-rpc\.com\/\?api-key=fixture-indexed-key")/m,
      '$1\nmax_idle_connections = 1',
    )
    .replace(
      'senders = [{ id = "spam1", max_retries = 0 }]',
      'spam_senders = [{ rpc = "spam1", max_retries = 0, require_profit = true }]',
    );
  await writeFile(join(directory, 'fixture-keypair.json'), '[]\n', 'utf8');
  await writeFile(configPath, hybrid, 'utf8');

  const migrationArgs = [migration, configPath];
  const migrated = await run(process.execPath, migrationArgs);
  if (migrated.code !== 0 || !migrated.stdout.includes('last_live_config_migrated_v1_1_2')) {
    throw new Error(`hybrid_profile_not_migrated:${migrated.stderr || migrated.stdout}`);
  }
  if (`${migrated.stdout}${migrated.stderr}`.includes(heliusUrl)) {
    throw new Error('migration_output_exposed_private_sender_url');
  }
  for (const change of [
    'blockhash_updater_delay_ms',
    'wsol_unwrapper_enabled',
    'wsol_unwrapper_reader_rpc',
    'wsol_unwrapper_sender_rpc_urls',
  ]) {
    if (!migrated.stdout.includes(change)) {
      throw new Error(`expected_change_not_reported:${change}:${migrated.stderr || migrated.stdout}`);
    }
  }
  const migratedText = await readFile(configPath, 'utf8');
  for (const expected of [
    'threads = 0',
    'delay_ms = 1000',
    '[[sender]]',
    'senders = [ { id = "spam1", max_retries = 0 } ]',
  ]) {
    if (!migratedText.includes(expected)) throw new Error(`missing_expected_migration:${expected}`);
  }
  for (const forbidden of ['[[spam_rpc]]', 'spam_senders =', 'rpc = "spam1"', 'max_idle_connections']) {
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
    throw new Error('token_checker_not_migrated_to_sender');
  }
  const unwrapStart = tokenLines.findIndex((line) => line.trim() === '[wsol_unwrapper]');
  const unwrapRest = unwrapStart < 0 ? [] : tokenLines.slice(unwrapStart + 1);
  const unwrapEnd = unwrapRest.findIndex((line) => /^\s*\[/.test(line));
  const unwrapConfig = unwrapStart < 0
    ? ''
    : unwrapRest.slice(0, unwrapEnd < 0 ? unwrapRest.length : unwrapEnd).join('\n');
  for (const expected of [
    'enabled = true',
    `reader_rpc_url = "${readerUrl}"`,
    `sender_rpc_urls = ["${heliusUrl}"]`,
  ]) {
    if (!unwrapConfig.includes(expected)) throw new Error(`unwrap_not_migrated:${expected}`);
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

  // Ambiguous mixed schemas must fail without rewriting the private TOML.
  const mixedPath = join(directory, 'mixed-live-config.toml');
  const mixed = `${configured}\n[[spam_rpc]]\nenabled = true\nid = "spam1"\nurl = "${heliusUrl}"\n`;
  await writeFile(mixedPath, mixed, 'utf8');
  const mixedResult = await run(process.execPath, [migration, mixedPath]);
  if (mixedResult.code === 0 || !`${mixedResult.stdout}${mixedResult.stderr}`.includes('contains both [[sender]] and legacy [[spam_rpc]]')) {
    throw new Error(`mixed_schema_not_rejected:${mixedResult.stderr || mixedResult.stdout}`);
  }
  if (await readFile(mixedPath, 'utf8') !== mixed) {
    throw new Error('mixed_schema_was_rewritten');
  }

  console.log(JSON.stringify({ status: 'last_live_config_migration_test_passed' }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
