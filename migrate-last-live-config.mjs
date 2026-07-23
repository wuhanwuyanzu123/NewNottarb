#!/usr/bin/env node
// Normalize only the known legacy LAST live profile to the schema accepted by
// the installed NotArb v1.1.2 onchain-bot.  Its sender constructor builds the
// [[sender]] map and [[swap.strategy]].senders selects one entry from that map.
// The old [[spam_rpc]] / spam_senders pair is not read by this onchain path.
//
// This utility deliberately does not print the TOML or its endpoint URL.  It
// is invoked by the deployment job before the normal live-profile assertion.

import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

const LAST_READER_RPC = 'http://82.39.215.201:8899';

async function main() {
const [configPath, ...options] = process.argv.slice(2);
if (!configPath || options.length !== 0) {
  fail('Usage: node migrate-last-live-config.mjs <live-config.toml>');
}

const original = await readFile(configPath, 'utf8');
const mode = (await stat(configPath)).mode & 0o777;
const document = new TomlSections(original);
const changes = [];

const senderSections = document.named('sender');
const spamRpcSections = document.named('spam_rpc');
if (senderSections.length > 1 || spamRpcSections.length > 1) {
  fail('The LAST live profile permits only one sender definition.');
}
if (senderSections.length !== 0 && spamRpcSections.length !== 0) {
  fail('The LAST live profile contains both [[sender]] and legacy [[spam_rpc]].');
}

let sender;
if (spamRpcSections.length === 1) {
  // Preserve the existing private endpoint verbatim while changing only the
  // section name that the onchain-bot actually reads.
  sender = spamRpcSections[0];
  if (!sender.multi) fail('The legacy spam RPC must be declared as [[spam_rpc]].');
  if (sender.value('enabled') !== 'true' || sender.stringValue('id') !== 'spam1') {
    fail('The legacy spam RPC must be enabled with id = "spam1".');
  }
  sender.rename('sender');
  changes.push('sender_schema');
} else if (senderSections.length === 1) {
  sender = senderSections[0];
  if (!sender.multi) fail('The LAST live sender must be declared as [[sender]].');
} else {
  fail('The LAST live profile requires exactly one [[sender]].');
}

if (sender.value('enabled') !== 'true' || sender.stringValue('id') !== 'spam1') {
  fail('The LAST live sender must be enabled with id = "spam1".');
}
const senderUrl = sender.stringValue('url');
if (!/^https:\/\/mainnet\.helius-rpc\.com\/\?api-key=.+$/i.test(senderUrl)) {
  fail('The LAST live profile requires a configured Helius [[sender]] URL.');
}
// max_idle_connections was a spam-RPC-only knob.  Dropping it avoids relying
// on an unrecognized field if a predecessor happened to carry one.
if (sender.has('max_idle_connections')) {
  sender.removeValue('max_idle_connections');
  changes.push('sender_max_idle_connections_removed');
}

const executor = document.exactlyOne('transaction_executor');
if (executor.value('threads') !== '0') {
  executor.setValue('threads', '0');
  changes.push('transaction_executor_threads');
}

const tokenChecker = document.exactlyOne('token_accounts_checker');
if (tokenChecker.stringValue('rpc_url') !== senderUrl) {
  tokenChecker.setValue('rpc_url', JSON.stringify(senderUrl));
  changes.push('token_accounts_checker_sender_rpc');
}

const blockhashUpdater = document.exactlyOne('blockhash_updater');
if (integerValue(blockhashUpdater, 'delay_ms') < 1000) {
  blockhashUpdater.setValue('delay_ms', '1000');
  changes.push('blockhash_updater_delay_ms');
}
for (const readerName of ['blockhash_updater', 'price_updater', 'market_loader', 'lookup_table_loader']) {
  const reader = readerName === 'blockhash_updater' ? blockhashUpdater : document.exactlyOne(readerName);
  if (reader.stringValue('rpc_url') !== LAST_READER_RPC) {
    reader.setValue('rpc_url', JSON.stringify(LAST_READER_RPC));
    changes.push(`${readerName}_last_reader`);
  }
}

const strategy = document.exactlyOne('swap.strategy');
if (strategy.has('senders') && strategy.has('spam_senders')) {
  fail('The strategy contains both senders and spam_senders.');
}
if (strategy.has('spam_senders')) {
  const normalized = normalizeSenderArray(strategy.value('spam_senders'));
  strategy.renameValue('spam_senders', 'senders', normalized);
  changes.push('strategy_sender_schema');
} else if (strategy.has('senders')) {
  const normalized = normalizeSenderArray(strategy.value('senders'));
  if (normalized !== strategy.value('senders')) {
    strategy.setValue('senders', normalized);
    changes.push('strategy_sender_fields');
  }
} else {
  fail('The LAST live strategy is missing senders.');
}

const migrated = document.render();
if (migrated !== original) {
  const temporary = join(dirname(configPath), `.${basename(configPath)}.${process.pid}.tmp`);
  await writeFile(temporary, migrated, { encoding: 'utf8', mode });
  await chmod(temporary, mode);
  await rename(temporary, configPath);
}

console.log(JSON.stringify({
  status: changes.length ? 'last_live_config_migrated_v1_1_2' : 'last_live_config_already_v1_1_2',
  changes,
}));
}

