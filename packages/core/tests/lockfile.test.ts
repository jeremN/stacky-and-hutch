import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { emptyLock, fileState, hashContents, readLock, writeLock } from '../src/lockfile.js'

async function tmp() {
  return mkdtemp(join(tmpdir(), 'stacky-lock-'))
}

async function put(dir: string, rel: string, contents: string) {
  await mkdir(dirname(join(dir, rel)), { recursive: true })
  await writeFile(join(dir, rel), contents, 'utf8')
}

describe('lockfile', () => {
  it('hashes deterministically', () => {
    expect(hashContents('abc')).toBe(hashContents('abc'))
    expect(hashContents('abc')).not.toBe(hashContents('abd'))
  })

  it('returns an empty lock when stack.lock is absent', async () => {
    const dir = await tmp()
    expect(await readLock(dir)).toEqual({ version: 1, bricks: {}, files: [] })
  })

  it('round-trips through write and read', async () => {
    const dir = await tmp()
    const lock = {
      version: 1 as const,
      bricks: { pg: { version: '16' } },
      files: [{ path: 'ops/compose.yml', owner: '@composed' as const, tier: 'composed' as const, hash: 'h' }],
    }
    await writeLock(dir, lock)
    expect(await readLock(dir)).toEqual(lock)
  })

  it('detects the three file states', async () => {
    const dir = await tmp()
    await put(dir, 'a.txt', 'hello')
    const entry = { path: 'a.txt', owner: 'pg', tier: 'brick' as const, hash: hashContents('hello') }

    expect(await fileState(dir, entry)).toBe('clean')

    await put(dir, 'a.txt', 'edited by hand')
    expect(await fileState(dir, entry)).toBe('modified')

    expect(await fileState(dir, { ...entry, path: 'gone.txt' })).toBe('missing')
  })
})
