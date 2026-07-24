import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { emptyLock } from '../src/lockfile.js'
import { applyMarker, planInjections, stripMarker } from '../src/plan/tier-inject.js'
import { loadRegistry } from '../src/registry.js'
import { resolve } from '../src/resolve.js'

const HOST = ['import x from "x"', '', '// >>> stacky:auth', '// <<< stacky:auth', '', 'export const y = 1'].join('\n')

describe('applyMarker', () => {
  it('fills an empty region', () => {
    const out = applyMarker(HOST, 'stacky:auth', 'const a = 1')
    expect(out).toContain('// >>> stacky:auth\nconst a = 1\n// <<< stacky:auth')
  })

  it('replaces existing region content rather than appending', () => {
    const once = applyMarker(HOST, 'stacky:auth', 'const a = 1')
    const twice = applyMarker(once, 'stacky:auth', 'const a = 2')
    expect(twice).toContain('const a = 2')
    expect(twice).not.toContain('const a = 1')
    expect(twice.match(/>>> stacky:auth/g)).toHaveLength(1)
  })

  it('leaves content outside the region untouched', () => {
    const out = applyMarker(HOST, 'stacky:auth', 'const a = 1')
    expect(out).toContain('import x from "x"')
    expect(out).toContain('export const y = 1')
  })

  it('throws when the marker is absent from the host', () => {
    expect(() => applyMarker('no markers here', 'stacky:auth', 'x')).toThrow(/marker "stacky:auth" not found/)
  })

  it('does not cross-match a marker that is a prefix of a different marker', () => {
    const host = ['// >>> stacky:auth2', '// <<< stacky:auth2'].join('\n')
    expect(() => applyMarker(host, 'stacky:auth', 'x')).toThrow(/marker "stacky:auth" not found/)
  })

  it('fills only the targeted marker when a prefix-sharing marker also exists', () => {
    const both = ['// >>> stacky:auth', '// <<< stacky:auth', '', '// >>> stacky:auth2', '// <<< stacky:auth2'].join(
      '\n',
    )
    const filledA = applyMarker(both, 'stacky:auth', 'A')
    expect(filledA).toContain('// >>> stacky:auth\nA\n// <<< stacky:auth')
    expect(filledA).toContain('// >>> stacky:auth2\n// <<< stacky:auth2')

    const filledB = applyMarker(both, 'stacky:auth2', 'B')
    expect(filledB).toContain('// >>> stacky:auth2\nB\n// <<< stacky:auth2')
    expect(filledB).toContain('// >>> stacky:auth\n// <<< stacky:auth')
  })
})

describe('stripMarker', () => {
  it('empties the region but keeps the delimiters', () => {
    const filled = applyMarker(HOST, 'stacky:auth', 'const a = 1')
    const stripped = stripMarker(filled, 'stacky:auth')
    expect(stripped).not.toContain('const a = 1')
    expect(stripped).toContain('// >>> stacky:auth')
    expect(stripped).toContain('// <<< stacky:auth')
  })
})

const injFixture = fileURLToPath(new URL('./fixtures/inject-points', import.meta.url))

describe('planInjections — point resolution', () => {
  it('resolves a point-based inject to the selected publisher target and marker', async () => {
    const reg = await loadRegistry(injFixture)
    const r = resolve({ bricks: { consumer: {}, 'host-a': {} }, overrides: {} }, reg)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    const dir = await mkdtemp(join(tmpdir(), 'stacky-inj-'))
    const ops = await planInjections(r.graph, { projectDir: dir, lock: emptyLock(), overrides: {} })
    const inj = ops.find((o) => o.kind === 'inject')!
    expect(inj).toMatchObject({ kind: 'inject', path: 'app/host-a.ts', marker: 'stacky:seam' })
    expect((inj as { contents: string }).contents).toContain('export const injected = true')
  })

  it('aggregates two contributors to the same marker into a single joined op', async () => {
    const reg = await loadRegistry(injFixture)
    const r = resolve({ bricks: { 'host-a': {}, consumer: {}, consumer2: {} }, overrides: {} }, reg)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    const dir = await mkdtemp(join(tmpdir(), 'stacky-inj-'))
    const ops = await planInjections(r.graph, { projectDir: dir, lock: emptyLock(), overrides: {} })
    const hostAOps = ops.filter((o) => o.kind === 'inject' && o.path === 'app/host-a.ts')
    expect(hostAOps).toHaveLength(1)
    const inj = hostAOps[0] as { contents: string }
    expect(inj.contents).toContain('export const injected = true')
    expect(inj.contents).toContain('export const injected2 = true')
    expect(inj.contents).toBe('export const injected = true\nexport const injected2 = true')
  })
})
