import { describe, expect, it } from 'vitest'
import { access, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, loadRegistry, plan, readLock, resolve, writeManifest } from '../src/index.js'
import type { Manifest } from '../src/types.js'

const fixture = fileURLToPath(new URL('./fixtures/when-gate', import.meta.url))

async function converge(dir: string, manifest: Manifest) {
  const registry = await loadRegistry(fixture)
  await writeManifest(dir, manifest)
  const r = resolve(manifest, registry)
  if (!r.ok) throw new Error(`resolve failed: ${JSON.stringify(r.errors)}`)
  const lock = await readLock(dir)
  const ops = await plan(r.graph, { projectDir: dir, lock, overrides: manifest.overrides })
  await apply(ops, dir, r.graph)
}

describe('when-gated contributions', () => {
  it('emits the variant whose gating capability is present (feature-on)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-gate-on-'))
    await converge(dir, { bricks: { base: {}, on: {} }, overrides: {} })
    expect(await readFile(join(dir, 'conf.txt'), 'utf8')).toBe('mode=on')
    expect(await readFile(join(dir, 'app.ts'), 'utf8')).toContain("export const mode = 'on'")
  })

  it('emits the other variant when the other capability is present (feature-off)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-gate-off-'))
    await converge(dir, { bricks: { base: {}, off: {} }, overrides: {} })
    expect(await readFile(join(dir, 'conf.txt'), 'utf8')).toBe('mode=off')
    expect(await readFile(join(dir, 'app.ts'), 'utf8')).toContain("export const mode = 'off'")
  })

  it('emits neither gated contribution when no gating capability is present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-gate-none-'))
    await converge(dir, { bricks: { base: {} }, overrides: {} })
    await expect(access(join(dir, 'conf.txt'))).rejects.toThrow()
    const app = await readFile(join(dir, 'app.ts'), 'utf8')
    expect(app).not.toContain('export const mode')
  })
})
