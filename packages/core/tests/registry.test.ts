import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { loadRegistry } from '../src/registry.js'

const fixture = fileURLToPath(new URL('./fixtures/registry-basic', import.meta.url))

describe('loadRegistry', () => {
  it('loads slots in declaration order', async () => {
    const reg = await loadRegistry(fixture)
    expect(reg.slots.map((s) => s.name)).toEqual(['container', 'web', 'db'])
  })

  it('parses a brick with all sections', async () => {
    const reg = await loadRegistry(fixture)
    const alpha = reg.bricks.get('alpha')
    expect(alpha).toBeDefined()
    expect(alpha!.slot).toBe('web')
    expect(alpha!.requires).toEqual({ 'sql-db': '*' })
    expect(alpha!.provides).toEqual(['ssr'])
    expect(alpha!.params.port).toEqual({ type: 'string', default: '5173' })
    expect(alpha!.files).toEqual([{ from: 'files/a.txt', to: 'app/a.txt' }])
    expect(alpha!.fragments).toEqual([
      { target: 'ops/compose.yml', from: 'fragments/compose.yaml', strategy: 'yaml' },
    ])
    expect(alpha!.inject).toEqual([])
  })

  it('rejects a brick whose slot is not declared in slots.toml', async () => {
    const bad = fileURLToPath(new URL('./fixtures/registry-bad-slot', import.meta.url))
    await expect(loadRegistry(bad)).rejects.toThrow(/unknown slot "cache"/)
  })
})
