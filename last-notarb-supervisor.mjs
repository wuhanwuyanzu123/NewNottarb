#!/usr/bin/env node
/**
 * Lifecycle supervisor for a target-only LAST NotArb configuration.
 *
 * The observer and route bridge stay resident.  This process starts the
 * target-only child only after the bridge has published a fresh, validated
 * LAST route, and stops only the child tree it started when that lease ends.
 * It reads local evidence/state files and starts the caller-selected wrapper.
 * It never changes the bot configuration; the configured runner determines
 * whether the child is a dry-run or a live sender.
 */

import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import process from 'node:process';

const WATCHED_ADDRESS = 'LASTvjDWkbXM1RwUCiniHqGLSEH5xJinDRs56wNPQr9';
const execFileAsync = promisify(execFile);
const IS_WINDOWS = process.platform === 'win32';
const args = parseArgs(process.argv.slice(2));
const ROOT = resolve(args.get('root') ?? process.cwd());
const STATUS_PATH = resolve(ROOT, args.get('status') ?? 'last-target-status.json');
const OBSERVER_STATE_PATH = resolve(ROOT, args.get('observer-state') ?? '.last-grpc-state.json');
const ROUTE_PATH = resolve(ROOT, args.get('route') ?? 'last-target-route.json');
const MARKETS_PATH = resolve(ROOT, args.get('markets') ?? 'last-target-markets.json');
const CONFIG_PATH = resolve(ROOT, args.get('config') ?? 'notarb-last-grpc-dryrun.toml');
const ASSERT_PATH = resolve(ROOT, args.get('assert') ?? 'assert-last-dryrun.mjs');
const RUNNER_PATH = resolve(ROOT, args.get('runner') ?? 'run-notarb-last-target-dryrun.cmd');
const STATE_PATH = resolve(ROOT, args.get('state') ?? '.last-notarb-supervisor-state.json');
const POLL_MS = boundedNumber(args.get('poll-ms'), 1_000, 250, 30_000);
const IDLE_MS = boundedNumber(args.get('idle-seconds'), 30, 5, 600) * 1_000;
// The bridge writes the heartbeat from WSL while this supervisor runs on
// Windows. Leave room for the normal five-second bridge interval and a small
// cross-runtime clock offset; a held/stale route still stops the child
// immediately through the status gate below.
const MAX_MARKETS_AGE_MS = boundedNumber(args.get('max-markets-age-seconds'), 20, 2, 120) * 1_000;
const TRANSITION_GRACE_MS = boundedNumber(args.get('transition-grace-ms'), 7_000, 500, 15_000);
const POSIX_STOP_GRACE_MS = boundedNumber(args.get('posix-stop-grace-ms'), 2_000, 250, 15_000);
const ONCE = args.has('once');

let stopping = false;
let ticking = false;
let ownedBot = null;
// A delivery signature/generation may start at most one child. Retain this
// across a temporary held/stale publication so a bridge heartbeat flap cannot
// re-launch the same live activity after its child has been stopped.
let attemptedActivationKey = null;
let lastAnnouncement = null;
let transientIneligibleSince = null;
let stateWriteSerial = Promise.resolve();

function parseArgs(argv) {
  const output = new Map();
  for (const argument of argv) {
    if (!argument.startsWith('--')) continue;
    const value = argument.slice(2);
    const separator = value.indexOf('=');
    output.set(separator < 0 ? value : value.slice(0, separator), separator < 0 ? 'true' : value.slice(separator + 1));
  }
  return output;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function announce(status, details = {}, error = false) {
  const record = { observedAt: nowIso(), status, ...details };
  const identity = JSON.stringify({ status, ...details });
  if (identity === lastAnnouncement) return;
  lastAnnouncement = identity;
  (error ? console.error : console.log)(JSON.stringify(record));
}

async function readJson(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`read_failed:${path}:${error?.code ?? error}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid_json:${path}:${error?.message ?? error}`);
  }
}

async function readJsonIfPresent(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (String(error.message).includes(':ENOENT')) return null;
    throw error;
  }
}

