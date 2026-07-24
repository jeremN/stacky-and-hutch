import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderTemplate } from '../template.js'
import type { FileOp, Graph } from '../types.js'
import type { PlanContext } from './tier-brick.js'

function region(marker: string): { open: RegExp; openText: string; closeText: string } {
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return {
    open: new RegExp(
      `([^\\n]*>>>\\s*${esc}(?![\\w:.\\-])[^\\n]*\\n)([\\s\\S]*?)([^\\n]*<<<\\s*${esc}(?![\\w:.\\-])[^\\n]*)`,
    ),
    openText: `>>> ${marker}`,
    closeText: `<<< ${marker}`,
  }
}

/** Replaces the body between the marker delimiters. Content outside is untouched. */
export function applyMarker(host: string, marker: string, body: string): string {
  const { open } = region(marker)
  if (!open.test(host)) {
    throw new Error(`marker "${marker}" not found in host file — the owning brick must create it first`)
  }
  const trimmed = body.replace(/\n+$/, '')
  return host.replace(open, (_m, start: string, _mid: string, end: string) =>
    trimmed.length > 0 ? `${start}${trimmed}\n${end}` : `${start}${end}`,
  )
}

export function stripMarker(host: string, marker: string): string {
  return applyMarker(host, marker, '')
}

function resolvePoint(graph: Graph, point: string): { target: string; marker: string } {
  for (const { brick } of graph.bricks) {
    const ip = brick.injectionPoints.find((p) => p.name === point)
    if (ip) return { target: ip.target, marker: ip.marker }
  }
  // Unreachable when resolve() succeeded: consuming a point requires its publisher.
  throw new Error(`no brick in the graph publishes injection point "${point}"`)
}

export async function planInjections(graph: Graph, ctx: PlanContext): Promise<FileOp[]> {
  const ops: FileOp[] = []
  // "target#marker" -> contributors, collected in graph order (stable).
  const byMarker = new Map<string, { target: string; marker: string; parts: string[] }>()

  for (const { brick, params } of graph.bricks) {
    for (const spec of brick.inject) {
      const { target, marker } = spec.point
        ? resolvePoint(graph, spec.point)
        : { target: spec.target!, marker: spec.marker! }
      const raw = await readFile(join(brick.dir, spec.from), 'utf8')
      const text = spec.from.endsWith('.eta') ? renderTemplate(raw, params) : raw
      const key = `${target}#${marker}`
      const group = byMarker.get(key) ?? { target, marker, parts: [] }
      group.parts.push(text.replace(/\n+$/, ''))
      byMarker.set(key, group)
    }
  }

  const wanted = new Set(byMarker.keys())
  for (const { target, marker, parts } of byMarker.values()) {
    ops.push({ kind: 'inject', path: target, marker, contents: parts.join('\n'), owner: '@composed' })
  }

  // A locked marker with no current contributor gets its region emptied (host stays).
  for (const entry of ctx.lock.files) {
    if (entry.tier !== 'inject') continue
    const [path, marker] = entry.path.split('#')
    if (!marker || wanted.has(entry.path)) continue
    const hostExists = await access(join(ctx.projectDir, path!)).then(() => true, () => false)
    if (hostExists) ops.push({ kind: 'inject', path: path!, marker, contents: '', owner: '@composed' })
  }

  return ops
}
