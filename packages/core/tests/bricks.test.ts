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
    expect([...reg.bricks.keys()].sort())
      .toEqual(['caddy', 'compose', 'drizzle', 'iconify', 'postgres', 'sqlite', 'sveltekit', 'tailwind', 'tanstack-start', 'vite'])
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

describe('tanstack-start stack', () => {
  it('resolves vite + tanstack-start + postgres and injects server-init into server.ts', async () => {
    const reg = await loadRegistry(bricksDir)
    const r = resolve({ bricks: { 'tanstack-start': {}, postgres: {} }, overrides: {} }, reg)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const dir = await mkdtemp(join(tmpdir(), 'stacky-tanstack-'))
    await apply(await plan(r.graph, { projectDir: dir, lock: emptyLock(), overrides: {} }), dir, r.graph)

    const server = await readFile(join(dir, 'app/src/server.ts'), 'utf8')
    expect(server).toContain('new Pool')
    expect(server).toContain('>>> stacky:server-init')

    const pkg = JSON.parse(await readFile(join(dir, 'app/package.json'), 'utf8'))
    expect(pkg.dependencies).toHaveProperty('@tanstack/react-start')
    expect(pkg.dependencies).toHaveProperty('pg')
  })
})

describe('drizzle + postgres multi-contributor server-init', () => {
  it('lands both the pool and the drizzle client in one marker region', async () => {
    const reg = await loadRegistry(bricksDir)
    const r = resolve({ bricks: { sveltekit: {}, postgres: {}, drizzle: {} }, overrides: {} }, reg)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const dir = await mkdtemp(join(tmpdir(), 'stacky-drizzle-'))
    await apply(await plan(r.graph, { projectDir: dir, lock: emptyLock(), overrides: {} }), dir, r.graph)

    const hooks = await readFile(join(dir, 'app/src/hooks.server.ts'), 'utf8')
    expect(hooks).toContain('new Pool')
    expect(hooks).toContain('drizzle(process.env.DATABASE_URL')
    // both bodies live inside the single server-init region
    const region = hooks.split('>>> stacky:server-init')[1].split('<<< stacky:server-init')[0]
    expect(region).toContain('new Pool')
    expect(region).toContain('drizzle(')

    const pkg = JSON.parse(await readFile(join(dir, 'app/package.json'), 'utf8'))
    expect(pkg.scripts).toHaveProperty('db:migrate')
  })
})
