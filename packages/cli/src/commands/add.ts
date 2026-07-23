import { formatError, loadRegistry, readManifest, resolve, writeManifest } from '@stacky/core'
import { runPlanApply, type RunOpts } from './apply.js'
import type { ParamBag } from '@stacky/core'

export async function add(name: string, params: ParamBag, opts: RunOpts): Promise<number> {
  // Validate before writing: an unresolvable name left in stack.toml can never converge,
  // and the manifest gives you no hint how to recover. Reuse the resolver's own
  // unknown-brick error (with its fuzzy suggestions) rather than duplicating that logic.
  const registry = await loadRegistry(opts.registry)
  if (!registry.bricks.has(name)) {
    const probe = resolve({ bricks: { [name]: {} }, overrides: {} }, registry)
    console.error(
      !probe.ok
        ? probe.errors.map(formatError).join('\n')
        : `Unknown brick "${name}". Run \`stacky list\` to see available bricks.`,
    )
    return 1
  }

  const manifest = await readManifest(opts.cwd)
  manifest.bricks[name] = { ...(manifest.bricks[name] ?? {}), ...params }
  await writeManifest(opts.cwd, manifest)
  return runPlanApply(opts)
}
