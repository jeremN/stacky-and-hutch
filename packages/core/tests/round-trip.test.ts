import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, loadRegistry, plan, readLock, readManifest, resolve, writeManifest } from '../src/index.js'
import { snapshotTree } from './helpers/tree.js'
import type { Manifest } from '../src/types.js'

const bricksDir = fileURLToPath(new URL('../../../bricks', import.meta.url))

async function converge(dir: string, manifest: Manifest) {
  const registry = await loadRegistry(bricksDir)
  await writeManifest(dir, manifest)
  const r = resolve(manifest, registry)
  if (!r.ok) throw new Error(`resolve failed: ${JSON.stringify(r.errors)}`)
  const lock = await readLock(dir)
  const ops = await plan(r.graph, { projectDir: dir, lock, overrides: manifest.overrides })
  await apply(ops, dir, r.graph)
}

const FRAMEWORKS = ['sveltekit', 'tanstack-start'] as const
// The foundation is fixed per stack and never round-tripped.
const FOUNDATION = new Set<string>(['vite', 'compose', ...FRAMEWORKS])

describe('round trip — both framework stacks', () => {
  for (const fw of FRAMEWORKS) {
    const base: Manifest = { bricks: { vite: {}, [fw]: {} }, overrides: {} }

    // Derive removable bricks from the registry: everything not in the foundation.
    it(`[${fw}] every removable brick round-trips byte for byte`, async () => {
      const registry = await loadRegistry(bricksDir)
      const removable = [...registry.bricks.values()]
        .filter((b) => !FOUNDATION.has(b.name) && b.slot !== 'web')
        .map((b) => b.name)
        .sort()
      expect(removable).toEqual(['caddy', 'drizzle', 'postgres', 'sqlite'])

      for (const brick of removable) {
        // A brick that needs a database engine can't be added alone (two engines => ambiguous),
        // so give it a fixed engine in its foundation.
        const needsEngine = registry.bricks.get(brick)!.requires['sql-db'] != null
        const brickBase = needsEngine ? { ...base.bricks, postgres: {} } : { ...base.bricks }

        const dir = await mkdtemp(join(tmpdir(), `stacky-rt-${fw}-${brick}-`))
        await converge(dir, { bricks: structuredClone(brickBase), overrides: {} })
        const before = await snapshotTree(dir)

        await converge(dir, { bricks: { ...brickBase, [brick]: {} }, overrides: {} })
        const during = await snapshotTree(dir)
        expect(Object.keys(during).length).toBeGreaterThan(Object.keys(before).length)

        await converge(dir, { bricks: structuredClone(brickBase), overrides: {} })
        expect(await snapshotTree(dir)).toEqual(before)
      }
    })
  }

  for (const fw of FRAMEWORKS) {
    it(`[${fw}] swapping the db engine round-trips byte for byte`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `stacky-swap-${fw}-`))
      const pgStack: Manifest = { bricks: { vite: {}, [fw]: {}, postgres: {}, drizzle: {} }, overrides: {} }
      const sqliteStack: Manifest = { bricks: { vite: {}, [fw]: {}, sqlite: {}, drizzle: {} }, overrides: {} }

      await converge(dir, structuredClone(pgStack))
      const pgSnap = await snapshotTree(dir)

      await converge(dir, structuredClone(sqliteStack))
      const initFile = fw === 'sveltekit' ? 'app/src/hooks.server.ts' : 'app/src/server.ts'
      const init = await readFile(join(dir, initFile), 'utf8')
      expect(init).toContain('drizzle-orm/better-sqlite3')
      expect(init).not.toContain('node-postgres')
      expect(await readFile(join(dir, 'app/drizzle.config.ts'), 'utf8')).toContain("dialect: 'sqlite'")
      expect(await readFile(join(dir, 'ops/compose.yml'), 'utf8')).not.toContain('postgres')

      await converge(dir, structuredClone(pgStack))
      expect(await snapshotTree(dir)).toEqual(pgSnap)
    })
  }

  it('adding drizzle with two engines and none chosen is ambiguous', async () => {
    const registry = await loadRegistry(bricksDir)
    const r = resolve({ bricks: { vite: {}, sveltekit: {}, drizzle: {} }, overrides: {} }, registry)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected an ambiguous resolution')
    const ambiguous = r.errors.find((e) => e.kind === 'ambiguous')
    expect(ambiguous).toMatchObject({ kind: 'ambiguous', capability: 'sql-db', candidates: ['postgres', 'sqlite'] })
  })

  it('[sveltekit] removing drizzle leaves postgres server-init intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-rt-multi-'))
    const withPg: Manifest = { bricks: { vite: {}, sveltekit: {}, postgres: {} }, overrides: {} }
    await converge(dir, structuredClone(withPg))
    const before = await snapshotTree(dir)

    await converge(dir, { bricks: { ...withPg.bricks, drizzle: {} }, overrides: {} })
    const hooks = await readFile(join(dir, 'app/src/hooks.server.ts'), 'utf8')
    expect(hooks).toContain('new Pool')
    expect(hooks).toContain('drizzle(')

    await converge(dir, structuredClone(withPg))
    expect(await snapshotTree(dir)).toEqual(before)
    const after = await readFile(join(dir, 'app/src/hooks.server.ts'), 'utf8')
    expect(after).toContain('new Pool')
    expect(after).not.toContain('drizzle(')
  })

  it('applying the same manifest twice changes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-rt-idem-'))
    const full: Manifest = { bricks: { vite: {}, sveltekit: {}, caddy: {}, postgres: {}, drizzle: {} }, overrides: {} }
    await converge(dir, structuredClone(full))
    const first = await snapshotTree(dir)
    await converge(dir, structuredClone(full))
    expect(await snapshotTree(dir)).toEqual(first)
  })

  it('a removed brick leaves no orphan files behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-rt-orphan-'))
    await converge(dir, { bricks: { vite: {}, sveltekit: {}, postgres: {} }, overrides: {} })
    await converge(dir, { bricks: { vite: {}, sveltekit: {} }, overrides: {} })
    const paths = Object.keys(await snapshotTree(dir))
    expect(paths.filter((p) => p.startsWith('db/'))).toEqual([])
    const manifest = await readManifest(dir)
    expect(manifest.bricks).not.toHaveProperty('postgres')
  })
})

