import { lstat, mkdir, readlink, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function atomicWriteTarget(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return resolve(dirname(path), await readlink(path));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return path;
}

// Runtime artifacts are exposed to each immutable release through symlinks.
// Rename onto the resolved target, not the release-local link, so the next
// deployment keeps reading and writing the same runtime-state file.
export async function writeJsonAtomically(path, value) {
  const target = await atomicWriteTarget(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}