async function writeJsonAtomically(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  // Windows can briefly hold the destination open while a local watcher or
  // antivirus scans the just-written state file. Keep the atomic replacement
  // semantics and retry only those transient sharing violations; a later
  // serial state transition remains ordered behind this one.
  let delayMs = 20;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      const retryable = ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code);
      if (!retryable || attempt === 5) throw error;
      await pause(delayMs);
      delayMs = Math.min(delayMs * 2, 160);
    }
  }
}

function timestampAge(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Date.now() - parsed;
}

function freshTimestamp(value, maximumAgeMs) {
  const ageMs = timestampAge(value);
  return ageMs !== null && ageMs >= -5_000 && ageMs <= maximumAgeMs;
}

async function pause(milliseconds) {
  await new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function canonicalGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const normalized = [];
  for (const group of groups) {
    if (!Array.isArray(group) || group.length < 2 || group.some((address) => typeof address !== 'string' || !address)) return null;
    const uniqueAddresses = [...new Set(group)].sort();
    if (uniqueAddresses.length < 2) return null;
    normalized.push(uniqueAddresses);
  }
  return normalized.sort((left, right) => left.join(',').localeCompare(right.join(',')));
}

function equalGroups(left, right) {
  return JSON.stringify(canonicalGroups(left)) === JSON.stringify(canonicalGroups(right));
}

function eligibleFailure(reason, details = {}) {
  return { eligible: false, reason, ...details };
}

async function currentEligibility() {
  let status;
  // A published non-active status is sufficient to keep the child stopped.
  // In particular, the bridge deliberately publishes `held`/
  // `no_route_evidence` before it has (or needs) route, observer, and markets
  // evidence.  Do not turn that normal quiet state into an
  // `evidence_unreadable` error by reading files which are irrelevant until an
  // active lease is announced.
  let observer;
  let route;
  let markets;
  let statusFile;
  let marketsFile;
  try {
    status = await readJson(STATUS_PATH);
  } catch (error) {
    return eligibleFailure('evidence_unreadable', { error: String(error.message ?? error) });
  }

  if (status?.status !== 'active') {
    return eligibleFailure('route_not_active', {
      routeStatus: status?.status ?? null,
      routeStatusReason: status?.reason ?? null,
    });
  }

  // Active leases must still have the full, coherent evidence set before the
  // supervisor may start or retain a child.
  try {
    [observer, route, markets, statusFile, marketsFile] = await Promise.all([
      readJson(OBSERVER_STATE_PATH),
      readJson(ROUTE_PATH),
      readJson(MARKETS_PATH),
      stat(STATUS_PATH),
      stat(MARKETS_PATH),
    ]);
  } catch (error) {
    return eligibleFailure('evidence_unreadable', { error: String(error.message ?? error) });
  }

  const activity = status?.activity;
  if (!activity?.signature || !activity?.observedAt) return eligibleFailure('missing_validated_activity');
  if (!observer?.lastRouteSignature || !observer?.lastRouteObservedAt) return eligibleFailure('missing_route_activity');
  if (activity.signature !== observer.lastRouteSignature || activity.observedAt !== observer.lastRouteObservedAt) {
    return eligibleFailure('bridge_has_not_validated_current_activity', {
      activitySignature: activity.signature,
      observerSignature: observer.lastRouteSignature,
    });
  }
  // `observedAt` is produced inside WSL while this supervisor uses the
  // Windows clock. The local status-file mtime is the host-clock receipt of
  // the bridge's active lease, so it is the reliable freshness source here.
  if (!freshTimestamp(statusFile.mtimeMs, IDLE_MS)) {
    return eligibleFailure('route_activity_stale', {
      activityObservedAt: activity.observedAt,
      statusMtimeMs: statusFile.mtimeMs,
      idleMs: IDLE_MS,
    });
  }
  if (!activity.routeEvidenceFingerprint || !observer.lastRouteFingerprint) {
    return eligibleFailure('missing_route_evidence_fingerprint');
  }
  // A no-profit check with an equivalent route may be intentionally omitted
  // from JSONL.  The observer/bridge fingerprint proves that the persisted
  // pool snapshot and the fresh activity describe that same route.
  if (activity.routeEvidenceFingerprint !== observer.lastRouteFingerprint
    || route?.automation?.routeEvidenceFingerprint !== activity.routeEvidenceFingerprint) {
    return eligibleFailure('route_evidence_fingerprint_mismatch');
  }

  const generation = Number(status?.generation);
  if (!Number.isInteger(generation) || generation < 1 || Number(route?.automation?.generation) !== generation) {
    return eligibleFailure('route_generation_mismatch', {
      statusGeneration: status?.generation ?? null,
      routeGeneration: route?.automation?.generation ?? null,
    });
  }
  if (route?.source?.watchedAddress !== WATCHED_ADDRESS) return eligibleFailure('unexpected_route_watch_address');
  if (!route?.source?.signature || !(route.targets ?? []).length || !(route.candidateDexPrograms ?? []).length) {
    return eligibleFailure('route_missing_target_or_dex');
  }
  if ((route.unsupportedCandidateDexPrograms ?? []).length || (route.rejectedLookupTables ?? []).length) {
    return eligibleFailure('route_has_unusable_dependencies');
  }
  if (!canonicalGroups(route.selectedGroups) || !equalGroups(route.selectedGroups, markets?.groups)) {
    return eligibleFailure('markets_do_not_match_validated_route');
  }
  // Keep `update_timestamp` for NotArb's markets schema, but use the local
  // file mtime for the supervisor lease to avoid WSL/Windows clock skew.
  if (!freshTimestamp(marketsFile.mtimeMs, MAX_MARKETS_AGE_MS)) {
    return eligibleFailure('markets_heartbeat_stale', {
      marketsUpdateTimestamp: markets?.update_timestamp ?? null,
      marketsMtimeMs: marketsFile.mtimeMs,
      maxMarketsAgeMs: MAX_MARKETS_AGE_MS,
    });
  }

  return {
    eligible: true,
    activationKey: `${generation}:${activity.signature}`,
    generation,
    activity,
    targetMints: (route.targets ?? []).map((target) => target.mint).filter(Boolean),
    groupCount: markets.groups.length,
  };
}

