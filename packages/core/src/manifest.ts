import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import type { Manifest, ParamBag } from './types.js'

const BANNER = [
  '# stacky manifest — this file is yours to edit.',
  '# Run `stacky apply` after changing it. `stack.lock` is generated; never edit that one.',
  '',
].join('\n')

export function emptyManifest(): Manifest {
  return { bricks: {}, overrides: {} }
}

export async function readManifest(projectDir: string): Promise<Manifest> {
  let text: string
  try {
    text = await readFile(join(projectDir, 'stack.toml'), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyManifest()
    throw err
  }
  const raw = parseToml(text) as {
    bricks?: Record<string, ParamBag>
    overrides?: Record<string, Record<string, unknown>>
  }
  return { bricks: raw.bricks ?? {}, overrides: raw.overrides ?? {} }
}

export async function writeManifest(projectDir: string, m: Manifest): Promise<void> {
  const body = stringifyToml({ bricks: m.bricks, overrides: m.overrides })
  await writeFile(join(projectDir, 'stack.toml'), `${BANNER}${body}\n`, 'utf8')
}
