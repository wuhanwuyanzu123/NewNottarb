import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomically } from './last-atomic-write.mjs';

const directory = await mkdtemp(join(tmpdir(), 'last-atomic-write-'));
try {
  const release = join(directory, 'release');
  const runtime = join(directory, 'runtime-state');
  const target = join(runtime, 'last-grpc-activity.json');
  const releasePath = join(release, 'last-grpc-activity.json');
  await mkdir(runtime, { recursive: true });
  await mkdir(release, { recursive: true });
  await writeFile(target, '{"old":true}\n', 'utf8');
  let symlinkAvailable = true;
  try {
    await symlink(target, releasePath);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      symlinkAvailable = false;
      console.log(JSON.stringify({ status: 'last_atomic_write_test_skipped', reason: error.code }));
    } else {
      throw error;
    }
  }
  if (symlinkAvailable) {
    await writeJsonAtomically(releasePath, { activity: 'setLoadedAccounts' });
    if (!(await lstat(releasePath)).isSymbolicLink()) {
      throw new Error('atomic_write_replaced_release_symlink');
    }
    const stored = JSON.parse(await readFile(target, 'utf8'));
    if (stored.activity !== 'setLoadedAccounts') throw new Error('atomic_write_did_not_update_runtime_target');
    console.log(JSON.stringify({ status: 'last_atomic_write_test_passed' }));
  }
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
