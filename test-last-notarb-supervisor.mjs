#!/usr/bin/env node
// Offline lifecycle test.  It uses a local fake child, never NotArb or a
// network endpoint, and proves start -> stay-running -> quiet-stop -> restart.

import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const ROOT = resolve(process.cwd());
const SUPERVISOR = resolve(ROOT, 'last-notarb-supervisor.mjs');
const ASSERT = resolve(ROOT, 'assert-last-dryrun.mjs');
const directory = await mkdtemp(join(tmpdir(), 'last-notarb-supervisor-'));
const groups = [['PoolA111111111111111111111111111111111111111', 'PoolB111111111111111111111111111111111111111']];
const routeEvidenceFingerprint = 'fixture-route-evidence';
const execFileAsync = promisify(execFile);

async function writeJson(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function writeActivity(signature, generation = 1) {
  const observedAt = new Date().toISOString();
  await Promise.all([
    writeJson(join(directory, '.last-grpc-state.json'), {
      schemaVersion: 4,
      lastRouteSignature: signature,
      lastRouteSlot: '1',
      lastRouteObservedAt: observedAt,
      lastRouteFingerprint: routeEvidenceFingerprint,
    }),
    writeJson(join(directory, 'last-target-status.json'), {
      schemaVersion: 1,
      status: 'active',
      reason: 'unchanged',
      generation,
      activity: { signature, slot: '1', observedAt, routeEvidenceFingerprint },
    }),
    writeJson(join(directory, 'last-target-markets.json'), {
      update_timestamp: Date.now(),
      groups,
    }),
  ]);
}

async function waitUntil(predicate, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`timeout:${message}`);
}

async function startCount() {
  try {
    const text = await readFile(join(directory, 'fake-child-events.log'), 'utf8');
    return text.split(/\r?\n/).filter((line) => line === 'started').length;
  } catch {
    return 0;
  }
}

async function supervisorPhase() {
  try {
    return JSON.parse(await readFile(join(directory, '.last-notarb-supervisor-state.json'), 'utf8')).phase;
  } catch {
    return null;
  }
}

async function fixtureLog(name) {
  try {
    return (await readFile(join(directory, name), 'utf8')).trim();
  } catch {
    return '';
  }
}

async function pause(milliseconds) {
  await new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function stopSupervisor(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolveClose) => child.once('close', resolveClose));
  try {
    await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } catch {
    // The child can exit naturally between the phase check and taskkill.
  }
  await Promise.race([closed, pause(5_000)]);
}

async function removeFixtureDirectory() {
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      lastError = error;
      await pause(250);
    }
  }
  throw lastError;
}

