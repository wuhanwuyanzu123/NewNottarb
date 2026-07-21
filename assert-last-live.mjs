#!/usr/bin/env node
// Guard the local LAST live runner. It checks that the process remains
// target-only while explicitly enabling one Jito sender and flash loans.

import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const configPath = process.argv[2];
if (!configPath) fail('Usage: node assert-last-live.mjs <config.toml>');

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
expect(exactlyOne('transaction_executor'), 'threads', '1');
expect(exactlyOne('wsol_unwrapper'), 'enabled', 'false');
const tokenAccounts = exactlyOne('token_accounts_checker');
const tokenAccountsRpc = stringValue(tokenAccounts, 'rpc_url');
if (!tokenAccountsRpc || /^REPLACE_WITH_/i.test(tokenAccountsRpc)) fail('[token_accounts_checker] rpc_url must be configured.');
expect(tokenAccounts, 'delay_seconds', '3');
exactlyOneEnabledPath('markets_file', 'last-target-markets.json');
exactlyOneEnabledPath('lookup_tables_file', 'last-target-lookup-tables.txt');

const sender = exactlyOne('sender');
expect(sender, 'id', '"jito-ams"');
expect(sender, 'url', '"https://amsterdam.mainnet.block-engine.jito.wtf"');
expect(sender, 'tip_type', '"jito"');
if (!sender.values.has('uuid')) fail('[[sender]] uuid must be present.');

const swap = exactlyOne('swap');
expect(swap, 'enabled', 'true');
const defaults = exactlyOne('swap.strategy_defaults');
expect(defaults, 'flash_loan', 'true');
const strategy = exactlyOne('swap.strategy');
expect(strategy, 'enabled', 'true');
const strategySenders = strategy.values.get('senders') ?? '';
if (!/id\s*=\s*"jito-ams"/.test(strategySenders)
  || !/require_profit\s*=\s*true/.test(strategySenders)
  || !/min_tip\s*=\s*1000/.test(strategySenders)
  || !/max_tip\s*=\s*25000/.test(strategySenders)) {
  fail('[[swap.strategy]] senders must use jito-ams with 1000..25000 tips and require_profit=true.');
}
expect(strategy, 'cooldown_ms', '1000');

console.log(JSON.stringify({
  status: 'last_live_config_valid',
  configPath,
  sender: sender.values.get('id')?.replace(/^"|"$/g, '') ?? null,
  flashLoan: defaults.values.get('flash_loan') === 'true',
}));

function fail(message) {
  console.error(JSON.stringify({ status: 'last_live_config_invalid', message }));
  process.exit(1);
}
