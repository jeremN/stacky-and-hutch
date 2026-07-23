import { readManifest, writeManifest } from '@stacky/core'
import { runPlanApply, type RunOpts } from './apply.js'
import type { ParamBag } from '@stacky/core'

export async function add(name: string, params: ParamBag, opts: RunOpts): Promise<number> {
  const manifest = await readManifest(opts.cwd)
  manifest.bricks[name] = { ...(manifest.bricks[name] ?? {}), ...params }
  await writeManifest(opts.cwd, manifest)
  return runPlanApply(opts)
}