function saveSupervisorState(phase, details = {}) {
  const payload = {
    schemaVersion: 1,
    updatedAt: nowIso(),
    phase,
    configPath: CONFIG_PATH,
    runnerPath: RUNNER_PATH,
    ...details,
  };
  const write = stateWriteSerial.then(() => writeJsonAtomically(STATE_PATH, payload));
  // Keep later state transitions available even if one write fails.
  stateWriteSerial = write.catch(() => undefined);
  return write;
}

async function assertConfig() {
  const child = spawn(process.execPath, [ASSERT_PATH, CONFIG_PATH], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', resolveExit);
  });
  if (code !== 0) throw new Error(`config_invalid:${(stderr || stdout).trim() || `exit_${code}`}`);
  return stdout.trim();
}

function powerShellQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function windowsProcessForPid(pid) {
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}'`,
    "if ($null -ne $process) { [PSCustomObject]@{ ProcessId = $process.ProcessId; Name = $process.Name; CommandLine = $process.CommandLine; CreationDate = $process.CreationDate } | ConvertTo-Json -Compress }",
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  const text = stdout.trim();
  return text ? JSON.parse(text) : null;
}

async function posixProcessForPid(pid) {
  try {
    const procRoot = `/proc/${Number(pid)}`;
    const [statText, commandBytes] = await Promise.all([
      readFile(`${procRoot}/stat`, 'utf8'),
      readFile(`${procRoot}/cmdline`, 'utf8'),
    ]);
    const closingParenthesis = statText.lastIndexOf(')');
    const openingParenthesis = statText.indexOf('(');
    if (openingParenthesis < 0 || closingParenthesis <= openingParenthesis) return null;
    // `/proc/<pid>/stat` fields after `comm` start at field 3.  `starttime`
    // is field 22 and `pgrp` is field 5; the former gives a PID-reuse-safe
    // identity without relying on wall-clock parsing.
    const fields = statText.slice(closingParenthesis + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    const processGroupId = Number(fields[2]);
    if (!startTicks || !Number.isInteger(processGroupId) || processGroupId < 1) return null;
    return {
      ProcessId: Number(pid),
      Name: statText.slice(openingParenthesis + 1, closingParenthesis),
      CommandLine: commandBytes.replace(/\0/g, ' ').trim(),
      CreationDate: startTicks,
      ProcessGroupId: processGroupId,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function processForPid(pid) {
  return IS_WINDOWS ? windowsProcessForPid(pid) : posixProcessForPid(pid);
}

function isExpectedRunnerProcess(processInfo, expectedCreationDate = null) {
  if (!IS_WINDOWS) {
    return Boolean(
      processInfo?.CommandLine?.includes(RUNNER_PATH)
      && (!expectedCreationDate || String(processInfo?.CreationDate) === String(expectedCreationDate)),
    );
  }
  return Boolean(
    processInfo?.Name?.toLowerCase() === 'cmd.exe'
    && processInfo?.CommandLine?.toLowerCase().includes(RUNNER_PATH.toLowerCase())
    && (!expectedCreationDate || processInfo?.CreationDate === expectedCreationDate),
  );
}

async function captureOwnedRoot(rootPid) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const processInfo = await processForPid(rootPid);
    if (isExpectedRunnerProcess(processInfo) && processInfo.CreationDate) return processInfo;
    await pause(50);
  }
  throw new Error(`owned_runner_identity_unavailable:${rootPid}`);
}

async function ownedRootStatus(record) {
  const processInfo = await processForPid(record.rootPid);
  if (!processInfo) return 'missing';
  return isExpectedRunnerProcess(processInfo, record.rootCreationDate) ? 'alive' : 'reused';
}

async function findExternalTargetBots() {
  if (!IS_WINDOWS) {
    const entries = await readdir('/proc', { withFileTypes: true });
    const candidates = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => processForPid(Number(entry.name)).catch(() => null)));
    return candidates
      .filter((processInfo) => {
        const commandLine = processInfo?.CommandLine ?? '';
        return processInfo?.ProcessId !== process.pid
          && commandLine.includes(CONFIG_PATH)
          && (commandLine.includes(RUNNER_PATH) || commandLine.includes('onchain-bot'));
      })
      .map((processInfo) => processInfo.ProcessId);
  }
  const target = powerShellQuoted(CONFIG_PATH);
  const script = [
    `$target = ${target}`,
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'java.exe' -and $_.CommandLine -like ('*' + $target + '*') } | Select-Object -ExpandProperty ProcessId",
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  return stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => /^\d+$/.test(value))
    .map(Number);
}

