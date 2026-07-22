import { describe, expect, it } from 'vitest'
import { deepMerge, mergeLines, mergeYaml } from '../src/merge.js'

describe('deepMerge', () => {
  it('merges nested objects rather than replacing them', () => {
    expect(deepMerge({ a: { x: 1 } }, { a: { y: 2 } })).toEqual({ a: { x: 1, y: 2 } })
  })

  it('lets the right-hand side win on scalars', () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 })
  })

  it('replaces arrays wholesale rather than concatenating', () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] })
  })
})

describe('mergeYaml', () => {
  it('merges service maps from several fragments', () => {
    const out = mergeYaml([
      'services:\n  web:\n    image: node\n',
      'services:\n  db:\n    image: postgres\n',
    ])
    expect(out).toContain('web:')
    expect(out).toContain('db:')
  })

  it('is byte-stable for the same input order', () => {
    const frags = ['services:\n  b:\n    image: b\n', 'services:\n  a:\n    image: a\n']
    expect(mergeYaml(frags)).toBe(mergeYaml(frags))
  })
})

describe('mergeLines', () => {
  it('groups lines under a per-brick comment header', () => {
    const out = mergeLines([
      { brick: 'pg', text: 'DATABASE_URL=\n' },
      { brick: 'caddy', text: 'DOMAIN=\n' },
    ])
    expect(out).toContain('# pg')
    expect(out).toContain('DATABASE_URL=')
    expect(out).toContain('# caddy')
    expect(out).toContain('DOMAIN=')
  })

  it('drops duplicate keys contributed by two bricks', () => {
    const out = mergeLines([
      { brick: 'pg', text: 'SHARED=1\n' },
      { brick: 'redis', text: 'SHARED=1\n' },
    ])
    expect(out.match(/SHARED=1/g)).toHaveLength(1)
  })
})
