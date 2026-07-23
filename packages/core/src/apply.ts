import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hashContents, writeLock } from './lockfile.js'
import { applyMarker } from './plan/tier-inject.js'
import type { FileOp, Graph, LockEntry, Lockfile } from './types.js'

async function put(projectDir: string, rel: string, contents: string): Promise<void> {
  const abs = join(projectDir, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, contents, 'utf8')
}

export async function apply(ops: FileOp[], projectDir: string, graph: Graph): Promise<Lockfile> {
  const conflicts = ops.filter((op) => op.kind === 'conflict')
  if (conflicts.length > 0) {
    // Never clobber, but never leave you stuck either: dump what we would have written
    // next to your version so you can diff it, then refuse to proceed.
    const sidecars: string[] = []
    for (const c of conflicts) {
      if (c.contents === undefined) continue
      await put(projectDir, `${c.path}.stacky-new`, c.contents)
      sidecars.push(`${c.path}.stacky-new`)
    }
    const paths = conflicts.map((c) => c.path).join(', ')
    const hint = sidecars.length > 0 ? ` Wrote ${sidecars.join(', ')} for comparison.` : ''
    throw new Error(
      `refusing to apply: ${conflicts.length} conflict(s) — you have edited ${paths}.${hint}`,
    )
  }

  const files: LockEntry[] = []

  for (const op of ops) {
    switch (op.kind) {
      case 'create':
      case 'overwrite':
        await put(projectDir, op.path, op.contents)
        files.push({ path: op.path, owner: op.owner, tier: op.tier, hash: hashContents(op.contents) })
        break
      case 'compose':
        await put(projectDir, op.path, op.contents)
        files.push({ path: op.path, owner: '@composed', tier: 'composed', hash: hashContents(op.contents) })
        break
      case 'inject': {
        const abs = join(projectDir, op.path)
        const host = await readFile(abs, 'utf8')
        const next = applyMarker(host, op.marker, op.contents)
        await writeFile(abs, next, 'utf8')
        if (op.contents.length > 0) {
          files.push({
            path: `${op.path}#${op.marker}`, owner: op.owner, tier: 'inject', hash: hashContents(op.contents),
          })
        }
        break
      }
      case 'delete':
        await rm(join(projectDir, op.path), { force: true })
        break
      case 'conflict':
        break
    }
  }

  const bricks = Object.fromEntries(graph.bricks.map((b) => [b.brick.name, b.params]))
  const lock: Lockfile = { version: 1, bricks, files }
  await writeLock(projectDir, lock)
  return lock
}
