import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { apply, emptyLock, loadRegistry, plan, resolve } from '../src/index.js'

const run = promisify(execFile)
const bricksDir = fileURLToPath(new URL('../../../bricks', import.meta.url))

async function has(bin: string): Promise<boolean> {
  try {
    await run(bin, ['--version'])
    return true
  } catch {
    return false
  }
}

async function buildStack(): Promise<string> {
  const reg = await loadRegistry(bricksDir)
  const r = resolve({ bricks: { sveltekit: {}, caddy: {}, postgres: {} }, overrides: {} }, reg)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  const dir = await mkdtemp(join(tmpdir(), 'stacky-artifact-'))
  await apply(await plan(r.graph, { projectDir: dir, lock: emptyLock(), overrides: {} }), dir, r.graph)
  return dir
}

describe('generated artifacts are valid', () => {
  it('docker compose accepts the composed file', async ({ skip }) => {
    if (!(await has('docker'))) skip()
    const dir = await buildStack()
    const { stdout } = await run('docker', ['compose', '-f', join(dir, 'ops/compose.yml'), 'config'])
    expect(stdout).toContain('postgres')
  })

  it('caddy accepts the generated Caddyfile', async ({ skip }) => {
    if (!(await has('caddy'))) skip()
    const dir = await buildStack()
    await expect(
      run('caddy', ['validate', '--config', join(dir, 'ops/caddy/Caddyfile'), '--adapter', 'caddyfile']),
    ).resolves.toBeDefined()
  })
})