describe('golden files — per framework', () => {
  for (const fw of FRAMEWORKS) {
    const short = fw === 'sveltekit' ? 'sveltekit' : 'tanstack'
    it(`[${fw}] full stack matches the committed goldens`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `stacky-golden-${short}-`))
      await converge(dir, { bricks: { vite: {}, [fw]: {}, caddy: {}, postgres: {}, drizzle: {} }, overrides: {} })
      await expect(await readFile(join(dir, 'ops/compose.yml'), 'utf8'))
        .toMatchFileSnapshot(`./golden/${short}.compose.yml`)
      await expect(await readFile(join(dir, 'app/package.json'), 'utf8'))
        .toMatchFileSnapshot(`./golden/${short}.package.json`)
      await expect(await readFile(join(dir, 'app/vite.config.ts'), 'utf8'))
        .toMatchFileSnapshot(`./golden/${short}.vite.config.ts`)
    })
  }

  it('[sveltekit] sqlite stack matches the committed goldens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-golden-sqlite-'))
    await converge(dir, { bricks: { vite: {}, sveltekit: {}, sqlite: {}, drizzle: {} }, overrides: {} })
    await expect(await readFile(join(dir, 'app/drizzle.config.ts'), 'utf8'))
      .toMatchFileSnapshot('./golden/sqlite.drizzle.config.ts')
    await expect(await readFile(join(dir, 'app/src/hooks.server.ts'), 'utf8'))
      .toMatchFileSnapshot('./golden/sqlite.hooks.server.ts')
    await expect(await readFile(join(dir, 'db/schema.ts'), 'utf8'))
      .toMatchFileSnapshot('./golden/sqlite.schema.ts')
  })
})
