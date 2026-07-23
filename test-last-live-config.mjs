#!/usr/bin/env node
// Offline contract test for the LAST live profile. It never starts NotArb or
// contacts an RPC; it only runs the local configuration assertion against
// temporary TOML copies.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(process.cwd());
const assertion = join(root, 'assert-last-live.mjs');
const templatePath = join(root, 'notarb-last-grpc-live.example.toml');
const heliusUrl = 'https://mainnet.helius-rpc.com/?api-key=fixture-indexed-key';
const readerUrl = 'http://82.39.215.201:8899';
const directory = await mkdtemp(join(tmpdir(), 'last-live-config-'));
const configPath = join(directory, 'notarb-last-grpc-live.toml');
const { LAST_READ_RPC_URL: _ignoredReadRpcUrl, ...environmentWithoutReadRpc } = process.env;

async function runAssertion(config) {
  await writeFile(configPath, config, 'utf8');
  try {
    const result = await execFileAsync(process.execPath, [assertion, configPath], {
      cwd: directory,
      // Leave LAST_READ_RPC_URL unset: the private live TOML's blockhash
      // reader is the source of truth for all four reader/load RPC sections.
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

async function expectValid(config) {
  const result = await runAssertion(config);
  if (result.code !== 0 || !result.stdout.includes('last_live_config_valid')) {
    throw new Error(`valid_profile_rejected:${result.stderr || result.stdout}`);
  }
}

async function expectInvalid(name, config, expectedMessage) {
  const result = await runAssertion(config);
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code === 0) throw new Error(`${name}:invalid_profile_accepted`);
  if (!output.includes(expectedMessage)) {
    throw new Error(`${name}:unexpected_error:${output.trim()}`);
  }
}

try {
  const template = await readFile(templatePath, 'utf8');
  const config = template
    .replace('REPLACE_WITH_DEDICATED_FUNDED_KEYPAIR.json', 'fixture-keypair.json')
    .replaceAll('https://mainnet.helius-rpc.com/?api-key=REPLACE_WITH_HELIUS_API_KEY', heliusUrl);
  await writeFile(join(directory, 'fixture-keypair.json'), '[]\n', 'utf8');

  // The v1.1.2 onchain-bot maps [[sender]] entries and each strategy selects
  // one through senders. Core market readers use the recovered 82 reader; the
  // token account checker and spam1 share the configured Helius URL. threads=0 is dynamic.
  await expectValid(config);

  await expectInvalid(
    'executor_enabled',
    config.replace('threads = 0', 'threads = 1'),
    '[transaction_executor] threads must be 0',
  );

  await expectInvalid(
    'wsol_unwrapper_disabled',
    config.replace('[wsol_unwrapper]\nenabled = true', '[wsol_unwrapper]\nenabled = false'),
    '[wsol_unwrapper] enabled must be true',
  );

  await expectInvalid(
    'wsol_unwrapper_sender_mismatch',
    config.replace(
      'sender_rpc_urls = ["https://mainnet.helius-rpc.com/?api-key=fixture-indexed-key"]',
      'sender_rpc_urls = ["https://mainnet.helius-rpc.com/?api-key=other-sender-key"]',
    ),
    '[wsol_unwrapper] sender_rpc_urls must contain only the configured sender URL',
  );

  await expectInvalid(
    'blockhash_delay_below_minimum',
    config.replace('delay_ms = 1000', 'delay_ms = 999'),
    '[blockhash_updater] delay_ms must be at least 1000',
  );

  await expectInvalid(
    'legacy_spam_senders',
    config.replace(
      'senders = [{ id = "spam1", max_retries = 0 }]',
      'spam_senders = [{ rpc = "spam1", max_retries = 0 }]',
    ),
    'must use senders, not spam_senders',
  );

  await expectInvalid(
    'token_checker_sender_rpc_mismatch',
    config.replace(
      /(\[token_accounts_checker\][\s\S]*?rpc_url\s*=\s*)"[^"\n]+"/,
      '$1"https://mainnet.helius-rpc.com/?api-key=other-indexed-key"',
    ),
    '[token_accounts_checker] rpc_url must exactly match',
  );

  await expectInvalid(
    'reader_rpc_mismatch',
    config.replace(
      `[market_loader]\nrpc_url = "${readerUrl}"`,
      '[market_loader]\nrpc_url = "http://different-reader.invalid:8899"',
    ),
    '[market_loader] rpc_url must be',
  );

  await expectInvalid(
    'multiple_senders',
    config.replace(
      'senders = [{ id = "spam1", max_retries = 0 }]',
      'senders = [{ id = "spam1", max_retries = 0 }, { id = "spam2", max_retries = 0 }]',
    ),
    'must use only id=spam1',
  );

  await expectInvalid(
    'legacy_spam_rpc_section',
    config.replace(/^\[\[sender\]\]$/m, '[[spam_rpc]]'),
    '[[spam_rpc]] is not accepted',
  );

  await expectInvalid(
    'duplicate_sender_section',
    `${config}\n[[sender]]\nenabled = true\nid = "other"\nurl = "https://example.invalid"\n`,
    'Expected exactly one [sender] section',
  );

  console.log(JSON.stringify({ status: 'last_live_config_test_passed' }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
