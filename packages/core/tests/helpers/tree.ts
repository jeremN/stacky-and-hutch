import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { hashContents } from '../../src/lockfile.js'

/** path -> content hash, for every file under dir except .git. */
export async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}

  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const abs = join(current, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else out[relative(dir, abs)] = hashContents(await readFile(abs, 'utf8'))
    }
  }

  await walk(dir)
  return out
}
