import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyManifest, readManifest, writeManifest } from '../src/manifest.js'

async function tmp() {
  return mkdtemp(join(tmpdir(), 'stacky-manifest-'))
}

describe('manifest', () => {
  it('returns an empty manifest when stack.toml is absent', async () => {
    const dir = await tmp()
    expect(await readManifest(dir)).toEqual({ bricks: {}, overrides: {} })
  })

  it('reads bricks and their params', async () => {
    const dir = await tmp()
    await writeFile(
      join(dir, 'stack.toml'),
      ['[bricks]', 'postgres = { version = "16" }', 'caddy = {}'].join('\n'),
    )
    const m = await readManifest(dir)
    expect(m.bricks).toEqual({ postgres: { version: '16' }, caddy: {} })
  })

  it('reads overrides keyed by target path', async () => {
    const dir = await tmp()
    await writeFile(
      join(dir, 'stack.toml'),
      ['[bricks]', 'postgres = {}', '', '[overrides."ops/compose.yml"]', 'x = "y"'].join('\n'),
    )
    const m = await readManifest(dir)
    expect(m.overrides).toEqual({ 'ops/compose.yml': { x: 'y' } })
  })

  it('round-trips through write and read', async () => {
    const dir = await tmp()
    const m = { bricks: { caddy: { domain: 'example.com' } }, overrides: {} }
    await writeManifest(dir, m)
    expect(await readManifest(dir)).toEqual(m)
  })

  it('writes a banner comment so the file is self-explaining', async () => {
    const dir = await tmp()
    await writeManifest(dir, emptyManifest())
    const text = await readFile(join(dir, 'stack.toml'), 'utf8')
    expect(text.startsWith('# stacky manifest')).toBe(true)
  })
})
