import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileState } from '../lockfile.js'
import { renderTemplate } from '../template.js'
import type { FileOp, Graph, Lockfile } from '../types.js'
import { gatePasses, providedCapabilities } from './gate.js'

export interface PlanContext {
  projectDir: string
  lock: Lockfile
  overrides: Record<string, Record<string, unknown>>
}

export async function planBrickFiles(graph: Graph, ctx: PlanContext): Promise<FileOp[]> {
  const ops: FileOp[] = []
  const wanted = new Set<string>()
  const provided = providedCapabilities(graph)

  for (const { brick, params } of graph.bricks) {
    for (const spec of brick.files) {
      if (!gatePasses(spec.when, provided)) continue
      wanted.add(spec.to)
      const raw = await readFile(join(brick.dir, spec.from), 'utf8')
      const contents = spec.from.endsWith('.eta') ? renderTemplate(raw, params) : raw
      const entry = ctx.lock.files.find((f) => f.path === spec.to)

      if (!entry) {
        ops.push({ kind: 'create', path: spec.to, contents, owner: brick.name, tier: 'brick' })
        continue
      }
      const state = await fileState(ctx.projectDir, entry)
      if (state === 'modified') {
        ops.push({ kind: 'conflict', path: spec.to, reason: 'user-modified', contents })
      } else if (state === 'missing') {
        ops.push({ kind: 'create', path: spec.to, contents, owner: brick.name, tier: 'brick' })
      } else {
        ops.push({
          kind: 'overwrite', path: spec.to, contents, owner: brick.name, tier: 'brick', prevHash: entry.hash,
        })
      }
    }
  }

  // Anything the lock claims as brick-owned that no current brick wants is removed.
  for (const entry of ctx.lock.files) {
    if (entry.tier !== 'brick' || wanted.has(entry.path)) continue
    const state = await fileState(ctx.projectDir, entry)
    if (state === 'modified') ops.push({ kind: 'conflict', path: entry.path, reason: 'user-modified' })
    else if (state === 'clean') ops.push({ kind: 'delete', path: entry.path, owner: entry.owner as string })
  }

  return ops
}