async function ownedDescendants(rootPid) {
  if (!IS_WINDOWS) return [];
  const script = [
    `$root = ${Number(rootPid)}`,
    "$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, CreationDate)",
    '$pending = @($root)',
    '$descendants = @()',
    'while ($pending.Count -gt 0) {',
    '  $parent = $pending[0]',
    '  if ($pending.Count -eq 1) { $pending = @() } else { $pending = @($pending[1..($pending.Count - 1)]) }',
    '  $children = @($all | Where-Object { $_.ParentProcessId -eq $parent })',
    '  $descendants += $children',
    '  $pending += @($children | Select-Object -ExpandProperty ProcessId)',
    '}',
    "$descendants | Where-Object { $_.Name -ne 'conhost.exe' } | Select-Object ProcessId, Name, CommandLine, CreationDate | ConvertTo-Json -Compress",
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function sameProcessIdentity(processInfo, expected) {
  return Boolean(
    processInfo
    && expected
    && Number(processInfo.ProcessId) === Number(expected.ProcessId)
    && processInfo.CreationDate === expected.CreationDate
    && processInfo.Name?.toLowerCase() === expected.Name?.toLowerCase(),
  );
}

async function terminateRecordedDescendants(descendants) {
  if (!IS_WINDOWS) return;
  const survivors = [];
  for (const descendant of descendants) {
    const processInfo = await processForPid(descendant.ProcessId).catch(() => null);
    if (!sameProcessIdentity(processInfo, descendant)) continue;
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(descendant.ProcessId), '/T', '/F'], {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
    } catch {
      // Verify below: a process may have exited between the probe and taskkill.
    }
    const remaining = await processForPid(descendant.ProcessId).catch(() => null);
    if (sameProcessIdentity(remaining, descendant)) survivors.push(descendant.ProcessId);
  }
  if (survivors.length) throw new Error(`owned_descendants_survived_stop:${survivors.join(',')}`);
}

function recordProcessGroupId(record) {
  const value = Number(record?.processGroupId ?? record?.rootPid);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function signalPosixProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function posixProcessGroupMembers(processGroupId) {
  const entries = await readdir('/proc', { withFileTypes: true });
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(async (entry) => processForPid(Number(entry.name)).catch(() => null)));
  return candidates.filter((processInfo) => Number(processInfo?.ProcessGroupId) === processGroupId);
}

async function terminatePosixProcessGroup(record, allowMissingRoot = false) {
  const processGroupId = recordProcessGroupId(record);
  if (!processGroupId) throw new Error(`owned_process_group_invalid:${record?.rootPid ?? 'unknown'}`);
  const root = await processForPid(record.rootPid).catch(() => null);
  if (root && !isExpectedRunnerProcess(root, record.rootCreationDate)) {
    throw new Error(`owned_runner_pid_reused:${record.rootPid}`);
  }
  if (!root && allowMissingRoot) {
    const members = await posixProcessGroupMembers(processGroupId);
    if (members.length && !members.some((member) => (member.CommandLine ?? '').includes(CONFIG_PATH))) {
      throw new Error(`owned_process_group_identity_unavailable:${processGroupId}`);
    }
  }
  if (!signalPosixProcessGroup(processGroupId, 'SIGTERM')) return;
  const deadline = Date.now() + POSIX_STOP_GRACE_MS;
  while (Date.now() < deadline) {
    await pause(100);
    if (!signalPosixProcessGroup(processGroupId, 0)) return;
  }
  if (!signalPosixProcessGroup(processGroupId, 'SIGKILL')) return;
  await pause(100);
  if (signalPosixProcessGroup(processGroupId, 0)) {
    throw new Error(`owned_process_group_survived_stop:${processGroupId}`);
  }
}

async function recoverOwnedChild() {
  const saved = await readJsonIfPresent(STATE_PATH);
  if (saved?.phase !== 'running' || saved.configPath !== CONFIG_PATH || saved.runnerPath !== RUNNER_PATH
    || !Number.isInteger(saved.rootPid) || !saved.rootCreationDate) return;
  try {
    const processInfo = await processForPid(saved.rootPid);
    if (!isExpectedRunnerProcess(processInfo, saved.rootCreationDate)) return;
    ownedBot = {
      rootPid: saved.rootPid,
      rootCreationDate: saved.rootCreationDate,
      processGroupId: IS_WINDOWS ? null : recordProcessGroupId(saved),
      activationKey: saved.activationKey ?? null,
      generation: saved.generation ?? null,
      startedAt: saved.startedAt ?? null,
      child: null,
      recovered: true,
      intentionalStop: false,
    };
    announce('notarb_child_recovered', { rootPid: saved.rootPid, activationKey: ownedBot.activationKey });
  } catch (error) {
    announce('owned_child_recovery_error', { error: String(error.message ?? error) }, true);
  }
}

function attachChildExit(child, record) {
  child.once('exit', (code, signal) => {
    if (ownedBot?.rootPid !== record.rootPid) return;
    const intentionalStop = ownedBot.intentionalStop;
    ownedBot = null;
    void saveSupervisorState(intentionalStop ? 'stopped' : 'exited', {
      rootPid: record.rootPid,
      rootCreationDate: record.rootCreationDate,
      processGroupId: record.processGroupId ?? null,
      activationKey: record.activationKey,
      generation: record.generation,
      exitCode: code,
      signal,
    }).catch((error) => announce('supervisor_state_write_error', { error: String(error.message ?? error) }, true));
    if (!intentionalStop) announce('notarb_child_exited', { rootPid: record.rootPid, code, signal }, true);
  });
}

async function startOwnedBot(eligibility) {
  const existing = await findExternalTargetBots();
  if (existing.length) {
    announce('notarb_external_process_conflict', { pids: existing });
    return false;
  }
  const assertResult = await assertConfig();
  // Windows uses cmd.exe so its batch wrapper owns the complete tree. POSIX
  // uses a dedicated process group led by bash, allowing the same precise
  // child-only stop semantics without touching observer or bridge processes.
  const child = IS_WINDOWS
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', RUNNER_PATH, CONFIG_PATH, '--managed-by-last-supervisor'], {
      cwd: ROOT,
      windowsHide: true,
      stdio: 'ignore',
    })
    : spawn(process.env.LAST_RUNNER_SHELL ?? '/bin/bash', [RUNNER_PATH, CONFIG_PATH, '--managed-by-last-supervisor'], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
    });
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', rejectSpawn);
  });
  const rootProcess = await captureOwnedRoot(child.pid);
  const record = {
    rootPid: child.pid,
    rootCreationDate: rootProcess.CreationDate,
    processGroupId: IS_WINDOWS ? null : rootProcess.ProcessGroupId,
    activationKey: eligibility.activationKey,
    generation: eligibility.generation,
    startedAt: nowIso(),
    child,
    recovered: false,
    intentionalStop: false,
  };
  ownedBot = record;
  attachChildExit(child, record);
  await saveSupervisorState('running', {
    rootPid: record.rootPid,
    rootCreationDate: record.rootCreationDate,
    processGroupId: record.processGroupId ?? null,
    activationKey: record.activationKey,
    generation: record.generation,
    startedAt: record.startedAt,
  });
  announce('notarb_child_started', {
    rootPid: record.rootPid,
    activationKey: record.activationKey,
    generation: record.generation,
    groupCount: eligibility.groupCount,
    targetMints: eligibility.targetMints,
    preflight: assertResult,
  });
  return true;
}

