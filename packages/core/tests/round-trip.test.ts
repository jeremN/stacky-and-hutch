import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, loadRegistry, plan, readLock, readManifest, resolve, writeManifest } from '../src/index.js'
import { snapshotTree } from './helpers/tree.js'
import type { Manifest } from '../src/types.js'

const bricksDir = fileURLToPath(new URL('../../../bricks', import.meta.url))

/** Converge a project directory onto a manifest. */
async function converge(dir: string, manifest: Manifest) {
  const registry = await loadRegistry(bricksDir)
  await writeManifest(dir, manifest)
  const r = resolve(manifest, registry)
  if (!r.ok) throw new Error(`resolve failed: ${JSON.stringify(r.errors)}`)
  const lock = await readLock(dir)
  const ops = await plan(r.graph, { projectDir: dir, lock, overrides: manifest.overrides })
  await apply(ops, dir, r.graph)
}

const BASE: Manifest = { bricks: { sveltekit: {} }, overrides: {} }

describe('round trip', () => {
  for (const brick of ['caddy', 'postgres']) {
    it(`add ${brick} then remove ${brick} restores the tree byte for byte`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `stacky-rt-${brick}-`))

      await converge(dir, structuredClone(BASE))
      const before = await snapshotTree(dir)

      await converge(dir, { bricks: { ...BASE.bricks, [brick]: {} }, overrides: {} })
      const during = await snapshotTree(dir)
      expect(Object.keys(during).length).toBeGreaterThan(Object.keys(before).length)

      await converge(dir, structuredClone(BASE))
      const after = await snapshotTree(dir)

      expect(after).toEqual(before)
    })
  }

  it('applying the same manifest twice changes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-rt-idem-'))
    const full: Manifest = { bricks: { sveltekit: {}, caddy: {}, postgres: {} }, overrides: {} }
    await converge(dir, structuredClone(full))
    const first = await snapshotTree(dir)
    await converge(dir, structuredClone(full))
    expect(await snapshotTree(dir)).toEqual(first)
  })

  it('a removed brick leaves no orphan files behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-rt-orphan-'))
    await converge(dir, { bricks: { sveltekit: {}, postgres: {} }, overrides: {} })
    await converge(dir, structuredClone(BASE))
    const paths = Object.keys(await snapshotTree(dir))
    expect(paths.filter((p) => p.startsWith('db/'))).toEqual([])
    const manifest = await readManifest(dir)
    expect(manifest.bricks).not.toHaveProperty('postgres')
  })
})

describe('golden files', () => {
  it('the full stack produces the committed compose file byte for byte', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-golden-'))
    await converge(dir, { bricks: { sveltekit: {}, caddy: {}, postgres: {} }, overrides: {} })
    const compose = await readFile(join(dir, 'ops/compose.yml'), 'utf8')
    await expect(compose).toMatchFileSnapshot('./golden/full-stack.compose.yml')
  })

  it('the full stack produces the committed env example byte for byte', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-golden-'))
    await converge(dir, { bricks: { sveltekit: {}, caddy: {}, postgres: {} }, overrides: {} })
    const env = await readFile(join(dir, 'config/.env.example'), 'utf8')
    await expect(env).toMatchFileSnapshot('./golden/full-stack.env.example')
  })
})
