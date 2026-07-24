import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { Brick, BrickParam, FragmentSpec, Registry, SlotDef } from './types.js'

interface RawBrickFile {
  brick?: { name?: string; slot?: string; summary?: string }
  requires?: Record<string, string>
  provides?: { capabilities?: string[] }
  params?: Record<string, BrickParam>
  files?: { from: string; to: string }[]
  fragments?: { target: string; from: string; strategy?: string }[]
  inject?: { target: string; marker: string; from: string }[]
}

function parseFragment(raw: { target: string; from: string; strategy?: string }, brick: string): FragmentSpec {
  const strategy = raw.strategy ?? 'yaml'
  if (strategy !== 'yaml' && strategy !== 'lines') {
    throw new Error(`brick "${brick}": unknown fragment strategy "${strategy}" (expected "yaml" or "lines")`)
  }
  return { target: raw.target, from: raw.from, strategy }
}

export async function loadRegistry(dir: string): Promise<Registry> {
  const slotsRaw = parseToml(await readFile(join(dir, 'slots.toml'), 'utf8')) as {
    slot?: { name: string; single?: boolean }[]
  }
  const slots: SlotDef[] = (slotsRaw.slot ?? []).map((s) => ({ name: s.name, single: s.single ?? true }))
  const slotNames = new Set(slots.map((s) => s.name))

  const bricks = new Map<string, Brick>()

  for (const concern of await readdir(dir, { withFileTypes: true })) {
    if (!concern.isDirectory()) continue
    const concernDir = join(dir, concern.name)

    for (const entry of await readdir(concernDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const brickDir = join(concernDir, entry.name)

      let text: string
      try {
        text = await readFile(join(brickDir, 'brick.toml'), 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw err
      }
      const raw = parseToml(text) as RawBrickFile

      const name = raw.brick?.name
      const slot = raw.brick?.slot
      if (!name) throw new Error(`${concern.name}/${entry.name}/brick.toml: missing [brick].name`)
      if (!slot) throw new Error(`${concern.name}/${entry.name}/brick.toml: missing [brick].slot`)
      if (name !== entry.name) {
        throw new Error(`brick "${name}" must live in a folder of the same name (found "${entry.name}")`)
      }
      if (!slotNames.has(slot)) {
        throw new Error(`brick "${name}": unknown slot "${slot}" — declare it in slots.toml`)
      }

      bricks.set(name, {
        name,
        slot,
        summary: raw.brick?.summary ?? '',
        dir: brickDir,
        requires: raw.requires ?? {},
        provides: raw.provides?.capabilities ?? [],
        params: raw.params ?? {},
        files: raw.files ?? [],
        fragments: (raw.fragments ?? []).map((f) => parseFragment(f, name)),
        inject: raw.inject ?? [],
      })
    }
  }

  return { bricks, slots }
}
