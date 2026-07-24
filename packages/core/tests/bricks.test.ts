import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, emptyLock, loadRegistry, plan, resolve } from '../src/index.js'

const bricksDir = fileURLToPath(new URL('../../../bricks', import.meta.url))

describe('real registry', () => {
  it('loads all bricks', async () => {
    const reg = await loadRegistry(bricksDir)
    expect([...reg.bricks.keys()].sort()).toEqual(['caddy', 'compose', 'postgres', 'sveltekit', 'vite'])
  })

  it('resolves the full stack, inferring vite and compose', async () => {
    const reg = await loadRegistry(bricksDir)
    const r = resolve({ bricks: { sveltekit: {}, caddy: {}, postgres: {} }, overrides: {} }, reg)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.graph.bricks.map((b) => b.brick.name)).toEqual(['compose', 'vite', 'sveltekit', 'caddy', 'postgres'])
  })

  it('applies the full stack to a temp dir', async () => {
    const reg = await loadRegistry(bricksDir)
    const r = resolve({ bricks: { sveltekit: {}, caddy: {}, postgres: {} }, overrides: {} }, reg)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    const dir = await mkdtemp(join(tmpdir(), 'stacky-real-'))
    const ops = await plan(r.graph, { projectDir: dir, lock: emptyLock(), overrides: {} })
    await apply(ops, dir, r.graph)

    const compose = await readFile(join(dir, 'ops/compose.yml'), 'utf8')
    expect(compose).toContain('caddy:')
    expect(compose).toContain('postgres:')
    expect(compose).toContain('web:')

    const hooks = await readFile(join(dir, 'app/src/hooks.server.ts'), 'utf8')
    expect(hooks).toContain('DATABASE_URL')
    expect(hooks).toContain('>>> stacky:server-init')
    expect(hooks).toContain('new Pool')
    expect(hooks).toContain('process.env.DATABASE_URL')
  })
})
