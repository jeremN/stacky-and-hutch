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

export async function planInjections(graph: Graph, ctx: PlanContext): Promise<FileOp[]> {
  const ops: FileOp[] = []
  const wanted = new Set<string>()

  for (const { brick, params } of graph.bricks) {
    for (const spec of brick.inject) {
      wanted.add(`${spec.target}#${spec.marker}`)
      const raw = await readFile(join(brick.dir, spec.from), 'utf8')
      const contents = spec.from.endsWith('.eta') ? renderTemplate(raw, params) : raw
      ops.push({ kind: 'inject', path: spec.target, marker: spec.marker, contents, owner: brick.name })
    }
  }

  // A locked injection whose brick is gone gets its region emptied, not deleted —
  // the host file belongs to the user.
  //
  // Note we test for host existence rather than calling fileState: an inject lock entry's
  // hash is of the *injected body*, not of the host file, so fileState would always say
  // "modified" here. Drift inside a marker region is out of scope — the host is the user's.
  for (const entry of ctx.lock.files) {
    if (entry.tier !== 'inject') continue
    const [path, marker] = entry.path.split('#')
    if (!marker || wanted.has(entry.path)) continue
    const hostExists = await access(join(ctx.projectDir, path!)).then(() => true, () => false)
    if (hostExists) {
      ops.push({ kind: 'inject', path: path!, marker, contents: '', owner: entry.owner as string })
    }
  }

  return ops
}