let supervisor;
let supervisorStdout = '';
let supervisorStderr = '';
try {
  await writeFile(join(directory, 'notarb-last-grpc-dryrun.toml'), `
[transaction_executor]
threads = 0

[[lookup_tables_file]]
enabled = true
path = "last-target-lookup-tables.txt"

[[markets_file]]
enabled = true
path = "last-target-markets.json"

[wsol_unwrapper]
enabled = false

[notarb_markets]
enabled = false
dry_run = true

[[swap]]
enabled = false
`.trimStart(), 'utf8');
  await writeFile(join(directory, 'fake-child.mjs'), `
import { appendFile } from 'node:fs/promises';
const path = process.argv[2];
await appendFile(path, 'started\\n');
setInterval(() => undefined, 1000);
`, 'utf8');
  await writeFile(join(directory, 'run-fake.cmd'), `@echo off\r\necho %~1>"%~dp0runner-config.log"\r\necho %~2>"%~dp0runner-supervisor.log"\r\nnode.exe "%~dp0fake-child.mjs" "%~dp0fake-child-events.log" 1>>"%~dp0fake-child.stdout.log" 2>>"%~dp0fake-child.stderr.log"\r\n`, 'utf8');
  await writeJson(join(directory, 'last-target-route.json'), {
    source: { watchedAddress: 'LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9', signature: 'fixture-route-source' },
    automation: { generation: 1, routeEvidenceFingerprint },
    candidateDexPrograms: [{ programId: 'fixture-dex', label: 'Fixture DEX' }],
    unsupportedCandidateDexPrograms: [],
    rejectedLookupTables: [],
    selectedGroups: groups,
    targets: [{ mint: 'TargetMint11111111111111111111111111111111111' }],
  });
  await writeActivity('activity-before-start');
  await writeJson(join(directory, 'last-target-status.json'), { schemaVersion: 1, status: 'held', reason: 'fixture_initial_hold' });

  supervisor = spawn(process.execPath, [
    SUPERVISOR,
    `--root=${directory}`,
    `--assert=${ASSERT}`,
    `--runner=${join(directory, 'run-fake.cmd')}`,
    '--poll-ms=100',
    '--idle-seconds=5',
    '--max-markets-age-seconds=5',
  ], { cwd: directory, windowsHide: true, stdio: 'pipe' });
  supervisor.stdout.on('data', (chunk) => { supervisorStdout += chunk; });
  supervisor.stderr.on('data', (chunk) => { supervisorStderr += chunk; });

  await pause(500);
  if (await startCount() !== 0) throw new Error('started_while_initial_status_was_held');
  await writeActivity('activity-one');
  await waitUntil(async () => (await startCount()) === 1, 'first_fake_child_start');
  if (await fixtureLog('runner-config.log') !== join(directory, 'notarb-last-grpc-dryrun.toml')) throw new Error('runner_received_different_config_than_supervisor_validated');
  if (await fixtureLog('runner-supervisor.log') !== '--managed-by-last-supervisor') throw new Error('runner_missing_supervisor_lifecycle_marker');
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    await writeActivity(`activity-live-${index}`);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  if (await startCount() !== 1) throw new Error('duplicate_start_during_continuous_activity');

  // The bridge writes route/markets before the new active status.  A short
  // generation mismatch must not tear down the already-running child.
  await writeJson(join(directory, 'last-target-route.json'), {
    source: { watchedAddress: 'LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9', signature: 'fixture-route-source-two' },
    automation: { generation: 2, routeEvidenceFingerprint },
    candidateDexPrograms: [{ programId: 'fixture-dex', label: 'Fixture DEX' }],
    unsupportedCandidateDexPrograms: [],
    rejectedLookupTables: [],
    selectedGroups: groups,
    targets: [{ mint: 'TargetMint11111111111111111111111111111111111' }],
  });
  await pause(500);
  if (await supervisorPhase() !== 'running' || await startCount() !== 1) throw new Error('stopped_during_generation_publish_window');
  await writeActivity('activity-generation-two', 2);
  await pause(500);
  if (await startCount() !== 1) throw new Error('duplicate_start_after_generation_rotation');

  await waitUntil(async () => (await supervisorPhase()) === 'stopped', 'quiet_child_stop', 9_000);
  await writeActivity('activity-after-quiet', 2);
  await waitUntil(async () => (await startCount()) === 2, 'second_fake_child_start');

  await writeJson(join(directory, 'last-target-status.json'), { schemaVersion: 1, status: 'held', reason: 'fixture_stop' });
  await waitUntil(async () => (await supervisorPhase()) === 'stopped', 'held_child_stop');
  if (supervisorStderr.trim()) throw new Error(`unexpected_supervisor_stderr:${supervisorStderr.trim()}`);
  console.log(JSON.stringify({ status: 'last_notarb_supervisor_test_passed' }));
} catch (error) {
  console.error(JSON.stringify({
    status: 'last_notarb_supervisor_test_failed',
    error: String(error.message ?? error),
    supervisorStdout: supervisorStdout.trim(),
    supervisorStderr: supervisorStderr.trim(),
    fakeChildStdout: await fixtureLog('fake-child.stdout.log'),
    fakeChildStderr: await fixtureLog('fake-child.stderr.log'),
  }));
  throw error;
} finally {
  await stopSupervisor(supervisor);
  await removeFixtureDirectory();
}