async function stopOwnedBot(reason) {
  const current = ownedBot;
  if (!current) return false;
  current.intentionalStop = true;
  if (IS_WINDOWS) {
    const descendants = await ownedDescendants(current.rootPid);
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(current.rootPid), '/T', '/F'], {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
    } catch (error) {
      // A just-exited child makes taskkill return non-zero; verify its root PID
      // before reporting a stop failure.
      const remaining = await processForPid(current.rootPid).catch(() => null);
      if (isExpectedRunnerProcess(remaining, current.rootCreationDate)) throw error;
    }
    await terminateRecordedDescendants(descendants);
  } else {
    await terminatePosixProcessGroup(current);
  }
  if (ownedBot?.rootPid === current.rootPid) ownedBot = null;
  await saveSupervisorState('stopped', {
    rootPid: current.rootPid,
    rootCreationDate: current.rootCreationDate,
    processGroupId: current.processGroupId ?? null,
    activationKey: current.activationKey,
    generation: current.generation,
    stoppedAt: nowIso(),
    reason,
  });
  announce('notarb_child_stopped', { rootPid: current.rootPid, reason });
  return true;
}

function isTransientPublicationReason(reason) {
  return new Set([
    'evidence_unreadable',
    'bridge_has_not_validated_current_activity',
    'route_evidence_fingerprint_mismatch',
    'route_generation_mismatch',
    'markets_do_not_match_validated_route',
  ]).has(reason);
}

