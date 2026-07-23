import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, emptyLock, hasConflicts, loadRegistry, plan, readLock, resolve } from '../src/index.js'
import type { Graph } from '../src/types.js'

const fixture = fileURLToPath(new URL('./fixtures/registry-basic', import.meta.url))
let graph: Graph

beforeAll(async () => {
  const reg = await loadRegistry(fixture)
  const r = resolve({ bricks: { alpha: {} }, overrides: {} }, reg)
  if (!r.ok) throw new Error('fixture must resolve')
  graph = r.graph
})

describe('plan + apply', () => {
  it('writes every planned file and records it in the lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-apply-'))
    const ops = await plan(graph, { projectDir: dir, lock: emptyLock(), overrides: {} })
    const lock = await apply(ops, dir, graph)

    expect(await readFile(join(dir, 'app/a.txt'), 'utf8')).toBe('alpha\n')
    expect(await readFile(join(dir, 'ops/compose.yml'), 'utf8')).toContain('alpha:')
    expect(lock.files.map((f) => f.path).sort()).toEqual(['app/a.txt', 'ops/compose.yml'])
    expect(lock.bricks).toHaveProperty('alpha')
    expect(await readLock(dir)).toEqual(lock)
  })

  it('is idempotent — a second apply plans no changes to file contents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-apply-'))
    const first = await plan(graph, { projectDir: dir, lock: emptyLock(), overrides: {} })
    const lock = await apply(first, dir, graph)
    const before = await readFile(join(dir, 'ops/compose.yml'), 'utf8')

    const second = await plan(graph, { projectDir: dir, lock, overrides: {} })
    expect(hasConflicts(second)).toBe(false)
    await apply(second, dir, graph)
    expect(await readFile(join(dir, 'ops/compose.yml'), 'utf8')).toBe(before)
  })

  it('refuses to apply a plan containing a conflict', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-apply-'))
    const ops = [{ kind: 'conflict' as const, path: 'app/a.txt', reason: 'user-modified' as const }]
    expect(hasConflicts(ops)).toBe(true)
    await expect(apply(ops, dir, graph)).rejects.toThrow(/conflict/)
  })

  it('writes a .stacky-new sidecar so a conflict can be diffed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-apply-'))
    const ops = [
      { kind: 'conflict' as const, path: 'app/a.txt', reason: 'user-modified' as const, contents: 'theirs\n' },
    ]
    await expect(apply(ops, dir, graph)).rejects.toThrow(/stacky-new/)
    expect(await readFile(join(dir, 'app/a.txt.stacky-new'), 'utf8')).toBe('theirs\n')
  })
})

describe('real registry: a file that is both brick-owned and an inject host', () => {
  const bricksDir = fileURLToPath(new URL('../../../bricks', import.meta.url))

  it('is not flagged as drifted on the very next plan', async () => {
    const reg = await loadRegistry(bricksDir)
    const r = resolve({ bricks: { sveltekit: {}, postgres: {} }, overrides: {} }, reg)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))

    const dir = await mkdtemp(join(tmpdir(), 'stacky-apply-real-'))
    const first = await plan(r.graph, { projectDir: dir, lock: emptyLock(), overrides: {} })
    const lock = await apply(first, dir, r.graph)

    // sveltekit creates app/src/hooks.server.ts; postgres injects into it. If the lock
    // hash for that brick-owned entry were recorded from the pre-injection contents
    // (rather than the final on-disk bytes), this second plan would see drift and
    // report a 'conflict' for it instead of the routine re-render every still-wanted
    // brick file gets (an 'overwrite' op is normal here — it's what a clean, wanted,
    // locked brick file always plans as; only 'conflict' signals the bug).
    const second = await plan(r.graph, { projectDir: dir, lock, overrides: {} })
    expect(hasConflicts(second)).toBe(false)
    const hostOps = second.filter((op) => op.path === 'app/src/hooks.server.ts')
    expect(hostOps.some((op) => op.kind === 'conflict')).toBe(false)
  })

  it('removing the host-owning brick and the injecting brick together does not throw', async () => {
    const reg = await loadRegistry(bricksDir)
    const r = resolve({ bricks: { sveltekit: {}, postgres: {} }, overrides: {} }, reg)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))

    const dir = await mkdtemp(join(tmpdir(), 'stacky-apply-real-'))
    const first = await plan(r.graph, { projectDir: dir, lock: emptyLock(), overrides: {} })
    const lock = await apply(first, dir, r.graph)

    // Converging to an empty manifest puts both a `delete` for the inject host and an
    // orphan-strip `inject` for the same path in one batch. The delete runs first, so
    // the strip must tolerate a host that is already gone rather than crash reading it.
    const empty = resolve({ bricks: {}, overrides: {} }, reg)
    if (!empty.ok) throw new Error(JSON.stringify(empty.errors))
    const removal = await plan(empty.graph, { projectDir: dir, lock, overrides: {} })
    const finalLock = await apply(removal, dir, empty.graph)
    expect(finalLock.files).toEqual([])
  })
})
