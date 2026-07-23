import { planBrickFiles } from './tier-brick.js'
import { planComposedFiles } from './tier-composed.js'
import { planInjections } from './tier-inject.js'
import type { FileOp, Graph } from '../types.js'
import type { PlanContext } from './tier-brick.js'

export type { PlanContext } from './tier-brick.js'

/** Pure: reads brick sources and the project tree, but never writes. */
export async function plan(graph: Graph, ctx: PlanContext): Promise<FileOp[]> {
  return [
    ...(await planBrickFiles(graph, ctx)),
    ...(await planComposedFiles(graph, ctx)),
    ...(await planInjections(graph, ctx)),
  ]
}

export function hasConflicts(ops: FileOp[]): boolean {
  return ops.some((op) => op.kind === 'conflict')
}
