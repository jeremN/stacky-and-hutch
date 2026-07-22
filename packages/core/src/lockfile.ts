import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LockEntry, Lockfile } from './types.js'

export function hashContents(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

export function emptyLock(): Lockfile {
  return { version: 1, bricks: {}, files: [] }
}

export async function readLock(projectDir: string): Promise<Lockfile> {
  try {
    return JSON.parse(await readFile(join(projectDir, 'stack.lock'), 'utf8')) as Lockfile
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyLock()
    throw err
  }
}

export async function writeLock(projectDir: string, lock: Lockfile): Promise<void> {
  const sorted: Lockfile = { ...lock, files: [...lock.files].sort((a, b) => a.path.localeCompare(b.path)) }
  await writeFile(join(projectDir, 'stack.lock'), `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
}

export async function fileState(
  projectDir: string,
  entry: LockEntry,
): Promise<'clean' | 'modified' | 'missing'> {
  let actual: string
  try {
    actual = await readFile(join(projectDir, entry.path), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw err
  }
  return hashContents(actual) === entry.hash ? 'clean' : 'modified'
}
