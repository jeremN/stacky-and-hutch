import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { BANNER_YAML, deepMerge, mergeLines, mergeYaml } from '../merge.js'
import { renderTemplate } from '../template.js'
import type { FileOp, Graph } from '../types.js'
import type { PlanContext } from './tier-brick.js'

interface Contribution { brick: string; text: string; strategy: 'yaml' | 'lines' }

export async function planComposedFiles(graph: Graph, ctx: PlanContext): Promise<FileOp[]> {
  // target path -> contributions, already in graph order (stable)
  const byTarget = new Map<string, Contribution[]>()

  for (const { brick, params } of graph.bricks) {
    for (const spec of brick.fragments) {
      const raw = await readFile(join(brick.dir, spec.from), 'utf8')
      const text = spec.from.endsWith('.eta') ? renderTemplate(raw, params) : raw
      byTarget.set(spec.target, [
        ...(byTarget.get(spec.target) ?? []),
        { brick: brick.name, text, strategy: spec.strategy },
      ])
    }
  }

  const ops: FileOp[] = []

  for (const [target, contributions] of byTarget) {
    const strategy = contributions[0]!.strategy
    const mismatch = contributions.find((c) => c.strategy !== strategy)
    if (mismatch) {
      const names = contributions.map((c) => `${c.brick}(${c.strategy})`).join(', ')
      throw new Error(`bricks disagree on merge strategy for "${target}": ${names}`)
    }
    let contents =
      strategy === 'yaml'
        ? mergeYaml(contributions.map((c) => c.text))
        : mergeLines(contributions.map((c) => ({ brick: c.brick, text: c.text })))

    const override = ctx.overrides[target]
    if (override) {
      if (strategy !== 'yaml') {
        throw new Error(`overrides for "${target}" require a yaml fragment strategy`)
      }
      const merged = deepMerge(parseYaml(contents) as Record<string, unknown>, override)
      contents = BANNER_YAML + stringifyYaml(merged, { sortMapEntries: true })
    }

    ops.push({ kind: 'compose', path: target, contents, contributors: contributions.map((c) => c.brick) })
  }

  for (const entry of ctx.lock.files) {
    if (entry.tier !== 'composed' || byTarget.has(entry.path)) continue
    ops.push({ kind: 'delete', path: entry.path, owner: '@composed' })
  }

  return ops
}
