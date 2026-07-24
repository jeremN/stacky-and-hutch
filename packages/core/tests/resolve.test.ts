import { beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { loadRegistry } from '../src/registry.js'
import { resolve } from '../src/resolve.js'
import type { Manifest, Registry } from '../src/types.js'

const fixture = fileURLToPath(new URL('./fixtures/resolve', import.meta.url))
let reg: Registry

beforeAll(async () => {
  reg = await loadRegistry(fixture)
})

function manifest(bricks: Manifest['bricks']): Manifest {
  return { bricks, overrides: {} }
}

describe('resolve', () => {
  it('auto-adds the sole provider of a required capability', async () => {
    const regOne = await loadRegistry(fileURLToPath(new URL('./fixtures/resolve-single', import.meta.url)))
    const r = resolve(manifest({ 'web-a': { title: 'x' } }), regOne)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const names = r.graph.bricks.map((b) => b.brick.name)
    expect(names).toContain('pg')
    expect(r.graph.bricks.find((b) => b.brick.name === 'pg')!.inferred).toBe(true)
  })

  it('reports ambiguity when two bricks provide the capability', () => {
    const r = resolve(manifest({ 'web-a': { title: 'x' } }), reg)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContainEqual({
      kind: 'ambiguous',
      capability: 'sql-db',
      candidates: ['mysql', 'pg'],
      requiredBy: 'web-a',
    })
  })

  it('reports unsatisfiable when nothing provides the capability', () => {
    const r = resolve(manifest({ 'needs-cache': {} }), reg)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContainEqual({ kind: 'unsatisfiable', capability: 'kv-store', requiredBy: 'needs-cache' })
  })

  it('reports a slot conflict for two bricks in one single-occupancy slot', () => {
    const r = resolve(manifest({ 'web-a': { title: 'x' }, 'web-b': {} }), reg)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContainEqual({ kind: 'slot-conflict', slot: 'web', bricks: ['web-a', 'web-b'] })
  })

  it('reports unknown bricks with suggestions', () => {
    const r = resolve(manifest({ 'web-c': {} }), reg)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ kind: 'unknown-brick', name: 'web-c' })
    expect((r.errors[0] as { suggestions: string[] }).suggestions).toContain('web-a')
  })

  it('reports a missing required param', () => {
    const r = resolve(manifest({ 'web-a': {}, pg: {} }), reg)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContainEqual({
      kind: 'missing-param',
      brick: 'web-a',
      param: 'title',
      schema: { type: 'string', prompt: 'Site title' },
    })
  })

  it('sorts bricks by slot order then name', () => {
    const r = resolve(manifest({ pg: {}, 'web-b': {} }), reg)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.graph.bricks.map((b) => b.brick.name)).toEqual(['web-b', 'pg'])
  })
})

describe('resolve — injection points', () => {
  const injFixture = fileURLToPath(new URL('./fixtures/inject-points', import.meta.url))

  it('reports ambiguous-injection-point when a consumed point has two publishers', async () => {
    const reg = await loadRegistry(injFixture)
    const r = resolve({ bricks: { consumer: {} }, overrides: {} }, reg)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContainEqual({
      kind: 'ambiguous-injection-point', point: 'seam', candidates: ['host-a', 'host-b'], requiredBy: 'consumer',
    })
  })

  it('resolves cleanly once a publisher is selected', async () => {
    const reg = await loadRegistry(injFixture)
    const r = resolve({ bricks: { consumer: {}, 'host-a': {} }, overrides: {} }, reg)
    expect(r.ok).toBe(true)
  })

  it('reports unsatisfiable-injection-point when nobody publishes the point', async () => {
    const reg = await loadRegistry(injFixture)
    const r = resolve({ bricks: { orphan: {} }, overrides: {} }, reg)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContainEqual({
      kind: 'unsatisfiable-injection-point', point: 'nonexistent', requiredBy: 'orphan',
    })
  })
})
