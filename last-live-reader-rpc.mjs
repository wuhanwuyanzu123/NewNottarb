#!/usr/bin/env node
// Extract the configured core reader from a private LAST live TOML without
// printing the full configuration. The Linux runners capture its stdout into
// an environment variable so no reader URL is placed in a process argv.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import process from 'node:process';

function normalizedLines(toml) {
  return toml.split(/\r?\n/).map((sourceLine) => sourceLine.replace(/\s+#.*$/, '').trim());
}

function quotedAssignment(line, key) {
  const assignment = line.match(new RegExp(`^${key}\\s*=\\s*"([^"\\r\\n]+)"\\s*$`));
  return assignment?.[1] ?? null;
}

// Returns the endpoint NotArb itself uses for its shared read path. It is
// deliberately not logged by any caller.
export function blockhashReaderRpc(toml) {
  let inBlockhashUpdater = false;
  for (const line of normalizedLines(toml)) {
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      inBlockhashUpdater = section[1] === 'blockhash_updater';
      continue;
    }
    if (!inBlockhashUpdater) continue;
    const rpc = quotedAssignment(line, 'rpc_url');
    if (rpc && /^https?:\/\//i.test(rpc)) return rpc;
  }
  return null;
}

async function main() {
  const [configPath, ...extra] = process.argv.slice(2);
  if (!configPath || extra.length) {
    process.exitCode = 2;
    return;
  }
  const toml = await readFile(configPath, 'utf8');
  const rpc = blockhashReaderRpc(toml);
  if (!rpc) {
    process.exitCode = 2;
    return;
  }
  process.stdout.write(rpc);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
