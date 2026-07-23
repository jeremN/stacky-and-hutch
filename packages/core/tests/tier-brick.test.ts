import { beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRegistry } from '../src/registry.js'
import { resolve } from '../src/resolve.js'
import { emptyLock, hashContents } from '../src/lockfile.js'
import { renderTemplate } from '../src/template.js'
import { planBrickFiles } from '../src/plan/tier-brick.js'
import type { Graph, Registry } from '../src/types.js'

const fixture = fileURLToPath(new URL('./fixtures/registry-basic', import.meta.url))
let graph: Graph
let reg: Registry

beforeAll(async () => {
  reg = await loadRegistry(fixture)
  const r = resolve({ bricks: { alpha: {} }, overrides: {} }, reg)
  if (!r.ok) throw new Error(`fixture must resolve: ${JSON.stringify(r.errors)}`)
  graph = r.graph
})

describe('renderTemplate', () => {
  it('interpolates params', () => {
    expect(renderTemplate('port=<%= it.port %>', { port: '5173' })).toBe('port=5173')
  })
})

describe('planBrickFiles', () => {
  it('emits create for a file not yet on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-t1-'))
    const ops = await planBrickFiles(graph, { projectDir: dir, lock: emptyLock(), overrides: {} })
    expect(ops).toEqual([{ kind: 'create', path: 'app/a.txt', contents: 'alpha\n', owner: 'alpha', tier: 'brick' }])
  })

  it('emits overwrite when the file is on disk and unmodified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-t1-'))
    await mkdir(dirname(join(dir, 'app/a.txt')), { recursive: true })
    await writeFile(join(dir, 'app/a.txt'), 'alpha\n')
    const lock = {
      ...emptyLock(),
      files: [{ path: 'app/a.txt', owner: 'alpha', tier: 'brick' as const, hash: hashContents('alpha\n') }],
    }
    const ops = await planBrickFiles(graph, { projectDir: dir, lock, overrides: {} })
    expect(ops[0]).toMatchObject({ kind: 'overwrite', path: 'app/a.txt' })
  })

  it('emits conflict when the user has edited a brick-owned file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-t1-'))
    await mkdir(dirname(join(dir, 'app/a.txt')), { recursive: true })
    await writeFile(join(dir, 'app/a.txt'), 'I changed this\n')
    const lock = {
      ...emptyLock(),
      files: [{ path: 'app/a.txt', owner: 'alpha', tier: 'brick' as const, hash: hashContents('alpha\n') }],
    }
    const ops = await planBrickFiles(graph, { projectDir: dir, lock, overrides: {} })
    expect(ops).toEqual([
      { kind: 'conflict', path: 'app/a.txt', reason: 'user-modified', contents: 'alpha\n' },
    ])
  })

  it('emits delete for a locked file whose brick left the graph', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-t1-'))
    await mkdir(dirname(join(dir, 'ops/old.conf')), { recursive: true })
    await writeFile(join(dir, 'ops/old.conf'), 'old\n')
    const lock = {
      ...emptyLock(),
      files: [{ path: 'ops/old.conf', owner: 'gone', tier: 'brick' as const, hash: hashContents('old\n') }],
    }
    const ops = await planBrickFiles(graph, { projectDir: dir, lock, overrides: {} })
    expect(ops).toContainEqual({ kind: 'delete', path: 'ops/old.conf', owner: 'gone' })
  })
})
