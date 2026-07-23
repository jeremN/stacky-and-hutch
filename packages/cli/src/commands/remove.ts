import { readManifest, writeManifest } from '@stacky/core'
import { runPlanApply, type RunOpts } from './apply.js'

export async function remove(name: string, opts: RunOpts): Promise<number> {
  const manifest = await readManifest(opts.cwd)
  if (!(name in manifest.bricks)) {
    console.error(`Brick "${name}" is not in stack.toml.`)
    return 1
  }
  delete manifest.bricks[name]
  await writeManifest(opts.cwd, manifest)
  return runPlanApply(opts)
}
