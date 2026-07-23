#!/usr/bin/env node
// Offline contract for the Linux fee-payer diagnostic.  All RPC responses are
// injected, so this test never connects to a public or private endpoint.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  base58Encode,
  configuredFeePayerInputs,
  feePayerFromKeypairJson,
  runFeePayerPreflight,
} from './last-live-fee-payer-preflight.mjs';

const readerRpcUrl = 'http://82.39.215.201:8899';
const expectedFeePayer = '11111111111111111111111111111111';
const directory = await mkdtemp(join(tmpdir(), 'last-live-fee-payer-preflight-'));
const configPath = join(directory, 'live.toml');
const keypairPath = join(directory, 'fee-payer.json');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  // The first 32 bytes deliberately differ from the final public half.  This
  // proves the helper reads the public-key half of a standard Solana keypair.
  const keypair = [...Array(32).fill(255), ...Array(32).fill(0)];
  await writeFile(keypairPath, `${JSON.stringify(keypair)}\n`, 'utf8');
  await writeFile(configPath, [
    '[user]',
    'keypair_path = "fee-payer.json"',
    '',
    '[blockhash_updater]',
    `rpc_url = "${readerRpcUrl}"`,
    '',
  ].join('\n'), 'utf8');

  assert(base58Encode(Uint8Array.from([0, 0, 1])) === '112', 'base58_leading_zeroes_wrong');
  assert(feePayerFromKeypairJson(JSON.stringify(keypair)) === expectedFeePayer, 'public_half_not_derived');

  const inputs = configuredFeePayerInputs(await readFile(configPath, 'utf8'), configPath);
  assert(inputs.readerRpcUrl === readerRpcUrl, 'blockhash_reader_not_selected');
  assert(inputs.keypairPath === keypairPath, 'relative_keypair_path_not_resolved');

  let zeroRequest = null;
  const zeroRecord = await runFeePayerPreflight({
    configPath,
    timeoutMs: 100,
    fetchImpl: async (url, options) => {
      zeroRequest = { url, options };
      return {
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 'last-live-fee-payer-balance', result: { value: 0 } }),
      };
    },
  });
  assert(zeroRequest?.url === readerRpcUrl, 'preflight_used_non_blockhash_reader');
  const zeroBody = JSON.parse(zeroRequest.options.body);
  assert(zeroBody.method === 'getBalance', 'preflight_used_wrong_rpc_method');
  assert(zeroBody.params[0] === expectedFeePayer, 'preflight_used_wrong_fee_payer');
  assert(zeroRecord.status === 'last_live_fee_payer_unfunded', 'zero_balance_did_not_warn');
  assert(zeroRecord.severity === 'warning' && zeroRecord.lamports === 0, 'zero_balance_warning_incomplete');

  const positiveRecord = await runFeePayerPreflight({
    configPath,
    timeoutMs: 100,
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: { value: 1 } }) }),
  });
  assert(positiveRecord.status === 'last_live_fee_payer_balance_checked', 'positive_balance_not_reported');
  assert(positiveRecord.balance_state === 'positive', 'positive_balance_state_wrong');

  await writeFile(keypairPath, '[]\n', 'utf8');
  const invalidKeypairRecord = await runFeePayerPreflight({
    configPath,
    timeoutMs: 100,
    fetchImpl: async () => {
      throw new Error('fetch must not run for an invalid keypair');
    },
  });
  assert(
    invalidKeypairRecord.status === 'last_live_fee_payer_preflight_unavailable'
      && invalidKeypairRecord.reason === 'keypair_secret_key_invalid',
    'invalid_keypair_not_reported_without_rpc',
  );

  // The production wrapper starts this helper in the background.  Keeping the
  // `&` in the exact invocation guards the route lease from an RPC timeout.
  const root = dirname(fileURLToPath(import.meta.url));
  const runner = await readFile(join(root, 'run-notarb-last-target-live.sh'), 'utf8');
  assert(
    /last-live-fee-payer-preflight\.mjs" "\$CONFIG" >>"\$OUT_LOG" 2>>"\$ERR_LOG" &/.test(runner),
    'fee_payer_preflight_not_backgrounded',
  );

  console.log(JSON.stringify({ status: 'last_live_fee_payer_preflight_test_passed' }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
