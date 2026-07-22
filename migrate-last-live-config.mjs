#!/usr/bin/env node
// Normalize only the known mixed-schema LAST live profile to the configuration
// documented in the official NotArb v1.1.2 distribution.  That release pairs
// [[spam_rpc]] with [[swap.strategy]].spam_senders; [[sender]] / senders is a
// different schema and must not be combined with the v1.1.2 spam RPC profile.
//
// This utility deliberately does not print the TOML or its endpoint URL.  It
// is invoked by the deployment job before the normal live-profile assertion.

import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

async function main() {
const [configPath, ...options] = process.argv.slice(2);
if (!configPath || options.length !== 0) {
  fail('Usage: node migrate-last-live-config.mjs <live-config.toml>');
}

const original = await readFile(configPath, 'utf8');
const mode = (await stat(configPath)).mode & 0o777;
const document = new TomlSections(original);
const changes = [];

if (document.count('sender') !== 0) {
  fail('The v1.1.2 LAST live profile must not contain [[sender]].');
}
const spamRpc = document.exactlyOne('spam_rpc');
const spamId = spamRpc.stringValue('id');
if (spamId !== 'spam1') {
  fail('The v1.1.2 LAST live profile requires [[spam_rpc]] id = "spam1".');
}
const spamUrl = spamRpc.stringValue('url');
if (!/^https:\/\/mainnet\.helius-rpc\.com\/\?api-key=.+$/i.test(spamUrl)) {
  fail('The v1.1.2 LAST live profile requires a configured Helius [[spam_rpc]] URL.');
}

const executor = document.exactlyOne('transaction_executor');
if (executor.value('threads') !== '0') {
  executor.setValue('threads', '0');
  changes.push('transaction_executor_threads');
}

const tokenChecker = document.exactlyOne('token_accounts_checker');
if (tokenChecker.stringValue('rpc_url') !== spamUrl) {
  tokenChecker.setValue('rpc_url', JSON.stringify(spamUrl));
  changes.push('token_accounts_checker_spam_rpc');
}

const strategy = document.exactlyOne('swap.strategy');
if (strategy.has('senders') && strategy.has('spam_senders')) {
  fail('The strategy contains both senders and spam_senders.');
}
if (strategy.has('senders')) {
  const normalized = normalizeSpamSenderArray(strategy.value('senders'));
  strategy.renameValue('senders', 'spam_senders', normalized);
  changes.push('strategy_sender_schema');
} else if (strategy.has('spam_senders')) {
  const normalized = normalizeSpamSenderArray(strategy.value('spam_senders'));
  if (normalized !== strategy.value('spam_senders')) {
    strategy.setValue('spam_senders', normalized);
    changes.push('strategy_sender_fields');
  }
} else {
  fail('The v1.1.2 LAST live strategy is missing spam_senders.');
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

function normalizeSpamSenderArray(value) {
  const text = value.trim();
  if (!text.startsWith('[') || !text.endsWith(']')) {
    fail('Strategy sender configuration must be a TOML array.');
  }
  const bodies = [...text.matchAll(/\{([^{}]*)\}/g)];
  if (bodies.length !== 1 || text.replace(/\{[^{}]*\}/g, '').replace(/[\s,\[\]]/g, '') !== '') {
    fail('The v1.1.2 LAST live profile requires exactly one spam sender object.');
  }
  const rawFields = bodies[0][1]
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
  const hadLegacyId = rawFields.some((field) => /^id\s*=/i.test(field));
  const hadRequireProfit = rawFields.some((field) => /^require_profit\s*=/i.test(field));
  const fields = rawFields
    .filter((field) => !/^require_profit\s*=/i.test(field))
    .map((field) => field.replace(/^id\s*=/i, 'rpc ='));
  const values = new Map();
  for (const field of fields) {
    const match = field.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/s);
    if (!match) fail('Unsupported sender field syntax in the v1.1.2 migration.');
    if (values.has(match[1])) fail(`Duplicate sender field in the v1.1.2 migration: ${match[1]}.`);
    values.set(match[1], match[2].trim());
  }
  if (values.get('rpc') !== '"spam1"' || values.get('max_retries') !== '0') {
    fail('The v1.1.2 LAST live profile requires rpc = "spam1" and max_retries = 0.');
  }
  for (const unsupported of ['id', 'require_profit', 'min_tip', 'max_tip']) {
    if (values.has(unsupported)) fail(`Unsupported v1.1.2 spam sender field: ${unsupported}.`);
  }
  if (!hadLegacyId && !hadRequireProfit) return value;
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
      current = new TomlSection(this, header[2], index, this.lines.length);
      this.sections.push(current);
    }
    if (current) current.end = this.lines.length;
  }

  count(name) {
    return this.sections.filter((section) => section.name === name).length;
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
  constructor(document, name, start, end) {
    this.document = document;
    this.name = name;
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
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fail(message) {
  console.error(JSON.stringify({ status: 'last_live_config_migration_invalid', message }));
  process.exit(1);
}

await main();
