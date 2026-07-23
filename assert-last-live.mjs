#!/usr/bin/env node
// Guard the local LAST live runner. It checks that the process remains
// target-only while explicitly enabling one ordinary Helius RPC sender and
// flash loans. The recovered 82 reader supplies blockhash, price, market, and
// ALT data; the token-account secondary-index check and ordinary spam sender
// use the one private Helius endpoint.

import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const configPath = process.argv[2];
if (!configPath) fail('Usage: node assert-last-live.mjs <config.toml>');
const LAST_READER_RPC = 'http://82.39.215.201:8899';
const isConfiguredHeliusMainnetRpc = (value) => (
  /^https:\/\/mainnet\.helius-rpc\.com\/\?api-key=.+$/i.test(value)
  && !/REPLACE_WITH_/i.test(value)
);

const text = await readFile(configPath, 'utf8');
const sections = [];
let section = null;

for (const sourceLine of text.split(/\r?\n/)) {
  const line = sourceLine.replace(/\s+#.*$/, '').trim();
  if (!line) continue;
  const multi = line.match(/^\[\[([^\]]+)\]\]$/);
  const single = line.match(/^\[([^\]]+)\]$/);
  if (multi || single) {
    section = { name: (multi ?? single)[1], multi: Boolean(multi), values: new Map() };
    sections.push(section);
    continue;
  }
  const assignment = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
  if (assignment && section) section.values.set(assignment[1], assignment[2].trim());
}

const named = (name) => sections.filter((item) => item.name === name);
const exactlyOne = (name) => {
  const entries = named(name);
  if (entries.length !== 1) fail(`Expected exactly one [${name}] section; found ${entries.length}.`);
  return entries[0];
};
const expect = (sectionValue, key, value) => {
  if (sectionValue.values.get(key) !== value) fail(`[${sectionValue.name}] ${key} must be ${value}.`);
};
const stringValue = (sectionValue, key) => {
  const value = sectionValue.values.get(key);
  if (!value || !/^".*"$/.test(value)) fail(`[${sectionValue.name}] ${key} must be a TOML string.`);
  return value.slice(1, -1);
};
const exactlyOneEnabledPath = (name, path) => {
  const enabled = named(name).filter((item) => item.values.get('enabled') === 'true');
  if (enabled.length !== 1 || enabled[0].values.get('path') !== `"${path}"`) {
    fail(`Expected exactly one enabled [[${name}]] using ${path}.`);
  }
};

const markets = exactlyOne('notarb_markets');
expect(markets, 'enabled', 'false');
expect(markets, 'dry_run', 'false');
exactlyOne('notarb');
const user = exactlyOne('user');
const keypairPath = stringValue(user, 'keypair_path');
if (!keypairPath || /^REPLACE_WITH_/i.test(keypairPath)) fail('[user] keypair_path must name a local bot keypair.');
try {
  await stat(resolve(dirname(configPath), keypairPath));
} catch {
  fail(`[user] keypair_path does not exist: ${keypairPath}`);
}
// In NotArb v1.1.2, zero selects the dynamic cached executor thread pool; it
// does not disable the enabled sender/swap execution path.
expect(exactlyOne('transaction_executor'), 'threads', '0');
expect(exactlyOne('wsol_unwrapper'), 'enabled', 'false');
const tokenAccounts = exactlyOne('token_accounts_checker');
const tokenAccountsRpc = stringValue(tokenAccounts, 'rpc_url');
if (!isConfiguredHeliusMainnetRpc(tokenAccountsRpc)) {
  fail('[token_accounts_checker] rpc_url must be a configured indexed Helius mainnet RPC endpoint.');
}
expect(tokenAccounts, 'delay_seconds', '3');
const blockhashUpdater = exactlyOne('blockhash_updater');
const configuredReadRpc = stringValue(blockhashUpdater, 'rpc_url');
if (integerValue(blockhashUpdater, 'delay_ms') < 1000) {
  fail('[blockhash_updater] delay_ms must be at least 1000.');
}
if (configuredReadRpc !== LAST_READER_RPC) {
  fail(`[blockhash_updater] rpc_url must be ${LAST_READER_RPC}.`);
}
if (process.env.LAST_READ_RPC_URL && process.env.LAST_READ_RPC_URL !== configuredReadRpc) {
  fail('LAST_READ_RPC_URL must match the configured 82 reader RPC.');
}
const expectedReadRpcValue = JSON.stringify(configuredReadRpc);
for (const readRpcSection of ['blockhash_updater', 'price_updater', 'market_loader', 'lookup_table_loader']) {
  expect(exactlyOne(readRpcSection), 'rpc_url', expectedReadRpcValue);
}
exactlyOneEnabledPath('markets_file', 'last-target-markets.json');
exactlyOneEnabledPath('lookup_tables_file', 'last-target-lookup-tables.txt');

if (named('sender').length !== 0) fail('[[sender]] must be absent for the ordinary-RPC LAST profile.');
const spamRpc = exactlyOne('spam_rpc');
expect(spamRpc, 'enabled', 'true');
expect(spamRpc, 'id', '"spam1"');
const sendingRpcUrl = stringValue(spamRpc, 'url');
if (!isConfiguredHeliusMainnetRpc(sendingRpcUrl)) {
  fail('[[spam_rpc]] url must be a configured Helius mainnet RPC endpoint.');
}
if (tokenAccountsRpc !== sendingRpcUrl) {
  fail('[token_accounts_checker] rpc_url must exactly match the [[spam_rpc]] spam1 url.');
}
const swap = exactlyOne('swap');
expect(swap, 'enabled', 'true');
const defaults = exactlyOne('swap.strategy_defaults');
expect(defaults, 'flash_loan', 'true');
const strategy = exactlyOne('swap.strategy');
expect(strategy, 'enabled', 'true');
if (strategy.values.has('senders')) {
  fail('[[swap.strategy]] must use spam_senders, not senders.');
}
const strategySpamSenders = strategy.values.get('spam_senders') ?? '';
const spamSenderRpcCount = (strategySpamSenders.match(/\brpc\s*=/g) ?? []).length;
if (!/rpc\s*=\s*"spam1"/.test(strategySpamSenders)
  || spamSenderRpcCount !== 1
  || !/max_retries\s*=\s*0/.test(strategySpamSenders)
  || /jito|\bmin_tip\b|\bmax_tip\b/i.test(strategySpamSenders)) {
  fail('[[swap.strategy]] spam_senders must use only rpc=spam1 with max_retries=0.');
}
expect(strategy, 'cu_limit', '369100');
expect(strategy, 'min_priority_fee_lamports', '1000');
expect(strategy, 'max_priority_fee_lamports', '25000');
expect(strategy, 'cooldown_ms', '1000');

console.log(JSON.stringify({
  status: 'last_live_config_valid',
  configPath,
  sender: spamRpc.values.get('id')?.replace(/^"|"$/g, '') ?? null,
  flashLoan: defaults.values.get('flash_loan') === 'true',
}));

function fail(message) {
  console.error(JSON.stringify({ status: 'last_live_config_invalid', message }));
  process.exit(1);
}

function integerValue(sectionValue, key) {
  const value = sectionValue.values.get(key);
  if (!value || !/^[+-]?\d(?:_?\d)*$/.test(value)) {
    fail(`[${sectionValue.name}] ${key} must be a TOML integer.`);
  }
  const parsed = Number(value.replaceAll('_', ''));
  if (!Number.isSafeInteger(parsed)) {
    fail(`[${sectionValue.name}] ${key} must be a safe TOML integer.`);
  }
  return parsed;
}
