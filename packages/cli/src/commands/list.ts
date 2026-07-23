import { loadRegistry } from '@stacky/core'

export async function list(registryDir: string, json: boolean): Promise<number> {
  const reg = await loadRegistry(registryDir)
  const rows = [...reg.bricks.values()].map((b) => ({
    name: b.name, slot: b.slot, summary: b.summary,
    provides: b.provides, requires: Object.keys(b.requires),
  }))
  console.log(json ? JSON.stringify(rows, null, 2)
    : rows.map((r) => `  ${r.name.padEnd(12)} ${r.slot.padEnd(10)} ${r.summary}`).join('\n'))
  return 0
}
