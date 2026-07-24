import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { Brick, BrickParam, FragmentSpec, InjectSpec, InjectionPoint, Registry, SlotDef } from './types.js'

interface RawBrickFile {
  brick?: { name?: string; slot?: string; summary?: string }
  requires?: Record<string, string>
  provides?: { capabilities?: string[] }
  params?: Record<string, BrickParam>
  files?: { from: string; to: string; when?: string }[]
  fragments?: { target: string; from: string; strategy?: string; when?: string }[]
  inject?: { point?: string; target?: string; marker?: string; from: string; when?: string }[]
  injection_points?: { name: string; target: string; marker: string }[]
}

function parseFragment(raw: { target: string; from: string; strategy?: string; when?: string }, brick: string): FragmentSpec {
  const strategy = raw.strategy ?? 'yaml'
  if (strategy !== 'yaml' && strategy !== 'lines' && strategy !== 'json') {
    throw new Error(`brick "${brick}": unknown fragment strategy "${strategy}" (expected "yaml", "lines", or "json")`)
  }
  return { target: raw.target, from: raw.from, strategy, when: raw.when }
}

function parseInject(raw: { point?: string; target?: string; marker?: string; from: string; when?: string }, brick: string): InjectSpec {
  const hasPoint = raw.point != null
  const hasExplicit = raw.target != null && raw.marker != null
  if (hasPoint === hasExplicit) {
    throw new Error(`brick "${brick}": each [[inject]] needs exactly one of "point" or ("target" and "marker")`)
  }
  return hasPoint
    ? { point: raw.point, from: raw.from, when: raw.when }
    : { target: raw.target, marker: raw.marker, from: raw.from, when: raw.when }
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

      const injectionPoints: InjectionPoint[] = (raw.injection_points ?? []).map((p) => ({
        name: p.name, target: p.target, marker: p.marker,
      }))
      const inject = (raw.inject ?? []).map((i) => parseInject(i, name))
      const provides = [
        ...(raw.provides?.capabilities ?? []),
        ...injectionPoints.map((p) => `inject:${p.name}`),
      ]
      const requires: Record<string, string> = { ...(raw.requires ?? {}) }
      for (const i of inject) if (i.point) requires[`inject:${i.point}`] = '*'

      bricks.set(name, {
        name, slot, summary: raw.brick?.summary ?? '', dir: brickDir,
        requires, provides, params: raw.params ?? {},
        files: raw.files ?? [],
        fragments: (raw.fragments ?? []).map((f) => parseFragment(f, name)),
        inject, injectionPoints,
      })
    }
  }

  return { bricks, slots }
}
