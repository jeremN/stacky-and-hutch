import type {
  Brick, BrickParam, Graph, Manifest, ParamBag, ParamValue,
  Registry, ResolutionError, ResolveResult, ResolvedBrick,
} from './types.js'

/** Character-overlap score; good enough for "did you mean". */
function similarity(a: string, b: string): number {
  const set = new Set(b)
  let hits = 0
  for (const ch of new Set(a)) if (set.has(ch)) hits++
  return hits / Math.max(a.length, b.length)
}

function suggest(name: string, known: string[]): string[] {
  return known.filter((k) => similarity(name, k) > 0.5).slice(0, 3)
}

function checkParams(brick: Brick, supplied: ParamBag, errors: ResolutionError[]): ParamBag {
  const out: ParamBag = {}
  for (const [key, schema] of Object.entries(brick.params)) {
    const value: ParamValue | undefined = supplied[key] ?? (schema.default as ParamValue | undefined)
    if (value === undefined) {
      errors.push({ kind: 'missing-param', brick: brick.name, param: key, schema })
      continue
    }
    const reason = validate(schema, value)
    if (reason) {
      errors.push({ kind: 'invalid-param', brick: brick.name, param: key, value, reason })
      continue
    }
    out[key] = value
  }
  return out
}

function validate(schema: BrickParam, value: ParamValue): string | null {
  if (schema.type === 'boolean' && typeof value !== 'boolean') return 'expected a boolean'
  if (schema.type === 'string' && typeof value !== 'string') return 'expected a string'
  if (schema.type === 'enum') {
    if (typeof value !== 'string') return 'expected a string'
    if (!schema.values?.includes(value)) return `expected one of ${schema.values?.join(', ')}`
  }
  return null
}

export function resolve(manifest: Manifest, registry: Registry): ResolveResult {
  const errors: ResolutionError[] = []
  const selected = new Map<string, ResolvedBrick>()
  const known = [...registry.bricks.keys()]

  const queue: { name: string; inferred: boolean }[] = Object.keys(manifest.bricks).map((name) => ({
    name,
    inferred: false,
  }))
  const seen = new Set<string>()

  while (queue.length > 0) {
    const { name, inferred } = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)

    const brick = registry.bricks.get(name)
    if (!brick) {
      errors.push({ kind: 'unknown-brick', name, suggestions: suggest(name, known) })
      continue
    }

    selected.set(name, { brick, params: checkParams(brick, manifest.bricks[name] ?? {}, errors), inferred })
  }

  // Capability satisfaction. Iterate to a fixed point so inferred bricks' own
  // requires are honoured too.
  for (let pass = 0; pass < 32; pass++) {
    const provided = new Set<string>()
    for (const r of selected.values()) for (const cap of r.brick.provides) provided.add(cap)

    let added = false
    for (const r of [...selected.values()]) {
      for (const cap of Object.keys(r.brick.requires)) {
        if (provided.has(cap)) continue
        const candidates = known.filter((k) => registry.bricks.get(k)!.provides.includes(cap)).sort()
        if (candidates.length === 0) {
          errors.push({ kind: 'unsatisfiable', capability: cap, requiredBy: r.brick.name })
        } else if (candidates.length > 1) {
          errors.push({ kind: 'ambiguous', capability: cap, candidates, requiredBy: r.brick.name })
        } else {
          const only = registry.bricks.get(candidates[0]!)!
          selected.set(only.name, {
            brick: only,
            params: checkParams(only, manifest.bricks[only.name] ?? {}, errors),
            inferred: true,
          })
          added = true
        }
      }
    }
    if (!added) break
  }

  // Slot exclusivity.
  const bySlot = new Map<string, string[]>()
  for (const r of selected.values()) {
    bySlot.set(r.brick.slot, [...(bySlot.get(r.brick.slot) ?? []), r.brick.name])
  }
  for (const slot of registry.slots) {
    const occupants = (bySlot.get(slot.name) ?? []).sort()
    if (slot.single && occupants.length > 1) {
      errors.push({ kind: 'slot-conflict', slot: slot.name, bricks: occupants })
    }
  }

  if (errors.length > 0) return { ok: false, errors: dedupe(errors) }

  // Stable order: slot declaration order, then brick name.
  const slotIndex = new Map(registry.slots.map((s, i) => [s.name, i]))
  const bricks = [...selected.values()].sort((a, b) => {
    const d = (slotIndex.get(a.brick.slot) ?? 0) - (slotIndex.get(b.brick.slot) ?? 0)
    return d !== 0 ? d : a.brick.name.localeCompare(b.brick.name)
  })

  return { ok: true, graph: { bricks } satisfies Graph }
}

function dedupe(errors: ResolutionError[]): ResolutionError[] {
  const seen = new Set<string>()
  return errors.filter((e) => {
    const key = JSON.stringify(e)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
