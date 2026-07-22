#!/usr/bin/env node
// Offline lifecycle test.  It uses a local fake child, never NotArb or a
// network endpoint, and proves start -> stay-running -> quiet-stop -> restart.

import { mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const ROOT = resolve(process.cwd());
const IS_WINDOWS = process.platform === 'win32';
const SUPERVISOR = resolve(ROOT, 'last-notarb-supervisor.mjs');
const ASSERT = resolve(ROOT, 'assert-last-dryrun.mjs');
const directory = await mkdtemp(join(tmpdir(), 'last-notarb-supervisor-'));
const groups = [['PoolA111111111111111111111111111111111111111', 'PoolB111111111111111111111111111111111111111']];
const routeEvidenceFingerprint = 'fixture-route-evidence';
const refreshedRouteEvidenceFingerprint = 'fixture-route-evidence-refreshed';
// The production bridge runs in WSL while the supervisor runs on Windows.
// Exercise the observed small clock offset so a five-second heartbeat does
// not make a valid active lease flap.
const bridgeClockSkewMs = 8_000;
const execFileAsync = promisify(execFile);

async function writeJson(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function writeRoute(generation, fingerprint, signature) {
  await writeJson(join(directory, 'last-target-route.json'), {
    source: { watchedAddress: 'LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9', signature },
    automation: { generation, routeEvidenceFingerprint: fingerprint },
    candidateDexPrograms: [{ programId: 'fixture-dex', label: 'Fixture DEX' }],
    unsupportedCandidateDexPrograms: [],
    rejectedLookupTables: [],
    selectedGroups: groups,
    targets: [{ mint: 'TargetMint11111111111111111111111111111111111' }],
  });
}

function activityRecord(signature, generation, fingerprint) {
  const observedAt = new Date().toISOString();
  return { signature, generation, fingerprint, observedAt };
}

async function writeObserverActivity(activity, routeActivity = activity, stale = false) {
  await writeJson(join(directory, '.last-grpc-state.json'), {
    schemaVersion: 4,
    lastSignature: activity.signature,
    lastSlot: '1',
    lastObservedAt: activity.observedAt,
    lastRouteSignature: routeActivity.signature,
    lastRouteSlot: '1',
    lastRouteObservedAt: routeActivity.observedAt,
    lastRouteFingerprint: routeActivity.fingerprint,
    stale,
  });
}

async function writeActiveStatus(activity) {
  await writeJson(join(directory, 'last-target-status.json'), {
    schemaVersion: 1,
    status: 'active',
    reason: 'unchanged',
    generation: activity.generation,
    activity: {
      signature: activity.signature,
      slot: '1',
      observedAt: activity.observedAt,
      routeEvidenceFingerprint: activity.fingerprint,
    },
  });
}

async function writeMarketsHeartbeat(payloadAgeMs = bridgeClockSkewMs) {
  await writeJson(join(directory, 'last-target-markets.json'), {
    update_timestamp: Date.now() - payloadAgeMs,
    groups,
  });
}

async function expireStatusLease() {
  const expired = new Date(Date.now() - 61_000);
  await utimes(join(directory, 'last-target-status.json'), expired, expired);
}

async function writeActivity(signature, generation = 1, fingerprint = routeEvidenceFingerprint) {
  const activity = activityRecord(signature, generation, fingerprint);
  await Promise.all([writeObserverActivity(activity), writeActiveStatus(activity), writeMarketsHeartbeat()]);
  return activity;
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
  if (IS_WINDOWS) {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      // The child can exit naturally between the phase check and taskkill.
    }
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      // The child can exit naturally between the phase check and signal.
    }
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
  const runnerPath = join(directory, IS_WINDOWS ? 'run-fake.cmd' : 'run-fake.sh');
  if (IS_WINDOWS) {
    await writeFile(runnerPath, `@echo off\r\necho %~1>"%~dp0runner-config.log"\r\necho %~2>"%~dp0runner-supervisor.log"\r\nnode.exe "%~dp0fake-child.mjs" "%~dp0fake-child-events.log" 1>>"%~dp0fake-child.stdout.log" 2>>"%~dp0fake-child.stderr.log"\r\n`, 'utf8');
  } else {
    await writeFile(runnerPath, `#!/usr/bin/env bash
set -euo pipefail
RUNNER_DIR="$(cd "$(dirname "$0")" && pwd)"
printf '%s\\n' "$1" >"$RUNNER_DIR/runner-config.log"
printf '%s\\n' "$2" >"$RUNNER_DIR/runner-supervisor.log"
"${process.execPath}" "$RUNNER_DIR/fake-child.mjs" "$RUNNER_DIR/fake-child-events.log" 1>>"$RUNNER_DIR/fake-child.stdout.log" 2>>"$RUNNER_DIR/fake-child.stderr.log"
STATUS=$?
exit "$STATUS"
`, 'utf8');
  }
  // A quiet bridge can publish only its status file; it does not need route,
  // observer, or markets evidence until it has an active route.  Starting the
  // supervisor in that state must report route_not_active rather than an
  // evidence_unreadable error.
  await writeJson(join(directory, 'last-target-status.json'), {
    schemaVersion: 1,
    status: 'no_route_evidence',
    reason: 'fixture_initial_quiet',
  });

  supervisor = spawn(process.execPath, [
    SUPERVISOR,
    `--root=${directory}`,
    `--assert=${ASSERT}`,
    `--runner=${runnerPath}`,
    '--poll-ms=100',
    // A long synthetic lease makes the test independent of slow CI filesystem
    // scheduling. The quiet-stop assertion below expires its status mtime
    // explicitly, exercising the same supervisor gate without a minute wait.
    '--idle-seconds=60',
  ], { cwd: directory, windowsHide: true, stdio: 'pipe' });
  supervisor.stdout.on('data', (chunk) => { supervisorStdout += chunk; });
  supervisor.stderr.on('data', (chunk) => { supervisorStderr += chunk; });

  await waitUntil(() => supervisorStdout.includes('"reason":"route_not_active"'), 'initial_quiet_status_gate');
  if (await startCount() !== 0) throw new Error('started_while_initial_status_was_quiet');
  if (supervisorStdout.includes('evidence_unreadable')) throw new Error('quiet_status_required_missing_evidence');
  // Conversely, an active lease without its supporting evidence must remain
  // ineligible. This preserves the strict active-path validation.
  await writeActiveStatus(activityRecord('activity-missing-evidence', 1, routeEvidenceFingerprint));
  await waitUntil(() => supervisorStdout.includes('"reason":"evidence_unreadable"'), 'active_missing_evidence_gate');
  if (await startCount() !== 0) throw new Error('started_with_active_missing_evidence');
  await writeRoute(1, routeEvidenceFingerprint, 'fixture-route-source');
  const initialRouteActivity = await writeActivity('activity-one');
  await waitUntil(async () => (await startCount()) === 1, 'first_fake_child_start');
  if (await fixtureLog('runner-config.log') !== join(directory, 'notarb-last-grpc-dryrun.toml')) throw new Error('runner_received_different_config_than_supervisor_validated');
  if (await fixtureLog('runner-supervisor.log') !== '--managed-by-last-supervisor') throw new Error('runner_missing_supervisor_lifecycle_marker');
  // The JSON payload timestamp belongs to the markets schema and may be on the
  // WSL clock. A freshly written local file with an intentionally old payload
  // must stay live; the supervisor gates on the host mtime.
  // The bridge renews the active status together with the markets heartbeat.
  // Refresh it here before the cadence gap so this assertion does not depend
  // on time spent in the setup assertions above.
  await writeActiveStatus(initialRouteActivity);
  await writeMarketsHeartbeat(60_000);
  await waitUntil(async () => (await supervisorPhase()) === 'running' && (await startCount()) === 1, 'host_mtime_heartbeat_keeps_running');
  // A five-second bridge cadence plus the modeled eight-second WSL clock skew
  // must remain a live lease under the default 20-second heartbeat tolerance.
  await pause(5_500);
  if (await supervisorPhase() !== 'running' || await startCount() !== 1) throw new Error('stopped_during_skewed_bridge_heartbeat_gap');
  // A confirmed transaction actually signed by LAST can be an unrelated
  // housekeeping instruction such as setLoadedAccounts. It must renew the
  // lease while retaining the route evidence, generation, and one existing
  // child rather than being misclassified as a new route.
  let latestGenericActivity;
  for (let index = 0; index < 3; index += 1) {
    latestGenericActivity = activityRecord(`set-loaded-accounts-${index}`, 1, routeEvidenceFingerprint);
    await writeObserverActivity(latestGenericActivity, initialRouteActivity);
    await writeMarketsHeartbeat();
    await writeActiveStatus(latestGenericActivity);
    await pause(300);
  }
  const genericObserver = JSON.parse(await readFile(join(directory, '.last-grpc-state.json'), 'utf8'));
  if (genericObserver.lastSignature !== latestGenericActivity.signature
    || genericObserver.lastRouteSignature !== initialRouteActivity.signature) {
    throw new Error('generic_last_activity_replaced_validated_route');
  }
  if (await supervisorPhase() !== 'running' || await startCount() !== 1) {
    throw new Error('generic_last_activity_did_not_extend_existing_child');
  }
  // Mirror the Rust unchanged-generation commit sequence: observer evidence
  // changes first, then the route automation fingerprint/markets, then active
  // status. The managed child must stay alive and see the route in place.
  const refreshedActivity = activityRecord('activity-fingerprint-refresh', 1, refreshedRouteEvidenceFingerprint);
  await writeObserverActivity(refreshedActivity);
  await pause(150);
  await writeRoute(1, refreshedRouteEvidenceFingerprint, 'fixture-route-source-refreshed');
  await writeMarketsHeartbeat();
  await writeActiveStatus(refreshedActivity);
  await pause(500);
  if (await supervisorPhase() !== 'running' || await startCount() !== 1) throw new Error('stopped_or_restarted_during_fingerprint_refresh');
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    await writeActivity(`activity-live-${index}`, 1, refreshedRouteEvidenceFingerprint);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  if (await startCount() !== 1) throw new Error('duplicate_start_during_continuous_activity');

  // The bridge writes route/markets before the new active status.  A short
  // generation mismatch must not tear down the already-running child.
  await writeRoute(2, refreshedRouteEvidenceFingerprint, 'fixture-route-source-two');
  await pause(500);
  if (await supervisorPhase() !== 'running' || await startCount() !== 1) throw new Error('stopped_during_generation_publish_window');
  await writeActivity('activity-generation-two', 2, refreshedRouteEvidenceFingerprint);
  await pause(500);
  if (await startCount() !== 1) throw new Error('duplicate_start_after_generation_rotation');

  await expireStatusLease();
  await waitUntil(async () => (await supervisorPhase()) === 'stopped', 'quiet_child_stop');
  // Replaying the exact already-attempted generation/signature must not launch
  // a second child after a transient lease loss. A new LAST signature below is
  // what authorizes the next start.
  await writeActivity('activity-generation-two', 2, refreshedRouteEvidenceFingerprint);
  await pause(500);
  if (await supervisorPhase() !== 'stopped' || await startCount() !== 1) throw new Error('restarted_same_activity_after_quiet');
  const postQuietActivity = await writeActivity('activity-after-quiet', 2, refreshedRouteEvidenceFingerprint);
  await waitUntil(async () => (await startCount()) === 2, 'second_fake_child_start');

  // The bridge writes observer state before it publishes a held status. If it
  // exits in that tiny window, the stale bit alone must stop the owned child;
  // the supervisor must not wait for a stale status-file mtime.
  await writeObserverActivity(postQuietActivity, postQuietActivity, true);
  await waitUntil(async () => (await supervisorPhase()) === 'stopped', 'observer_stale_child_stop');

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
