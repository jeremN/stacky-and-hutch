import {
  apply as applyOps, emptyLock, exitCodeFor, formatError, hasConflicts,
  loadRegistry, plan as planOps, readLock, readManifest, resolve,
} from '@stacky/core'
import { isDirty } from '../git.js'
import { renderPlan } from '../render/diff.js'
import { jsonErrors, jsonPlan } from '../render/json.js'

export interface RunOpts {
  cwd: string
  registry: string
  json: boolean
  dryRun: boolean
  allowDirty: boolean
}

export async function runPlanApply(opts: RunOpts): Promise<number> {
  const registry = await loadRegistry(opts.registry)
  const manifest = await readManifest(opts.cwd)
  const resolved = resolve(manifest, registry)

  if (!resolved.ok) {
    console.error(opts.json ? jsonErrors(resolved.errors) : resolved.errors.map(formatError).join('\n'))
    return exitCodeFor(resolved.errors)
  }

  const lock = await readLock(opts.cwd)
  const ops = await planOps(resolved.graph, { projectDir: opts.cwd, lock, overrides: manifest.overrides })

  if (opts.dryRun) {
    console.log(opts.json ? jsonPlan(ops) : renderPlan(ops))
    return hasConflicts(ops) ? 1 : 0
  }

  if (hasConflicts(ops)) {
    console.error(opts.json ? jsonPlan(ops) : renderPlan(ops))
    return 1
  }

  // Stacky has no rollback of its own — git is the undo. That only works if the tree
  // was clean going in, so refuse rather than merely warn.
  if (!opts.allowDirty && (await isDirty(opts.cwd))) {
    console.error(
      'Working tree has uncommitted changes. Commit or stash first so you can `git checkout` ' +
        'to undo this apply, or pass --allow-dirty.',
    )
    return 1
  }

  await applyOps(ops, opts.cwd, resolved.graph)
  console.log(opts.json ? jsonPlan(ops) : renderPlan(ops))
  return 0
}

export { emptyLock }
