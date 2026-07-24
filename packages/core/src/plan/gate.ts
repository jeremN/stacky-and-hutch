import type { Graph } from '../types.js'

/** Capabilities provided by every brick in the resolved graph. */
export function providedCapabilities(graph: Graph): Set<string> {
  return new Set(graph.bricks.flatMap((b) => b.brick.provides))
}

/** A contribution with no `when` always applies; otherwise its gate must be in the graph. */
export function gatePasses(when: string | undefined, provided: Set<string>): boolean {
  return when === undefined || provided.has(when)
}
