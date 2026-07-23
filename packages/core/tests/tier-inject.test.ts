import { describe, expect, it } from 'vitest'
import { applyMarker, stripMarker } from '../src/plan/tier-inject.js'

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
