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
const readRpcUrl = 'http://82.39.215.201:8899';
const heliusUrl = 'https://mainnet.helius-rpc.com/?api-key=fixture-indexed-key';
const directory = await mkdtemp(join(tmpdir(), 'last-live-config-'));
const configPath = join(directory, 'notarb-last-grpc-live.toml');

async function runAssertion(config) {
  await writeFile(configPath, config, 'utf8');
  try {
    const result = await execFileAsync(process.execPath, [assertion, configPath], {
      cwd: directory,
      env: { ...process.env, LAST_READ_RPC_URL: readRpcUrl },
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
    .replaceAll('http://127.0.0.1:18899', readRpcUrl)
    .replaceAll('https://mainnet.helius-rpc.com/?api-key=REPLACE_WITH_HELIUS_API_KEY', heliusUrl);
  await writeFile(join(directory, 'fixture-keypair.json'), '[]\n', 'utf8');

  // The v1.1.2 ordinary-RPC profile is a [[spam_rpc]] paired with
  // spam_senders, and the checker uses the exact same indexed Helius URL.
  await expectValid(config);

  await expectInvalid(
    'legacy_senders',
    config.replace(
      'spam_senders = [{ rpc = "spam1", max_retries = 0, require_profit = true }]',
      'senders = [{ id = "spam1", max_retries = 0, require_profit = true }]',
    ),
    'must use spam_senders, not senders',
  );

  await expectInvalid(
    'separate_token_checker_endpoint',
    config.replace(
      `rpc_url = "${heliusUrl}"`,
      'rpc_url = "https://mainnet.helius-rpc.com/?api-key=other-indexed-key"',
    ),
    'must exactly match the [[spam_rpc]] spam1 url',
  );

  await expectInvalid(
    'reader_rpc_mismatch',
    config.replace(
      `[market_loader]\nrpc_url = "${readRpcUrl}"`,
      '[market_loader]\nrpc_url = "http://different-reader.invalid:8899"',
    ),
    '[market_loader] rpc_url must be',
  );

  await expectInvalid(
    'multiple_spam_senders',
    config.replace(
      'spam_senders = [{ rpc = "spam1", max_retries = 0, require_profit = true }]',
      'spam_senders = [{ rpc = "spam1", max_retries = 0, require_profit = true }, { rpc = "spam2", max_retries = 0, require_profit = true }]',
    ),
    'must use only rpc=spam1',
  );

  await expectInvalid(
    'tip_sender_section',
    `${config}\n[[sender]]\nid = "other"\nurl = "https://example.invalid"\n`,
    '[[sender]] must be absent',
  );

  console.log(JSON.stringify({ status: 'last_live_config_test_passed' }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
