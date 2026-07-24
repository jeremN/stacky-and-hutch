import { describe, expect, it } from 'vitest'
import { exitCodeFor, formatError } from '../src/errors.js'

describe('injection-point errors', () => {
  it('formats ambiguous-injection-point with candidates', () => {
    const msg = formatError({ kind: 'ambiguous-injection-point', point: 'server-init', candidates: ['a', 'b'], requiredBy: 'pg' })
    expect(msg).toContain('server-init')
    expect(msg).toContain('a, b')
  })

  it('treats ambiguous-injection-point as exit 2, unsatisfiable as exit 1', () => {
    expect(exitCodeFor([{ kind: 'ambiguous-injection-point', point: 'x', candidates: ['a', 'b'], requiredBy: 'c' }])).toBe(2)
    expect(exitCodeFor([{ kind: 'unsatisfiable-injection-point', point: 'x', requiredBy: 'c' }])).toBe(1)
  })
})