function normalizeSenderArray(value) {
  const text = value.trim();
  if (!text.startsWith('[') || !text.endsWith(']')) {
    fail('Strategy sender configuration must be a TOML array.');
  }
  const bodies = [...text.matchAll(/\{([^{}]*)\}/g)];
  if (bodies.length !== 1 || text.replace(/\{[^{}]*\}/g, '').replace(/[\s,\[\]]/g, '') !== '') {
    fail('The LAST live profile requires exactly one sender object.');
  }
  const rawFields = bodies[0][1]
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
  let changed = false;
  const fields = [];
  for (const rawField of rawFields) {
    const match = rawField.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/s);
    if (!match) fail('Unsupported sender field syntax in the LAST live migration.');
    let [, key, fieldValue] = match;
    if (key === 'require_profit') {
      changed = true;
      continue;
    }
    if (key === 'rpc') {
      key = 'id';
      changed = true;
    }
    fields.push(`${key} = ${fieldValue.trim()}`);
  }
  const values = new Map();
  for (const field of fields) {
    const match = field.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/s);
    if (!match) fail('Unsupported sender field syntax in the LAST live migration.');
    if (values.has(match[1])) fail(`Duplicate sender field in the LAST live migration: ${match[1]}.`);
    values.set(match[1], match[2].trim());
  }
  if (values.get('id') !== '"spam1"' || values.get('max_retries') !== '0') {
    fail('The LAST live profile requires id = "spam1" and max_retries = 0.');
  }
  for (const unsupported of ['rpc', 'require_profit', 'min_tip', 'max_tip', 'min_jito_tip_lamports', 'max_jito_tip_lamports']) {
    if (values.has(unsupported)) fail(`Unsupported LAST sender field: ${unsupported}.`);
  }
  for (const key of values.keys()) {
    if (!['id', 'max_retries', 'preflight_commitment'].includes(key)) {
      fail(`Unsupported LAST sender field: ${key}.`);
    }
  }
  if (!changed) return value;
  return `[ { ${fields.join(', ')} } ]`;
}

class TomlSections {
  constructor(text) {
    this.lines = text.split(/(?<=\n)/);
    this.sections = [];
    let current = null;
    for (let index = 0; index < this.lines.length; index += 1) {
      const header = this.lines[index].match(/^\s*(\[\[|\[)([A-Za-z0-9_.-]+)(\]\]|\])\s*(?:#.*)?\s*(?:\r?\n)?$/);
      if (!header) continue;
      if ((header[1] === '[[') !== (header[3] === ']]')) fail('Malformed TOML section header.');
      if (current) current.end = index;
      current = new TomlSection(this, header[2], header[1] === '[[', index, this.lines.length);
      this.sections.push(current);
    }
    if (current) current.end = this.lines.length;
  }

  count(name) {
    return this.sections.filter((section) => section.name === name).length;
  }

  named(name) {
    return this.sections.filter((section) => section.name === name);
  }

  exactlyOne(name) {
    const matches = this.sections.filter((section) => section.name === name);
    if (matches.length !== 1) fail(`Expected exactly one [${name}] section; found ${matches.length}.`);
    return matches[0];
  }

  render() {
    return this.lines.join('');
  }
}

class TomlSection {
  constructor(document, name, multi, start, end) {
    this.document = document;
    this.name = name;
    this.multi = multi;
    this.start = start;
    this.end = end;
  }

  assignment(key) {
    const expression = new RegExp(`^(\\s*)(${escapeRegExp(key)})(\\s*=\\s*)(.*?)(\\r?\\n)?$`);
    for (let index = this.start + 1; index < this.end; index += 1) {
      const match = this.document.lines[index].match(expression);
      if (match) return { index, match };
    }
    return null;
  }

  has(key) {
    return this.assignment(key) !== null;
  }

  value(key) {
    const assignment = this.assignment(key);
    if (!assignment) fail(`[${this.name}] is missing ${key}.`);
    return assignment.match[4].replace(/\s+#.*$/, '').trim();
  }

  stringValue(key) {
    const value = this.value(key);
    if (!/^"(?:[^"\\]|\\.)*"$/.test(value)) fail(`[${this.name}] ${key} must be a TOML string.`);
    try {
      return JSON.parse(value);
    } catch {
      fail(`[${this.name}] ${key} must be a valid TOML string.`);
    }
  }

  setValue(key, value) {
    const assignment = this.assignment(key);
    if (!assignment) fail(`[${this.name}] is missing ${key}.`);
    const [, indent, actualKey, separator, , newline = ''] = assignment.match;
    this.document.lines[assignment.index] = `${indent}${actualKey}${separator}${value}${newline}`;
  }

  renameValue(oldKey, newKey, value) {
    const assignment = this.assignment(oldKey);
    if (!assignment) fail(`[${this.name}] is missing ${oldKey}.`);
    const [, indent, , separator, , newline = ''] = assignment.match;
    this.document.lines[assignment.index] = `${indent}${newKey}${separator}${value}${newline}`;
  }

  removeValue(key) {
    const assignment = this.assignment(key);
    if (!assignment) return;
    this.document.lines[assignment.index] = '';
  }

  rename(name) {
    if (!this.multi) fail(`[[${this.name}]] must be an array-of-tables section.`);
    const current = this.document.lines[this.start];
    const updated = current.replace(/^(\s*\[\[)[A-Za-z0-9_.-]+(\]\])/, `$1${name}$2`);
    if (updated === current) fail(`Could not rename [[${this.name}]].`);
    this.document.lines[this.start] = updated;
    this.name = name;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function integerValue(section, key) {
  const value = section.value(key);
  if (!/^[+-]?\d(?:_?\d)*$/.test(value)) {
    fail(`[${section.name}] ${key} must be a TOML integer.`);
  }
  const parsed = Number(value.replaceAll('_', ''));
  if (!Number.isSafeInteger(parsed)) {
    fail(`[${section.name}] ${key} must be a safe TOML integer.`);
  }
  return parsed;
}

function fail(message) {
  console.error(JSON.stringify({ status: 'last_live_config_migration_invalid', message }));
  process.exit(1);
}

await main();
