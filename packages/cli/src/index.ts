import { cac } from 'cac'
import { fileURLToPath } from 'node:url'
import { add } from './commands/add.js'
import { init } from './commands/init.js'
import { list } from './commands/list.js'
import { remove } from './commands/remove.js'
import { runPlanApply, type RunOpts } from './commands/apply.js'
import type { ParamBag } from '@stacky/core'

const DEFAULT_REGISTRY = fileURLToPath(new URL('../../../bricks', import.meta.url))

interface RawFlags {
  cwd?: string
  registry?: string
  json?: boolean
  allowDirty?: boolean
  set?: string | string[]
}

function toOpts(flags: RawFlags, dryRun = false): RunOpts {
  return {
    cwd: flags.cwd ?? process.cwd(),
    registry: flags.registry ?? DEFAULT_REGISTRY,
    json: flags.json ?? false,
    allowDirty: flags.allowDirty ?? false,
    dryRun,
  }
}

function parseSet(set: RawFlags['set']): ParamBag {
  const list = set === undefined ? [] : Array.isArray(set) ? set : [set]
  const out: ParamBag = {}
  for (const pair of list) {
    const idx = pair.indexOf('=')
    if (idx === -1) throw new Error(`--set expects key=value, got "${pair}"`)
    out[pair.slice(0, idx)] = pair.slice(idx + 1)
  }
  return out
}

export async function runCli(argv: string[]): Promise<number> {
  const cli = cac('stacky')
  cli.option('--cwd <dir>', 'Project directory', { default: process.cwd() })
  cli.option('--registry <dir>', 'Brick registry directory')
  cli.option('--json', 'Machine-readable output')
  cli.option('--yes', 'Never prompt; fail with exit 2 if input is required')
  cli.option('--allow-dirty', 'Apply even with uncommitted changes in the worktree')

  let code = 0
  let ran = false

  cli.command('init', 'Create stack.toml').action(async (flags: RawFlags) => {
    ran = true
    code = await init(flags.cwd ?? process.cwd())
  })

  cli.command('add <brick>', 'Add a brick and apply')
    .option('--set <pair>', 'Set a brick param, key=value')
    .action(async (brick: string, flags: RawFlags) => {
      ran = true
      code = await add(brick, parseSet(flags.set), toOpts(flags))
    })

  cli.command('remove <brick>', 'Remove a brick and apply').action(async (brick: string, flags: RawFlags) => {
    ran = true
    code = await remove(brick, toOpts(flags))
  })

  cli.command('plan', 'Show what apply would do').action(async (flags: RawFlags) => {
    ran = true
    code = await runPlanApply(toOpts(flags, true))
  })

  cli.command('apply', 'Converge the project onto stack.toml').action(async (flags: RawFlags) => {
    ran = true
    code = await runPlanApply(toOpts(flags))
  })

  cli.command('list', 'List available bricks').action(async (flags: RawFlags) => {
    ran = true
    code = await list(flags.registry ?? DEFAULT_REGISTRY, flags.json ?? false)
  })

  cli.help()
  const parsed = cli.parse(argv, { run: false })
  try {
    await cli.runMatchedCommand()
  } catch (err) {
    console.error((err as Error).message)
    return 1
  }
  if (!ran && !parsed.options.help) {
    cli.outputHelp()
    return 1
  }
  return code
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (invokedDirectly) process.exit(await runCli(process.argv))
