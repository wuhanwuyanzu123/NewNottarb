#!/usr/bin/env node
// Minimal guard for the local LAST target runner. It deliberately validates
// only the safety-critical TOML fields before a background bot is started.

import { readFile } from 'node:fs/promises';
import process from 'node:process';

const configPath = process.argv[2];
if (!configPath) fail('Usage: node assert-last-dryrun.mjs <config.toml>');

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
const exactlyOneEnabledPath = (name, path) => {
  const enabled = named(name).filter((item) => item.values.get('enabled') === 'true');
  if (enabled.length !== 1 || enabled[0].values.get('path') !== `"${path}"`) {
    fail(`Expected exactly one enabled [[${name}]] using ${path}.`);
  }
};

const markets = exactlyOne('notarb_markets');
expect(markets, 'enabled', 'false');
expect(markets, 'dry_run', 'true');
expect(exactlyOne('transaction_executor'), 'threads', '0');
expect(exactlyOne('wsol_unwrapper'), 'enabled', 'false');

exactlyOneEnabledPath('markets_file', 'last-target-markets.json');
exactlyOneEnabledPath('lookup_tables_file', 'last-target-lookup-tables.txt');
if (named('sender').length) fail('[[sender]] is forbidden in the LAST dry-run config.');
if (named('nonce_pool').length) fail('[[nonce_pool]] is forbidden in the LAST dry-run config.');

for (const swap of [...named('swap'), ...named('swap.strategy')]) {
  expect(swap, 'enabled', 'false');
  if (swap.name === 'swap.strategy') expect(swap, 'senders', '[]');
}

console.log(JSON.stringify({ status: 'last_dry_run_config_valid', configPath }));

function fail(message) {
  console.error(JSON.stringify({ status: 'last_dry_run_config_invalid', message }));
  process.exit(1);
}
