import type { FileOp, ResolutionError } from '@stacky/core'

export function jsonPlan(ops: FileOp[]): string {
  return JSON.stringify({ ok: true, ops }, null, 2)
}

export function jsonErrors(errors: ResolutionError[]): string {
  return JSON.stringify({ ok: false, errors }, null, 2)
}
