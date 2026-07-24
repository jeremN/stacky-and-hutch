import { describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { runCli } from '../src/index.js'

const run = promisify(execFile)
const bricksDir = fileURLToPath(new URL('../../../bricks', import.meta.url))

async function project() {
  return mkdtemp(join(tmpdir(), 'stacky-cli-'))
}

function argv(dir: string, ...rest: string[]) {
  return ['node', 'stacky', ...rest, '--cwd', dir, '--registry', bricksDir, '--json', '--yes']
}

describe('cli', () => {
  it('add writes stack.toml and exits 0', async () => {
    const dir = await project()
    await runCli(argv(dir, 'add', 'sveltekit'))
    const code = await runCli(argv(dir, 'add', 'postgres'))
    expect(code).toBe(0)
    expect(await readFile(join(dir, 'stack.toml'), 'utf8')).toContain('postgres')
    expect(await readFile(join(dir, 'ops/compose.yml'), 'utf8')).toContain('postgres:')
  })

  it('exits 2 with candidates when a capability is ambiguous', async () => {
    const dir = await project()
    const ambiguous = fileURLToPath(new URL('../../core/tests/fixtures/resolve', import.meta.url))
    const code = await runCli(['node', 'stacky', 'add', 'web-a', '--cwd', dir,
      '--registry', ambiguous, '--json', '--yes', '--set', 'title=x'])
    expect(code).toBe(2)
  })

  it('add postgres alone against the real registry is ambiguous (two server-init publishers)', async () => {
    const dir = await project()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runCli(argv(dir, 'add', 'postgres'))).toBe(2)
      const payload = JSON.parse(errorSpy.mock.calls.at(-1)?.[0] as string)
      expect(payload.errors).toContainEqual(
        expect.objectContaining({
          kind: 'ambiguous-injection-point',
          point: 'server-init',
          candidates: ['sveltekit', 'tanstack-start'],
        }),
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('exits 1 for an unknown brick and does not write stack.toml', async () => {
    const dir = await project()
    expect(await runCli(argv(dir, 'add', 'nope'))).toBe(1)
    await expect(readFile(join(dir, 'stack.toml'), 'utf8')).rejects.toThrow()
  })

  it('remove reverses add', async () => {
    const dir = await project()
    expect(await runCli(argv(dir, 'add', 'sveltekit'))).toBe(0)
    expect(await runCli(argv(dir, 'add', 'postgres'))).toBe(0)
    expect(await readFile(join(dir, 'stack.toml'), 'utf8')).toContain('postgres')
    expect(await runCli(argv(dir, 'remove', 'postgres'))).toBe(0)
    expect(await readFile(join(dir, 'stack.toml'), 'utf8')).not.toContain('postgres')
    expect(await readFile(join(dir, 'stack.toml'), 'utf8')).toContain('sveltekit')
  })

  it('plan writes nothing to disk', async () => {
    const dir = await project()
    await runCli(argv(dir, 'add', 'sveltekit'))
    await runCli(argv(dir, 'add', 'postgres'))
    const before = await readFile(join(dir, 'ops/compose.yml'), 'utf8')
    expect(await runCli(argv(dir, 'plan'))).toBe(0)
    expect(await readFile(join(dir, 'ops/compose.yml'), 'utf8')).toBe(before)
  })

  it('refuses to apply into a dirty git worktree unless --allow-dirty', async () => {
    const dir = await project()
    await runCli(argv(dir, 'add', 'sveltekit'))
    await run('git', ['init'], { cwd: dir })
    await writeFile(join(dir, 'untracked.txt'), 'work in progress')

    expect(await runCli(argv(dir, 'add', 'postgres'))).toBe(1)
    expect(await runCli([...argv(dir, 'add', 'postgres'), '--allow-dirty'])).toBe(0)
  })
})