async function reconcile() {
  if (ticking || stopping) return;
  ticking = true;
  try {
    const eligibility = await currentEligibility();
    if (!eligibility.eligible) {
      if (ownedBot && isTransientPublicationReason(eligibility.reason)) {
        transientIneligibleSince ??= Date.now();
        if (Date.now() - transientIneligibleSince < TRANSITION_GRACE_MS) {
          announce('notarb_waiting_for_coherent_generation', {
            reason: eligibility.reason,
            graceMs: TRANSITION_GRACE_MS,
          });
          return;
        }
      }
      transientIneligibleSince = null;
      await stopOwnedBot(eligibility.reason);
      announce('notarb_waiting', { reason: eligibility.reason });
      return;
    }

    transientIneligibleSince = null;
    const rootStatus = ownedBot ? await ownedRootStatus(ownedBot) : 'missing';
    if (ownedBot && rootStatus !== 'alive') {
      const exited = ownedBot;
      if (rootStatus === 'missing') {
        if (IS_WINDOWS) {
          // Child processes retain their former ParentProcessId after a broken
          // wrapper exits. They are still the recorded tree while that PID is
          // absent, so terminate and verify them before forgetting ownership.
          await terminateRecordedDescendants(await ownedDescendants(exited.rootPid));
        } else {
          // The POSIX runner is a dedicated process-group leader.  A broken
          // shell can leave its Java child in that group, so stop only that
          // validated group before forgetting ownership.
          await terminatePosixProcessGroup(exited, true);
        }
      }
      ownedBot = null;
      await saveSupervisorState('exited', {
        rootPid: exited.rootPid,
        rootCreationDate: exited.rootCreationDate,
        processGroupId: exited.processGroupId ?? null,
        activationKey: exited.activationKey,
        generation: exited.generation,
        reason: rootStatus === 'missing' ? 'owned_runner_no_longer_exists' : 'owned_runner_pid_reused',
      });
      announce('notarb_child_exited', {
        rootPid: exited.rootPid,
        reason: rootStatus === 'missing' ? 'owned_runner_no_longer_exists' : 'owned_runner_pid_reused',
      }, true);
    }
    if (ownedBot) {
      if (ownedBot.activationKey !== eligibility.activationKey) {
        ownedBot.activationKey = eligibility.activationKey;
        ownedBot.generation = eligibility.generation;
        // A single managed child may follow several fresh LAST signatures in
        // place.  Retain the latest key as attempted too, so if that child is
        // later stopped by a quiet lease, replaying the final signature cannot
        // start a duplicate child.
        attemptedActivationKey = eligibility.activationKey;
        await saveSupervisorState('running', {
          rootPid: ownedBot.rootPid,
          rootCreationDate: ownedBot.rootCreationDate,
          processGroupId: ownedBot.processGroupId ?? null,
          activationKey: ownedBot.activationKey,
          generation: ownedBot.generation,
          startedAt: ownedBot.startedAt,
          recovered: ownedBot.recovered,
        });
        announce('notarb_route_updated_in_place', { rootPid: ownedBot.rootPid, activationKey: ownedBot.activationKey });
      } else {
        announce('notarb_running', { rootPid: ownedBot.rootPid, activationKey: ownedBot.activationKey });
      }
      return;
    }

    if (attemptedActivationKey === eligibility.activationKey) {
      announce('notarb_restart_suppressed_for_activity', { activationKey: eligibility.activationKey });
      return;
    }
    try {
      const started = await startOwnedBot(eligibility);
      if (started) attemptedActivationKey = eligibility.activationKey;
    } catch (error) {
      attemptedActivationKey = eligibility.activationKey;
      await saveSupervisorState('start_failed', {
        activationKey: eligibility.activationKey,
        generation: eligibility.generation,
        error: String(error.message ?? error),
      });
      announce('notarb_start_failed', { activationKey: eligibility.activationKey, error: String(error.message ?? error) }, true);
    }
  } catch (error) {
    transientIneligibleSince = null;
    announce('supervisor_reconcile_error', { error: String(error.message ?? error) }, true);
    try {
      await stopOwnedBot('supervisor_reconcile_error');
    } catch (stopError) {
      announce('notarb_stop_failed', { error: String(stopError.message ?? stopError) }, true);
    }
  } finally {
    ticking = false;
  }
}

async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  try {
    await stopOwnedBot(`supervisor_${reason}`);
  } catch (error) {
    announce('notarb_stop_failed', { error: String(error.message ?? error) }, true);
  }
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

await recoverOwnedChild();
await reconcile();
if (!ONCE) {
  setInterval(() => {
    void reconcile().catch((error) => announce('supervisor_reconcile_error', { error: String(error.message ?? error) }, true));
  }, POLL_MS);
}
