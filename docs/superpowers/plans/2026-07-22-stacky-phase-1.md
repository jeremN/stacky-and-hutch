# Stacky Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working `stacky` CLI that materializes four bricks into a target repo and can cleanly remove them again, proving the three-tier file-ownership model end to end.

**Architecture:** A pnpm workspace with a headless `core` package (registry → resolve → plan → apply, all pure except `apply`) and a thin `cli` adapter over it. Bricks are folders under `bricks/` with a `brick.toml`. The acceptance gate is a round-trip property test: for every brick, `add X` then `remove X` must return the project tree to a byte-identical state.

**Tech Stack:** TypeScript (ESM, Node 22+), pnpm workspaces, Vitest 4, `smol-toml` (manifest/brick parsing), `yaml` (compose merging), `eta` v4 (templating), `cac` (CLI).

## Global Constraints

- Node >= 22, ESM only (`"type": "module"` in every package). No CommonJS.
- TypeScript strict mode on. No `any` in `packages/core/src`.
- `packages/core` must not import from `packages/cli`. The dependency arrow points inward only.
- `resolve()` and `plan()` are pure — no filesystem writes, no prompts, no `process.exit`. Only `apply()` writes.
- Composed files are merged in a stable order: `(slot index in bricks/slots.toml, then brick name)`. Output must be byte-identical for an unchanged manifest.
- Exit codes: `0` success, `1` error, `2` needs input (ambiguity or missing required param).
- `stack.toml` is TOML and hand-editable. `stack.lock` is JSON and machine-only.
- Commit messages: single conventional-commits subject line, no body, no `Co-Authored-By` trailer.

## File Structure

```
package.json                      # workspace root, scripts
pnpm-workspace.yaml
tsconfig.base.json
vitest.config.ts
bricks/
  slots.toml                      # slot declaration order + occupancy
  sveltekit/ compose/ caddy/ postgres/
packages/core/
  package.json
  src/
    types.ts                      # every shared type; no logic
    errors.ts                     # ResolutionError constructors + formatting
    registry.ts                   # loadRegistry()
    manifest.ts                   # readManifest() / writeManifest()
    resolve.ts                    # resolve()
    lockfile.ts                   # readLock/writeLock/hashContents/statePerFile
    template.ts                   # renderTemplate()
    merge.ts                      # deepMerge() + mergeYaml() + mergeLines()
    plan/
      index.ts                    # plan() — orchestrates the three tiers
      tier-brick.ts               # [[files]]
      tier-composed.ts            # [[fragments]] + overrides
      tier-inject.ts              # [[inject]] markers
    apply.ts                      # apply()
    index.ts                      # public barrel
  tests/
packages/cli/
  package.json
  src/
    index.ts                      # cac wiring, exit codes
    git.ts                        # worktree-clean check
    commands/{init,add,remove,plan,apply,list}.ts
    render/{diff,json}.ts
```

**Deferred to phase 2 (deliberately out of scope):**

- `package.json` key merging. No phase-1 brick needs it, and JSON cannot carry comment
  markers, so it needs a fourth structured-merge strategy.
- Brick versioning / `stacky upgrade`; `stacky graph`; generated `AGENTS.md` in target projects.
- **Interactive prompting.** The spec's surface table gives the CLI "interactive picks for
  ambiguity", but every phase-1 brick has a default for each param and every capability has
  exactly one provider — so no phase-1 path can reach a prompt. `resolve()` still returns
  ambiguity as data and the CLI still exits 2 on it, which is the contract phase 2 builds the
  picker on top of. `--yes` is accepted now and is a no-op.

---

### Task 1: Workspace scaffold + brick registry loader

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `packages/core/src/types.ts`, `packages/core/src/registry.ts`
- Create: `bricks/slots.toml`
- Test: `packages/core/tests/registry.test.ts`, fixtures in `packages/core/tests/fixtures/registry-basic/`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: all shared types from `types.ts` (`Brick`, `Registry`, `Manifest`, `Graph`, `FileOp`, `Lockfile`, `ResolutionError`); `loadRegistry(dir: string): Promise<Registry>`

- [ ] **Step 1: Scaffold the workspace**

`package.json`:
```json
{
  "name": "stacky-and-hutch",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^4.1.10",
    "@types/node": "^22.10.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "composite": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['packages/*/tests/**/*.test.ts'] },
})
```

`packages/core/package.json`:
```json
{
  "name": "@stacky/core",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "smol-toml": "^1.7.0",
    "yaml": "^2.9.0",
    "eta": "^4.6.0"
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

Run: `pnpm install`

- [ ] **Step 2: Write `types.ts`**

```ts
export type BrickId = string
export type Tier = 'brick' | 'composed' | 'inject'

export interface BrickParam {
  type: 'string' | 'enum' | 'boolean'
  values?: string[]
  default?: string | boolean
  prompt?: string
}

export interface FileSpec { from: string; to: string }
export interface FragmentSpec { target: string; from: string; strategy: 'yaml' | 'lines' }
export interface InjectSpec { target: string; marker: string; from: string }

export interface Brick {
  name: BrickId
  slot: string
  summary: string
  dir: string
  requires: Record<string, string>
  provides: string[]
  params: Record<string, BrickParam>
  files: FileSpec[]
  fragments: FragmentSpec[]
  inject: InjectSpec[]
}

export interface SlotDef { name: string; single: boolean }

export interface Registry {
  bricks: Map<BrickId, Brick>
  slots: SlotDef[]
}

export type ParamValue = string | boolean
export type ParamBag = Record<string, ParamValue>

export interface Manifest {
  bricks: Record<BrickId, ParamBag>
  overrides: Record<string, Record<string, unknown>>
}

export interface ResolvedBrick {
  brick: Brick
  params: ParamBag
  inferred: boolean
}

export interface Graph {
  bricks: ResolvedBrick[]
}

export type ResolutionError =
  | { kind: 'ambiguous'; capability: string; candidates: BrickId[]; requiredBy: BrickId }
  | { kind: 'unsatisfiable'; capability: string; requiredBy: BrickId }
  | { kind: 'slot-conflict'; slot: string; bricks: BrickId[] }
  | { kind: 'cycle'; path: BrickId[] }
  | { kind: 'unknown-brick'; name: string; suggestions: BrickId[] }
  | { kind: 'missing-param'; brick: BrickId; param: string; schema: BrickParam }
  | { kind: 'invalid-param'; brick: BrickId; param: string; value: unknown; reason: string }

export type ResolveResult =
  | { ok: true; graph: Graph }
  | { ok: false; errors: ResolutionError[] }

export type FileOp =
  | { kind: 'create'; path: string; contents: string; owner: BrickId; tier: Tier }
  | { kind: 'overwrite'; path: string; contents: string; owner: BrickId; tier: Tier; prevHash: string }
  | { kind: 'compose'; path: string; contents: string; contributors: BrickId[] }
  | { kind: 'inject'; path: string; marker: string; contents: string; owner: BrickId }
  | { kind: 'delete'; path: string; owner: BrickId }
  // `contents` is what stacky *would* have written. apply() dumps it to
  // `<path>.stacky-new` so you can diff. Absent when the blocked op was a deletion.
  | { kind: 'conflict'; path: string; reason: 'user-modified'; contents?: string }

export interface LockEntry {
  path: string
  owner: BrickId | '@composed'
  tier: Tier
  hash: string
}

export interface Lockfile {
  version: 1
  bricks: Record<BrickId, ParamBag>
  files: LockEntry[]
}
```

- [ ] **Step 3: Write the failing registry test**

Create fixture `packages/core/tests/fixtures/registry-basic/slots.toml`:
```toml
[[slot]]
name = "container"
single = true

[[slot]]
name = "web"
single = true

[[slot]]
name = "db"
single = true
```

Create fixture `packages/core/tests/fixtures/registry-basic/alpha/brick.toml`:
```toml
[brick]
name    = "alpha"
slot    = "web"
summary = "Test brick alpha"

[requires]
sql-db = "*"

[provides]
capabilities = ["ssr"]

[params]
port = { type = "string", default = "5173" }

[[files]]
from = "files/a.txt"
to   = "app/a.txt"

[[fragments]]
target   = "ops/compose.yml"
from     = "fragments/compose.yaml"
strategy = "yaml"
```

Create `packages/core/tests/fixtures/registry-basic/alpha/files/a.txt` containing exactly
`alpha\n` (the word `alpha` followed by a single trailing newline — later tasks assert on the
exact bytes).

Create `packages/core/tests/fixtures/registry-basic/alpha/fragments/compose.yaml` containing:
```yaml
services:
  alpha:
    image: node:22
```

`alpha` requires `sql-db`, so the fixture needs a provider or it will never resolve. Add a
payload-free one — it satisfies the capability without contributing any file ops, which keeps
later tasks' expected `FileOp[]` exactly one entry long.

Create `packages/core/tests/fixtures/registry-basic/beta/brick.toml`:
```toml
[brick]
name    = "beta"
slot    = "db"
summary = "Payload-free capability provider for fixtures"

[provides]
capabilities = ["sql-db"]
```

`packages/core/tests/registry.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { loadRegistry } from '../src/registry.js'

const fixture = fileURLToPath(new URL('./fixtures/registry-basic', import.meta.url))

describe('loadRegistry', () => {
  it('loads slots in declaration order', async () => {
    const reg = await loadRegistry(fixture)
    expect(reg.slots.map((s) => s.name)).toEqual(['container', 'web', 'db'])
  })

  it('parses a brick with all sections', async () => {
    const reg = await loadRegistry(fixture)
    const alpha = reg.bricks.get('alpha')
    expect(alpha).toBeDefined()
    expect(alpha!.slot).toBe('web')
    expect(alpha!.requires).toEqual({ 'sql-db': '*' })
    expect(alpha!.provides).toEqual(['ssr'])
    expect(alpha!.params.port).toEqual({ type: 'string', default: '5173' })
    expect(alpha!.files).toEqual([{ from: 'files/a.txt', to: 'app/a.txt' }])
    expect(alpha!.fragments).toEqual([
      { target: 'ops/compose.yml', from: 'fragments/compose.yaml', strategy: 'yaml' },
    ])
    expect(alpha!.inject).toEqual([])
  })

  it('rejects a brick whose slot is not declared in slots.toml', async () => {
    const bad = fileURLToPath(new URL('./fixtures/registry-bad-slot', import.meta.url))
    await expect(loadRegistry(bad)).rejects.toThrow(/unknown slot "cache"/)
  })
})
```

Create fixture `packages/core/tests/fixtures/registry-bad-slot/slots.toml` with only a `web` slot, and `packages/core/tests/fixtures/registry-bad-slot/beta/brick.toml`:
```toml
[brick]
name    = "beta"
slot    = "cache"
summary = "Brick with an undeclared slot"
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/registry.test.ts`
Expected: FAIL — `Failed to resolve import "../src/registry.js"`

- [ ] **Step 5: Implement `registry.ts`**

```ts
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { Brick, BrickParam, FragmentSpec, Registry, SlotDef } from './types.js'

interface RawBrickFile {
  brick?: { name?: string; slot?: string; summary?: string }
  requires?: Record<string, string>
  provides?: { capabilities?: string[] }
  params?: Record<string, BrickParam>
  files?: { from: string; to: string }[]
  fragments?: { target: string; from: string; strategy?: string }[]
  inject?: { target: string; marker: string; from: string }[]
}

function parseFragment(raw: { target: string; from: string; strategy?: string }, brick: string): FragmentSpec {
  const strategy = raw.strategy ?? 'yaml'
  if (strategy !== 'yaml' && strategy !== 'lines') {
    throw new Error(`brick "${brick}": unknown fragment strategy "${strategy}" (expected "yaml" or "lines")`)
  }
  return { target: raw.target, from: raw.from, strategy }
}

export async function loadRegistry(dir: string): Promise<Registry> {
  const slotsRaw = parseToml(await readFile(join(dir, 'slots.toml'), 'utf8')) as {
    slot?: { name: string; single?: boolean }[]
  }
  const slots: SlotDef[] = (slotsRaw.slot ?? []).map((s) => ({ name: s.name, single: s.single ?? true }))
  const slotNames = new Set(slots.map((s) => s.name))

  const entries = await readdir(dir, { withFileTypes: true })
  const bricks = new Map<string, Brick>()

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const brickDir = join(dir, entry.name)
    const raw = parseToml(await readFile(join(brickDir, 'brick.toml'), 'utf8')) as RawBrickFile

    const name = raw.brick?.name
    const slot = raw.brick?.slot
    if (!name) throw new Error(`${entry.name}/brick.toml: missing [brick].name`)
    if (!slot) throw new Error(`${entry.name}/brick.toml: missing [brick].slot`)
    if (name !== entry.name) {
      throw new Error(`brick "${name}" must live in a folder of the same name (found "${entry.name}")`)
    }
    if (!slotNames.has(slot)) {
      throw new Error(`brick "${name}": unknown slot "${slot}" — declare it in slots.toml`)
    }

    bricks.set(name, {
      name,
      slot,
      summary: raw.brick?.summary ?? '',
      dir: brickDir,
      requires: raw.requires ?? {},
      provides: raw.provides?.capabilities ?? [],
      params: raw.params ?? {},
      files: raw.files ?? [],
      fragments: (raw.fragments ?? []).map((f) => parseFragment(f, name)),
      inject: raw.inject ?? [],
    })
  }

  return { bricks, slots }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/tests/registry.test.ts`
Expected: PASS — 3 passed

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.config.ts packages bricks
git commit -m "feat(core): add workspace scaffold and brick registry loader"
```

---

### Task 2: Manifest read/write

**Files:**
- Create: `packages/core/src/manifest.ts`
- Test: `packages/core/tests/manifest.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `ParamBag` from `types.ts`
- Produces: `readManifest(projectDir: string): Promise<Manifest>`, `writeManifest(projectDir: string, m: Manifest): Promise<void>`, `emptyManifest(): Manifest`

- [ ] **Step 1: Write the failing test**

`packages/core/tests/manifest.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyManifest, readManifest, writeManifest } from '../src/manifest.js'

async function tmp() {
  return mkdtemp(join(tmpdir(), 'stacky-manifest-'))
}

describe('manifest', () => {
  it('returns an empty manifest when stack.toml is absent', async () => {
    const dir = await tmp()
    expect(await readManifest(dir)).toEqual({ bricks: {}, overrides: {} })
  })

  it('reads bricks and their params', async () => {
    const dir = await tmp()
    await writeFile(
      join(dir, 'stack.toml'),
      ['[bricks]', 'postgres = { version = "16" }', 'caddy = {}'].join('\n'),
    )
    const m = await readManifest(dir)
    expect(m.bricks).toEqual({ postgres: { version: '16' }, caddy: {} })
  })

  it('reads overrides keyed by target path', async () => {
    const dir = await tmp()
    await writeFile(
      join(dir, 'stack.toml'),
      ['[bricks]', 'postgres = {}', '', '[overrides."ops/compose.yml"]', 'x = "y"'].join('\n'),
    )
    const m = await readManifest(dir)
    expect(m.overrides).toEqual({ 'ops/compose.yml': { x: 'y' } })
  })

  it('round-trips through write and read', async () => {
    const dir = await tmp()
    const m = { bricks: { caddy: { domain: 'example.com' } }, overrides: {} }
    await writeManifest(dir, m)
    expect(await readManifest(dir)).toEqual(m)
  })

  it('writes a banner comment so the file is self-explaining', async () => {
    const dir = await tmp()
    await writeManifest(dir, emptyManifest())
    const text = await readFile(join(dir, 'stack.toml'), 'utf8')
    expect(text.startsWith('# stacky manifest')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/manifest.test.ts`
Expected: FAIL — cannot resolve `../src/manifest.js`

- [ ] **Step 3: Implement `manifest.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/tests/manifest.test.ts`
Expected: PASS — 5 passed

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/manifest.ts packages/core/tests/manifest.test.ts
git commit -m "feat(core): add stack.toml manifest read/write"
```

---

### Task 3: Resolver

**Files:**
- Create: `packages/core/src/errors.ts`, `packages/core/src/resolve.ts`
- Test: `packages/core/tests/resolve.test.ts`

**Interfaces:**
- Consumes: `loadRegistry`, `Manifest`, `Registry`, `ResolveResult`, `ResolutionError`
- Produces: `resolve(manifest: Manifest, registry: Registry): ResolveResult`, `formatError(e: ResolutionError): string`, `exitCodeFor(errors: ResolutionError[]): 1 | 2`

- [ ] **Step 1: Write the failing test**

Add fixture `packages/core/tests/fixtures/resolve/slots.toml`:
```toml
[[slot]]
name = "web"
single = true

[[slot]]
name = "db"
single = true

[[slot]]
name = "cache"
single = true
```

Fixture bricks under `packages/core/tests/fixtures/resolve/`:

`web-a/brick.toml`:
```toml
[brick]
name    = "web-a"
slot    = "web"
summary = "Web A"

[requires]
sql-db = "*"

[params]
title = { type = "string", prompt = "Site title" }
```

`web-b/brick.toml`:
```toml
[brick]
name    = "web-b"
slot    = "web"
summary = "Web B"
```

`pg/brick.toml`:
```toml
[brick]
name    = "pg"
slot    = "db"
summary = "Postgres"

[provides]
capabilities = ["sql-db"]
```

`mysql/brick.toml`:
```toml
[brick]
name    = "mysql"
slot    = "db"
summary = "MySQL"

[provides]
capabilities = ["sql-db"]
```

`needs-cache/brick.toml`:
```toml
[brick]
name    = "needs-cache"
slot    = "cache"
summary = "Requires a capability nobody provides"

[requires]
kv-store = "*"
```

`packages/core/tests/resolve.test.ts`:
```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { loadRegistry } from '../src/registry.js'
import { resolve } from '../src/resolve.js'
import type { Manifest, Registry } from '../src/types.js'

const fixture = fileURLToPath(new URL('./fixtures/resolve', import.meta.url))
let reg: Registry

beforeAll(async () => {
  reg = await loadRegistry(fixture)
})

function manifest(bricks: Manifest['bricks']): Manifest {
  return { bricks, overrides: {} }
}

describe('resolve', () => {
  it('auto-adds the sole provider of a required capability', async () => {
    const regOne = await loadRegistry(fileURLToPath(new URL('./fixtures/resolve-single', import.meta.url)))
    const r = resolve(manifest({ 'web-a': { title: 'x' } }), regOne)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const names = r.graph.bricks.map((b) => b.brick.name)
    expect(names).toContain('pg')
    expect(r.graph.bricks.find((b) => b.brick.name === 'pg')!.inferred).toBe(true)
  })

  it('reports ambiguity when two bricks provide the capability', () => {
    const r = resolve(manifest({ 'web-a': { title: 'x' } }), reg)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContainEqual({
      kind: 'ambiguous',
      capability: 'sql-db',
      candidates: ['mysql', 'pg'],
      requiredBy: 'web-a',
    })
  })

  it('reports unsatisfiable when nothing provides the capability', () => {
    const r = resolve(manifest({ 'needs-cache': {} }), reg)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContainEqual({ kind: 'unsatisfiable', capability: 'kv-store', requiredBy: 'needs-cache' })
  })

  it('reports a slot conflict for two bricks in one single-occupancy slot', () => {
    const r = resolve(manifest({ 'web-a': { title: 'x' }, 'web-b': {} }), reg)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContainEqual({ kind: 'slot-conflict', slot: 'web', bricks: ['web-a', 'web-b'] })
  })

  it('reports unknown bricks with suggestions', () => {
    const r = resolve(manifest({ 'web-c': {} }), reg)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ kind: 'unknown-brick', name: 'web-c' })
    expect((r.errors[0] as { suggestions: string[] }).suggestions).toContain('web-a')
  })

  it('reports a missing required param', () => {
    const r = resolve(manifest({ 'web-a': {}, pg: {} }), reg)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContainEqual({
      kind: 'missing-param',
      brick: 'web-a',
      param: 'title',
      schema: { type: 'string', prompt: 'Site title' },
    })
  })

  it('sorts bricks by slot order then name', () => {
    const r = resolve(manifest({ pg: {}, 'web-b': {} }), reg)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.graph.bricks.map((b) => b.brick.name)).toEqual(['web-b', 'pg'])
  })
})
```

Create `packages/core/tests/fixtures/resolve-single/` as a copy of `resolve/` **without** the `mysql` folder, so `sql-db` has exactly one provider.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/resolve.test.ts`
Expected: FAIL — cannot resolve `../src/resolve.js`

- [ ] **Step 3: Implement `errors.ts`**

```ts
import type { ResolutionError } from './types.js'

export function formatError(e: ResolutionError): string {
  switch (e.kind) {
    case 'ambiguous':
      return `"${e.requiredBy}" needs a "${e.capability}" — candidates: ${e.candidates.join(', ')}. Pick one and add it to stack.toml.`
    case 'unsatisfiable':
      return `"${e.requiredBy}" needs a "${e.capability}" but no brick provides it. Run \`stacky brick new\` to author one.`
    case 'slot-conflict':
      return `Slot "${e.slot}" holds one brick, but got: ${e.bricks.join(', ')}.`
    case 'cycle':
      return `Circular requires: ${e.path.join(' -> ')}.`
    case 'unknown-brick':
      return `Unknown brick "${e.name}".${e.suggestions.length ? ` Did you mean ${e.suggestions.join(' or ')}?` : ''}`
    case 'missing-param':
      return `Brick "${e.brick}" needs param "${e.param}" (${e.schema.type}). Set it with --set ${e.param}=<value>.`
    case 'invalid-param':
      return `Brick "${e.brick}" param "${e.param}": ${e.reason} (got ${JSON.stringify(e.value)}).`
  }
}

/** Exit 2 means "I need input from you"; exit 1 means "this is broken". */
export function exitCodeFor(errors: ResolutionError[]): 1 | 2 {
  const needsInput = errors.every((e) => e.kind === 'ambiguous' || e.kind === 'missing-param')
  return errors.length > 0 && needsInput ? 2 : 1
}
```

- [ ] **Step 4: Implement `resolve.ts`**

```ts
import type {
  Brick, BrickParam, Graph, Manifest, ParamBag, ParamValue,
  Registry, ResolutionError, ResolveResult, ResolvedBrick,
} from './types.js'

/** Character-overlap score; good enough for "did you mean". */
function similarity(a: string, b: string): number {
  const set = new Set(b)
  let hits = 0
  for (const ch of new Set(a)) if (set.has(ch)) hits++
  return hits / Math.max(a.length, b.length)
}

function suggest(name: string, known: string[]): string[] {
  return known.filter((k) => similarity(name, k) > 0.5).slice(0, 3)
}

function checkParams(brick: Brick, supplied: ParamBag, errors: ResolutionError[]): ParamBag {
  const out: ParamBag = {}
  for (const [key, schema] of Object.entries(brick.params)) {
    const value: ParamValue | undefined = supplied[key] ?? (schema.default as ParamValue | undefined)
    if (value === undefined) {
      errors.push({ kind: 'missing-param', brick: brick.name, param: key, schema })
      continue
    }
    const reason = validate(schema, value)
    if (reason) {
      errors.push({ kind: 'invalid-param', brick: brick.name, param: key, value, reason })
      continue
    }
    out[key] = value
  }
  return out
}

function validate(schema: BrickParam, value: ParamValue): string | null {
  if (schema.type === 'boolean' && typeof value !== 'boolean') return 'expected a boolean'
  if (schema.type === 'string' && typeof value !== 'string') return 'expected a string'
  if (schema.type === 'enum') {
    if (typeof value !== 'string') return 'expected a string'
    if (!schema.values?.includes(value)) return `expected one of ${schema.values?.join(', ')}`
  }
  return null
}

export function resolve(manifest: Manifest, registry: Registry): ResolveResult {
  const errors: ResolutionError[] = []
  const selected = new Map<string, ResolvedBrick>()
  const known = [...registry.bricks.keys()]

  const queue: { name: string; inferred: boolean }[] = Object.keys(manifest.bricks).map((name) => ({
    name,
    inferred: false,
  }))
  const seen = new Set<string>()

  while (queue.length > 0) {
    const { name, inferred } = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)

    const brick = registry.bricks.get(name)
    if (!brick) {
      errors.push({ kind: 'unknown-brick', name, suggestions: suggest(name, known) })
      continue
    }

    selected.set(name, { brick, params: checkParams(brick, manifest.bricks[name] ?? {}, errors), inferred })
  }

  // Capability satisfaction. Iterate to a fixed point so inferred bricks' own
  // requires are honoured too.
  for (let pass = 0; pass < 32; pass++) {
    const provided = new Set<string>()
    for (const r of selected.values()) for (const cap of r.brick.provides) provided.add(cap)

    let added = false
    for (const r of [...selected.values()]) {
      for (const cap of Object.keys(r.brick.requires)) {
        if (provided.has(cap)) continue
        const candidates = known.filter((k) => registry.bricks.get(k)!.provides.includes(cap)).sort()
        if (candidates.length === 0) {
          errors.push({ kind: 'unsatisfiable', capability: cap, requiredBy: r.brick.name })
        } else if (candidates.length > 1) {
          errors.push({ kind: 'ambiguous', capability: cap, candidates, requiredBy: r.brick.name })
        } else {
          const only = registry.bricks.get(candidates[0]!)!
          selected.set(only.name, {
            brick: only,
            params: checkParams(only, manifest.bricks[only.name] ?? {}, errors),
            inferred: true,
          })
          added = true
        }
      }
    }
    if (!added) break
  }

  // Slot exclusivity.
  const bySlot = new Map<string, string[]>()
  for (const r of selected.values()) {
    bySlot.set(r.brick.slot, [...(bySlot.get(r.brick.slot) ?? []), r.brick.name])
  }
  for (const slot of registry.slots) {
    const occupants = (bySlot.get(slot.name) ?? []).sort()
    if (slot.single && occupants.length > 1) {
      errors.push({ kind: 'slot-conflict', slot: slot.name, bricks: occupants })
    }
  }

  if (errors.length > 0) return { ok: false, errors: dedupe(errors) }

  // Stable order: slot declaration order, then brick name.
  const slotIndex = new Map(registry.slots.map((s, i) => [s.name, i]))
  const bricks = [...selected.values()].sort((a, b) => {
    const d = (slotIndex.get(a.brick.slot) ?? 0) - (slotIndex.get(b.brick.slot) ?? 0)
    return d !== 0 ? d : a.brick.name.localeCompare(b.brick.name)
  })

  return { ok: true, graph: { bricks } satisfies Graph }
}

function dedupe(errors: ResolutionError[]): ResolutionError[] {
  const seen = new Set<string>()
  return errors.filter((e) => {
    const key = JSON.stringify(e)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/tests/resolve.test.ts`
Expected: PASS — 7 passed

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/resolve.ts packages/core/src/errors.ts packages/core/tests
git commit -m "feat(core): add capability resolver with structured errors"
```

---

### Task 4: Lockfile and drift detection

**Files:**
- Create: `packages/core/src/lockfile.ts`
- Test: `packages/core/tests/lockfile.test.ts`

**Interfaces:**
- Consumes: `Lockfile`, `LockEntry` from `types.ts`
- Produces: `hashContents(s: string): string`, `readLock(projectDir): Promise<Lockfile>`, `writeLock(projectDir, lock): Promise<void>`, `emptyLock(): Lockfile`, `fileState(projectDir, entry): Promise<'clean' | 'modified' | 'missing'>`

- [ ] **Step 1: Write the failing test**

`packages/core/tests/lockfile.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/lockfile.test.ts`
Expected: FAIL — cannot resolve `../src/lockfile.js`

- [ ] **Step 3: Implement `lockfile.ts`**

```ts
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LockEntry, Lockfile } from './types.js'

export function hashContents(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

export function emptyLock(): Lockfile {
  return { version: 1, bricks: {}, files: [] }
}

export async function readLock(projectDir: string): Promise<Lockfile> {
  try {
    return JSON.parse(await readFile(join(projectDir, 'stack.lock'), 'utf8')) as Lockfile
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyLock()
    throw err
  }
}

export async function writeLock(projectDir: string, lock: Lockfile): Promise<void> {
  const sorted: Lockfile = { ...lock, files: [...lock.files].sort((a, b) => a.path.localeCompare(b.path)) }
  await writeFile(join(projectDir, 'stack.lock'), `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
}

export async function fileState(
  projectDir: string,
  entry: LockEntry,
): Promise<'clean' | 'modified' | 'missing'> {
  let actual: string
  try {
    actual = await readFile(join(projectDir, entry.path), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw err
  }
  return hashContents(actual) === entry.hash ? 'clean' : 'modified'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/tests/lockfile.test.ts`
Expected: PASS — 4 passed

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/lockfile.ts packages/core/tests/lockfile.test.ts
git commit -m "feat(core): add lockfile with sha256 drift detection"
```

---

### Task 5: Templating + tier 1 (brick-owned files)

**Files:**
- Create: `packages/core/src/template.ts`, `packages/core/src/plan/tier-brick.ts`
- Test: `packages/core/tests/tier-brick.test.ts`

**Interfaces:**
- Consumes: `ResolvedBrick`, `FileOp`, `Lockfile`, `fileState`, `hashContents`
- Produces: `renderTemplate(source: string, params: ParamBag): string`, `planBrickFiles(graph, ctx): Promise<FileOp[]>`, `PlanContext { projectDir, lock, overrides }`

- [ ] **Step 1: Write the failing test**

`packages/core/tests/tier-brick.test.ts`:
```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRegistry } from '../src/registry.js'
import { resolve } from '../src/resolve.js'
import { emptyLock, hashContents } from '../src/lockfile.js'
import { renderTemplate } from '../src/template.js'
import { planBrickFiles } from '../src/plan/tier-brick.js'
import type { Graph, Registry } from '../src/types.js'

const fixture = fileURLToPath(new URL('./fixtures/registry-basic', import.meta.url))
let graph: Graph
let reg: Registry

beforeAll(async () => {
  reg = await loadRegistry(fixture)
  const r = resolve({ bricks: { alpha: {} }, overrides: {} }, reg)
  if (!r.ok) throw new Error(`fixture must resolve: ${JSON.stringify(r.errors)}`)
  graph = r.graph
})

describe('renderTemplate', () => {
  it('interpolates params', () => {
    expect(renderTemplate('port=<%= it.port %>', { port: '5173' })).toBe('port=5173')
  })
})

describe('planBrickFiles', () => {
  it('emits create for a file not yet on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-t1-'))
    const ops = await planBrickFiles(graph, { projectDir: dir, lock: emptyLock(), overrides: {} })
    expect(ops).toEqual([{ kind: 'create', path: 'app/a.txt', contents: 'alpha\n', owner: 'alpha', tier: 'brick' }])
  })

  it('emits overwrite when the file is on disk and unmodified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-t1-'))
    await mkdir(dirname(join(dir, 'app/a.txt')), { recursive: true })
    await writeFile(join(dir, 'app/a.txt'), 'alpha\n')
    const lock = {
      ...emptyLock(),
      files: [{ path: 'app/a.txt', owner: 'alpha', tier: 'brick' as const, hash: hashContents('alpha\n') }],
    }
    const ops = await planBrickFiles(graph, { projectDir: dir, lock, overrides: {} })
    expect(ops[0]).toMatchObject({ kind: 'overwrite', path: 'app/a.txt' })
  })

  it('emits conflict when the user has edited a brick-owned file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-t1-'))
    await mkdir(dirname(join(dir, 'app/a.txt')), { recursive: true })
    await writeFile(join(dir, 'app/a.txt'), 'I changed this\n')
    const lock = {
      ...emptyLock(),
      files: [{ path: 'app/a.txt', owner: 'alpha', tier: 'brick' as const, hash: hashContents('alpha\n') }],
    }
    const ops = await planBrickFiles(graph, { projectDir: dir, lock, overrides: {} })
    expect(ops).toEqual([
      { kind: 'conflict', path: 'app/a.txt', reason: 'user-modified', contents: 'alpha\n' },
    ])
  })

  it('emits delete for a locked file whose brick left the graph', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-t1-'))
    await mkdir(dirname(join(dir, 'ops/old.conf')), { recursive: true })
    await writeFile(join(dir, 'ops/old.conf'), 'old\n')
    const lock = {
      ...emptyLock(),
      files: [{ path: 'ops/old.conf', owner: 'gone', tier: 'brick' as const, hash: hashContents('old\n') }],
    }
    const ops = await planBrickFiles(graph, { projectDir: dir, lock, overrides: {} })
    expect(ops).toContainEqual({ kind: 'delete', path: 'ops/old.conf', owner: 'gone' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/tier-brick.test.ts`
Expected: FAIL — cannot resolve `../src/template.js`

- [ ] **Step 3: Implement `template.ts`**

```ts
import { Eta } from 'eta'
import type { ParamBag } from './types.js'

const eta = new Eta({ autoEscape: false })

/** Renders `.eta` sources. Params are exposed as `it`, e.g. `<%= it.port %>`. */
export function renderTemplate(source: string, params: ParamBag): string {
  return eta.renderString(source, params)
}
```

- [ ] **Step 4: Implement `plan/tier-brick.ts`**

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileState } from '../lockfile.js'
import { renderTemplate } from '../template.js'
import type { FileOp, Graph, Lockfile } from '../types.js'

export interface PlanContext {
  projectDir: string
  lock: Lockfile
  overrides: Record<string, Record<string, unknown>>
}

export async function planBrickFiles(graph: Graph, ctx: PlanContext): Promise<FileOp[]> {
  const ops: FileOp[] = []
  const wanted = new Set<string>()

  for (const { brick, params } of graph.bricks) {
    for (const spec of brick.files) {
      wanted.add(spec.to)
      const raw = await readFile(join(brick.dir, spec.from), 'utf8')
      const contents = spec.from.endsWith('.eta') ? renderTemplate(raw, params) : raw
      const entry = ctx.lock.files.find((f) => f.path === spec.to)

      if (!entry) {
        ops.push({ kind: 'create', path: spec.to, contents, owner: brick.name, tier: 'brick' })
        continue
      }
      const state = await fileState(ctx.projectDir, entry)
      if (state === 'modified') {
        ops.push({ kind: 'conflict', path: spec.to, reason: 'user-modified', contents })
      } else if (state === 'missing') {
        ops.push({ kind: 'create', path: spec.to, contents, owner: brick.name, tier: 'brick' })
      } else {
        ops.push({
          kind: 'overwrite', path: spec.to, contents, owner: brick.name, tier: 'brick', prevHash: entry.hash,
        })
      }
    }
  }

  // Anything the lock claims as brick-owned that no current brick wants is removed.
  for (const entry of ctx.lock.files) {
    if (entry.tier !== 'brick' || wanted.has(entry.path)) continue
    const state = await fileState(ctx.projectDir, entry)
    if (state === 'modified') ops.push({ kind: 'conflict', path: entry.path, reason: 'user-modified' })
    else if (state === 'clean') ops.push({ kind: 'delete', path: entry.path, owner: entry.owner as string })
  }

  return ops
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/tests/tier-brick.test.ts`
Expected: PASS — 5 passed

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/template.ts packages/core/src/plan packages/core/tests/tier-brick.test.ts
git commit -m "feat(core): add templating and brick-owned file tier"
```

---

### Task 6: Tier 2 — composed files (yaml + lines merge)

**Files:**
- Create: `packages/core/src/merge.ts`, `packages/core/src/plan/tier-composed.ts`
- Test: `packages/core/tests/merge.test.ts`, `packages/core/tests/tier-composed.test.ts`

**Interfaces:**
- Consumes: `PlanContext` from `plan/tier-brick.ts`, `fileState`, `renderTemplate`
- Produces: `deepMerge<T>(a, b): T`, `mergeYaml(fragments: string[]): string`, `mergeLines(fragments: {brick, text}[]): string`, `planComposedFiles(graph, ctx): Promise<FileOp[]>`, `BANNER_YAML`, `BANNER_LINES`

- [ ] **Step 1: Write the failing merge test**

`packages/core/tests/merge.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { deepMerge, mergeLines, mergeYaml } from '../src/merge.js'

describe('deepMerge', () => {
  it('merges nested objects rather than replacing them', () => {
    expect(deepMerge({ a: { x: 1 } }, { a: { y: 2 } })).toEqual({ a: { x: 1, y: 2 } })
  })

  it('lets the right-hand side win on scalars', () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 })
  })

  it('replaces arrays wholesale rather than concatenating', () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] })
  })
})

describe('mergeYaml', () => {
  it('merges service maps from several fragments', () => {
    const out = mergeYaml([
      'services:\n  web:\n    image: node\n',
      'services:\n  db:\n    image: postgres\n',
    ])
    expect(out).toContain('web:')
    expect(out).toContain('db:')
  })

  it('is byte-stable for the same input order', () => {
    const frags = ['services:\n  b:\n    image: b\n', 'services:\n  a:\n    image: a\n']
    expect(mergeYaml(frags)).toBe(mergeYaml(frags))
  })
})

describe('mergeLines', () => {
  it('groups lines under a per-brick comment header', () => {
    const out = mergeLines([
      { brick: 'pg', text: 'DATABASE_URL=\n' },
      { brick: 'caddy', text: 'DOMAIN=\n' },
    ])
    expect(out).toContain('# pg')
    expect(out).toContain('DATABASE_URL=')
    expect(out).toContain('# caddy')
    expect(out).toContain('DOMAIN=')
  })

  it('drops duplicate keys contributed by two bricks', () => {
    const out = mergeLines([
      { brick: 'pg', text: 'SHARED=1\n' },
      { brick: 'redis', text: 'SHARED=1\n' },
    ])
    expect(out.match(/SHARED=1/g)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/merge.test.ts`
Expected: FAIL — cannot resolve `../src/merge.js`

- [ ] **Step 3: Implement `merge.ts`**

```ts
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export const BANNER_YAML = [
  '# Generated by stacky. Do not edit — changes are overwritten on `stacky apply`.',
  '# To customise, add an [overrides."<path>"] block to stack.toml.',
  '',
].join('\n')

export const BANNER_LINES = [
  '# Generated by stacky. Do not edit — changes are overwritten on `stacky apply`.',
  '',
].join('\n')

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Right-hand side wins on scalars and arrays; objects merge recursively. */
export function deepMerge<T>(a: T, b: unknown): T {
  if (!isPlainObject(a) || !isPlainObject(b)) return b as T
  const out: Record<string, unknown> = { ...a }
  for (const [key, value] of Object.entries(b)) {
    out[key] = key in out ? deepMerge(out[key], value) : value
  }
  return out as T
}

/** Merges YAML fragments in the order given. Keys are sorted for byte-stability. */
export function mergeYaml(fragments: string[]): string {
  let acc: Record<string, unknown> = {}
  for (const frag of fragments) {
    const parsed = parseYaml(frag) as unknown
    if (parsed != null) acc = deepMerge(acc, parsed)
  }
  return BANNER_YAML + stringifyYaml(acc, { sortMapEntries: true })
}

/** Merges line-oriented fragments (.env.example, .gitignore) with per-brick headers. */
export function mergeLines(fragments: { brick: string; text: string }[]): string {
  const seen = new Set<string>()
  const blocks: string[] = []

  for (const { brick, text } of fragments) {
    const lines = text
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0 && !seen.has(l))
    for (const l of lines) seen.add(l)
    if (lines.length > 0) blocks.push(`# ${brick}\n${lines.join('\n')}`)
  }

  return `${BANNER_LINES}${blocks.join('\n\n')}\n`
}
```

- [ ] **Step 4: Run merge tests to verify they pass**

Run: `pnpm vitest run packages/core/tests/merge.test.ts`
Expected: PASS — 7 passed

- [ ] **Step 5: Write the failing composed-tier test**

`packages/core/tests/tier-composed.test.ts`:
```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRegistry } from '../src/registry.js'
import { resolve } from '../src/resolve.js'
import { emptyLock } from '../src/lockfile.js'
import { planComposedFiles } from '../src/plan/tier-composed.js'
import type { Graph } from '../src/types.js'

const fixture = fileURLToPath(new URL('./fixtures/registry-basic', import.meta.url))
let graph: Graph

beforeAll(async () => {
  const reg = await loadRegistry(fixture)
  const r = resolve({ bricks: { alpha: {} }, overrides: {} }, reg)
  if (!r.ok) throw new Error('fixture must resolve')
  graph = r.graph
})

describe('planComposedFiles', () => {
  it('emits one compose op per composed target with a banner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-t2-'))
    const ops = await planComposedFiles(graph, { projectDir: dir, lock: emptyLock(), overrides: {} })
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ kind: 'compose', path: 'ops/compose.yml', contributors: ['alpha'] })
    expect((ops[0] as { contents: string }).contents).toContain('Generated by stacky')
    expect((ops[0] as { contents: string }).contents).toContain('alpha:')
  })

  it('applies stack.toml overrides after all fragments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-t2-'))
    const ops = await planComposedFiles(graph, {
      projectDir: dir,
      lock: emptyLock(),
      overrides: { 'ops/compose.yml': { services: { alpha: { image: 'node:24' } } } },
    })
    expect((ops[0] as { contents: string }).contents).toContain('node:24')
    expect((ops[0] as { contents: string }).contents).not.toContain('node:22')
  })

  it('emits delete for a composed file no brick contributes to any more', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-t2-'))
    const lock = {
      ...emptyLock(),
      files: [{ path: 'ops/gone.yml', owner: '@composed' as const, tier: 'composed' as const, hash: 'h' }],
    }
    const ops = await planComposedFiles(graph, { projectDir: dir, lock, overrides: {} })
    expect(ops).toContainEqual({ kind: 'delete', path: 'ops/gone.yml', owner: '@composed' })
  })
})
```

- [ ] **Step 6: Implement `plan/tier-composed.ts`**

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { BANNER_YAML, deepMerge, mergeLines, mergeYaml } from '../merge.js'
import { renderTemplate } from '../template.js'
import type { FileOp, Graph } from '../types.js'
import type { PlanContext } from './tier-brick.js'

interface Contribution { brick: string; text: string; strategy: 'yaml' | 'lines' }

export async function planComposedFiles(graph: Graph, ctx: PlanContext): Promise<FileOp[]> {
  // target path -> contributions, already in graph order (stable)
  const byTarget = new Map<string, Contribution[]>()

  for (const { brick, params } of graph.bricks) {
    for (const spec of brick.fragments) {
      const raw = await readFile(join(brick.dir, spec.from), 'utf8')
      const text = spec.from.endsWith('.eta') ? renderTemplate(raw, params) : raw
      byTarget.set(spec.target, [
        ...(byTarget.get(spec.target) ?? []),
        { brick: brick.name, text, strategy: spec.strategy },
      ])
    }
  }

  const ops: FileOp[] = []

  for (const [target, contributions] of byTarget) {
    const strategy = contributions[0]!.strategy
    let contents =
      strategy === 'yaml'
        ? mergeYaml(contributions.map((c) => c.text))
        : mergeLines(contributions.map((c) => ({ brick: c.brick, text: c.text })))

    const override = ctx.overrides[target]
    if (override) {
      if (strategy !== 'yaml') {
        throw new Error(`overrides for "${target}" require a yaml fragment strategy`)
      }
      const merged = deepMerge(parseYaml(contents) as Record<string, unknown>, override)
      contents = BANNER_YAML + stringifyYaml(merged, { sortMapEntries: true })
    }

    ops.push({ kind: 'compose', path: target, contents, contributors: contributions.map((c) => c.brick) })
  }

  for (const entry of ctx.lock.files) {
    if (entry.tier !== 'composed' || byTarget.has(entry.path)) continue
    ops.push({ kind: 'delete', path: entry.path, owner: '@composed' })
  }

  return ops
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/tests/merge.test.ts packages/core/tests/tier-composed.test.ts`
Expected: PASS — 10 passed

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/merge.ts packages/core/src/plan/tier-composed.ts packages/core/tests
git commit -m "feat(core): add composed file tier with yaml and lines merging"
```

---

### Task 7: Tier 3 — marker injection

**Files:**
- Create: `packages/core/src/plan/tier-inject.ts`
- Test: `packages/core/tests/tier-inject.test.ts`

**Interfaces:**
- Consumes: `PlanContext`, `renderTemplate`
- Produces: `planInjections(graph, ctx): Promise<FileOp[]>`, `applyMarker(host: string, marker: string, body: string): string`, `stripMarker(host: string, marker: string): string`, `markerRegion(marker, comment): {open, close}`

- [ ] **Step 1: Write the failing test**

`packages/core/tests/tier-inject.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { applyMarker, stripMarker } from '../src/plan/tier-inject.js'

const HOST = ['import x from "x"', '', '// >>> stacky:auth', '// <<< stacky:auth', '', 'export const y = 1'].join('\n')

describe('applyMarker', () => {
  it('fills an empty region', () => {
    const out = applyMarker(HOST, 'stacky:auth', 'const a = 1')
    expect(out).toContain('// >>> stacky:auth\nconst a = 1\n// <<< stacky:auth')
  })

  it('replaces existing region content rather than appending', () => {
    const once = applyMarker(HOST, 'stacky:auth', 'const a = 1')
    const twice = applyMarker(once, 'stacky:auth', 'const a = 2')
    expect(twice).toContain('const a = 2')
    expect(twice).not.toContain('const a = 1')
    expect(twice.match(/>>> stacky:auth/g)).toHaveLength(1)
  })

  it('leaves content outside the region untouched', () => {
    const out = applyMarker(HOST, 'stacky:auth', 'const a = 1')
    expect(out).toContain('import x from "x"')
    expect(out).toContain('export const y = 1')
  })

  it('throws when the marker is absent from the host', () => {
    expect(() => applyMarker('no markers here', 'stacky:auth', 'x')).toThrow(/marker "stacky:auth" not found/)
  })
})

describe('stripMarker', () => {
  it('empties the region but keeps the delimiters', () => {
    const filled = applyMarker(HOST, 'stacky:auth', 'const a = 1')
    const stripped = stripMarker(filled, 'stacky:auth')
    expect(stripped).not.toContain('const a = 1')
    expect(stripped).toContain('// >>> stacky:auth')
    expect(stripped).toContain('// <<< stacky:auth')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/tier-inject.test.ts`
Expected: FAIL — cannot resolve `../src/plan/tier-inject.js`

- [ ] **Step 3: Implement `plan/tier-inject.ts`**

```ts
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderTemplate } from '../template.js'
import type { FileOp, Graph } from '../types.js'
import type { PlanContext } from './tier-brick.js'

function region(marker: string): { open: RegExp; openText: string; closeText: string } {
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return {
    open: new RegExp(`([^\\n]*>>>\\s*${esc}[^\\n]*\\n)([\\s\\S]*?)([^\\n]*<<<\\s*${esc}[^\\n]*)`),
    openText: `>>> ${marker}`,
    closeText: `<<< ${marker}`,
  }
}

/** Replaces the body between the marker delimiters. Content outside is untouched. */
export function applyMarker(host: string, marker: string, body: string): string {
  const { open } = region(marker)
  if (!open.test(host)) {
    throw new Error(`marker "${marker}" not found in host file — the owning brick must create it first`)
  }
  const trimmed = body.replace(/\n+$/, '')
  return host.replace(open, (_m, start: string, _mid: string, end: string) =>
    trimmed.length > 0 ? `${start}${trimmed}\n${end}` : `${start}${end}`,
  )
}

export function stripMarker(host: string, marker: string): string {
  return applyMarker(host, marker, '')
}

export async function planInjections(graph: Graph, ctx: PlanContext): Promise<FileOp[]> {
  const ops: FileOp[] = []
  const wanted = new Set<string>()

  for (const { brick, params } of graph.bricks) {
    for (const spec of brick.inject) {
      wanted.add(`${spec.target}#${spec.marker}`)
      const raw = await readFile(join(brick.dir, spec.from), 'utf8')
      const contents = spec.from.endsWith('.eta') ? renderTemplate(raw, params) : raw
      ops.push({ kind: 'inject', path: spec.target, marker: spec.marker, contents, owner: brick.name })
    }
  }

  // A locked injection whose brick is gone gets its region emptied, not deleted —
  // the host file belongs to the user.
  //
  // Note we test for host existence rather than calling fileState: an inject lock entry's
  // hash is of the *injected body*, not of the host file, so fileState would always say
  // "modified" here. Drift inside a marker region is out of scope — the host is the user's.
  for (const entry of ctx.lock.files) {
    if (entry.tier !== 'inject') continue
    const [path, marker] = entry.path.split('#')
    if (!marker || wanted.has(entry.path)) continue
    const hostExists = await access(join(ctx.projectDir, path!)).then(() => true, () => false)
    if (hostExists) {
      ops.push({ kind: 'inject', path: path!, marker, contents: '', owner: entry.owner as string })
    }
  }

  return ops
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/tests/tier-inject.test.ts`
Expected: PASS — 5 passed

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plan/tier-inject.ts packages/core/tests/tier-inject.test.ts
git commit -m "feat(core): add marker injection tier"
```

---

### Task 8: plan() orchestration + apply()

**Files:**
- Create: `packages/core/src/plan/index.ts`, `packages/core/src/apply.ts`, `packages/core/src/index.ts`
- Test: `packages/core/tests/apply.test.ts`

**Interfaces:**
- Consumes: `planBrickFiles`, `planComposedFiles`, `planInjections`, `writeLock`, `hashContents`
- Produces: `plan(graph, ctx): Promise<FileOp[]>`, `apply(ops, projectDir, graph): Promise<Lockfile>`, `hasConflicts(ops): boolean`, and the public barrel `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/tests/apply.test.ts`:
```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, emptyLock, hasConflicts, loadRegistry, plan, readLock, resolve } from '../src/index.js'
import type { Graph } from '../src/types.js'

const fixture = fileURLToPath(new URL('./fixtures/registry-basic', import.meta.url))
let graph: Graph

beforeAll(async () => {
  const reg = await loadRegistry(fixture)
  const r = resolve({ bricks: { alpha: {} }, overrides: {} }, reg)
  if (!r.ok) throw new Error('fixture must resolve')
  graph = r.graph
})

describe('plan + apply', () => {
  it('writes every planned file and records it in the lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-apply-'))
    const ops = await plan(graph, { projectDir: dir, lock: emptyLock(), overrides: {} })
    const lock = await apply(ops, dir, graph)

    expect(await readFile(join(dir, 'app/a.txt'), 'utf8')).toBe('alpha\n')
    expect(await readFile(join(dir, 'ops/compose.yml'), 'utf8')).toContain('alpha:')
    expect(lock.files.map((f) => f.path).sort()).toEqual(['app/a.txt', 'ops/compose.yml'])
    expect(lock.bricks).toHaveProperty('alpha')
    expect(await readLock(dir)).toEqual(lock)
  })

  it('is idempotent — a second apply plans no changes to file contents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-apply-'))
    const first = await plan(graph, { projectDir: dir, lock: emptyLock(), overrides: {} })
    const lock = await apply(first, dir, graph)
    const before = await readFile(join(dir, 'ops/compose.yml'), 'utf8')

    const second = await plan(graph, { projectDir: dir, lock, overrides: {} })
    expect(hasConflicts(second)).toBe(false)
    await apply(second, dir, graph)
    expect(await readFile(join(dir, 'ops/compose.yml'), 'utf8')).toBe(before)
  })

  it('refuses to apply a plan containing a conflict', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-apply-'))
    const ops = [{ kind: 'conflict' as const, path: 'app/a.txt', reason: 'user-modified' as const }]
    expect(hasConflicts(ops)).toBe(true)
    await expect(apply(ops, dir, graph)).rejects.toThrow(/conflict/)
  })

  it('writes a .stacky-new sidecar so a conflict can be diffed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-apply-'))
    const ops = [
      { kind: 'conflict' as const, path: 'app/a.txt', reason: 'user-modified' as const, contents: 'theirs\n' },
    ]
    await expect(apply(ops, dir, graph)).rejects.toThrow(/stacky-new/)
    expect(await readFile(join(dir, 'app/a.txt.stacky-new'), 'utf8')).toBe('theirs\n')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/apply.test.ts`
Expected: FAIL — cannot resolve `../src/index.js`

- [ ] **Step 3: Implement `plan/index.ts`**

```ts
import { planBrickFiles } from './tier-brick.js'
import { planComposedFiles } from './tier-composed.js'
import { planInjections } from './tier-inject.js'
import type { FileOp, Graph } from '../types.js'
import type { PlanContext } from './tier-brick.js'

export type { PlanContext } from './tier-brick.js'

/** Pure: reads brick sources and the project tree, but never writes. */
export async function plan(graph: Graph, ctx: PlanContext): Promise<FileOp[]> {
  return [
    ...(await planBrickFiles(graph, ctx)),
    ...(await planComposedFiles(graph, ctx)),
    ...(await planInjections(graph, ctx)),
  ]
}

export function hasConflicts(ops: FileOp[]): boolean {
  return ops.some((op) => op.kind === 'conflict')
}
```

- [ ] **Step 4: Implement `apply.ts`**

```ts
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hashContents, writeLock } from './lockfile.js'
import { applyMarker } from './plan/tier-inject.js'
import type { FileOp, Graph, LockEntry, Lockfile } from './types.js'

async function put(projectDir: string, rel: string, contents: string): Promise<void> {
  const abs = join(projectDir, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, contents, 'utf8')
}

export async function apply(ops: FileOp[], projectDir: string, graph: Graph): Promise<Lockfile> {
  const conflicts = ops.filter((op) => op.kind === 'conflict')
  if (conflicts.length > 0) {
    // Never clobber, but never leave you stuck either: dump what we would have written
    // next to your version so you can diff it, then refuse to proceed.
    const sidecars: string[] = []
    for (const c of conflicts) {
      if (c.contents === undefined) continue
      await put(projectDir, `${c.path}.stacky-new`, c.contents)
      sidecars.push(`${c.path}.stacky-new`)
    }
    const paths = conflicts.map((c) => c.path).join(', ')
    const hint = sidecars.length > 0 ? ` Wrote ${sidecars.join(', ')} for comparison.` : ''
    throw new Error(
      `refusing to apply: ${conflicts.length} conflict(s) — you have edited ${paths}.${hint}`,
    )
  }

  const files: LockEntry[] = []

  for (const op of ops) {
    switch (op.kind) {
      case 'create':
      case 'overwrite':
        await put(projectDir, op.path, op.contents)
        files.push({ path: op.path, owner: op.owner, tier: op.tier, hash: hashContents(op.contents) })
        break
      case 'compose':
        await put(projectDir, op.path, op.contents)
        files.push({ path: op.path, owner: '@composed', tier: 'composed', hash: hashContents(op.contents) })
        break
      case 'inject': {
        const abs = join(projectDir, op.path)
        const host = await readFile(abs, 'utf8')
        const next = applyMarker(host, op.marker, op.contents)
        await writeFile(abs, next, 'utf8')
        if (op.contents.length > 0) {
          files.push({
            path: `${op.path}#${op.marker}`, owner: op.owner, tier: 'inject', hash: hashContents(op.contents),
          })
        }
        break
      }
      case 'delete':
        await rm(join(projectDir, op.path), { force: true })
        break
      case 'conflict':
        break
    }
  }

  const bricks = Object.fromEntries(graph.bricks.map((b) => [b.brick.name, b.params]))
  const lock: Lockfile = { version: 1, bricks, files }
  await writeLock(projectDir, lock)
  return lock
}
```

Note: injections are applied after brick files in `plan()` ordering, so a host file created
by a brick in the same run already exists on disk by the time its marker is filled.

- [ ] **Step 5: Implement the public barrel `src/index.ts`**

```ts
export type * from './types.js'
export { loadRegistry } from './registry.js'
export { emptyManifest, readManifest, writeManifest } from './manifest.js'
export { resolve } from './resolve.js'
export { exitCodeFor, formatError } from './errors.js'
export { emptyLock, fileState, hashContents, readLock, writeLock } from './lockfile.js'
export { renderTemplate } from './template.js'
export { deepMerge, mergeLines, mergeYaml } from './merge.js'
export { hasConflicts, plan } from './plan/index.js'
export type { PlanContext } from './plan/index.js'
export { applyMarker, stripMarker } from './plan/tier-inject.js'
export { apply } from './apply.js'
```

- [ ] **Step 6: Run the whole core suite**

Run: `pnpm vitest run packages/core`
Expected: PASS — all core tests green

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/plan/index.ts packages/core/src/apply.ts packages/core/src/index.ts packages/core/tests/apply.test.ts
git commit -m "feat(core): add plan orchestration and apply with lockfile output"
```

---

### Task 9: The four real bricks

**Files:**
- Create: `bricks/slots.toml` (replace the Task 1 stub)
- Create: `bricks/sveltekit/`, `bricks/compose/`, `bricks/caddy/`, `bricks/postgres/`
- Test: `packages/core/tests/bricks.test.ts`

**Interfaces:**
- Consumes: `loadRegistry`, `resolve`, `plan`, `apply`
- Produces: a real registry at `bricks/` that resolves without errors

- [ ] **Step 1: Write `bricks/slots.toml`**

```toml
# Slot order here IS the merge order for composed files. Changing it rewrites diffs.
[[slot]]
name = "container"
single = true

[[slot]]
name = "web"
single = true

[[slot]]
name = "edge"
single = true

[[slot]]
name = "db"
single = true
```

- [ ] **Step 2: Write the `compose` brick**

`bricks/compose/brick.toml`:
```toml
[brick]
name    = "compose"
slot    = "container"
summary = "Docker Compose base — every containerised brick contributes services here"

[provides]
capabilities = ["container-runtime"]

[[fragments]]
target   = "ops/compose.yml"
from     = "fragments/base.yaml"
strategy = "yaml"

[[fragments]]
target   = "config/.env.example"
from     = "fragments/env"
strategy = "lines"
```

`bricks/compose/fragments/base.yaml`:
```yaml
name: stacky-app
services: {}
networks:
  app:
    driver: bridge
```

`bricks/compose/fragments/env`:
```
COMPOSE_PROJECT_NAME=stacky-app
```

- [ ] **Step 3: Write the `sveltekit` brick**

`bricks/sveltekit/brick.toml`:
```toml
[brick]
name    = "sveltekit"
slot    = "web"
summary = "SvelteKit app with a hooks.server.ts carrying stacky marker regions"

[requires]
container-runtime = "*"

[provides]
capabilities = ["ssr", "http-origin"]

[params]
port = { type = "string", default = "5173" }

[[files]]
from = "files/hooks.server.ts"
to   = "app/src/hooks.server.ts"

[[files]]
from = "files/Dockerfile.eta"
to   = "app/Dockerfile"

[[fragments]]
target   = "ops/compose.yml"
from     = "fragments/compose.yaml.eta"
strategy = "yaml"

[[fragments]]
target   = "config/.env.example"
from     = "fragments/env.eta"
strategy = "lines"
```

`bricks/sveltekit/files/hooks.server.ts`:
```ts
import type { Handle } from '@sveltejs/kit'

// >>> stacky:server-init
// <<< stacky:server-init

export const handle: Handle = async ({ event, resolve }) => {
  return resolve(event)
}
```

`bricks/sveltekit/files/Dockerfile.eta`:
```
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE <%= it.port %>
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "<%= it.port %>"]
```

`bricks/sveltekit/fragments/compose.yaml.eta`:
```
services:
  web:
    build: ../app
    ports:
      - "<%= it.port %>:<%= it.port %>"
    networks:
      - app
```

`bricks/sveltekit/fragments/env.eta`:
```
PUBLIC_APP_PORT=<%= it.port %>
```

- [ ] **Step 4: Write the `caddy` brick**

`bricks/caddy/brick.toml`:
```toml
[brick]
name    = "caddy"
slot    = "edge"
summary = "Caddy reverse proxy in front of the app"

[requires]
http-origin       = "*"
container-runtime = "*"

[provides]
capabilities = ["http-edge"]

[params]
domain = { type = "string", default = "localhost" }

[[files]]
from = "files/Caddyfile.eta"
to   = "ops/caddy/Caddyfile"

[[fragments]]
target   = "ops/compose.yml"
from     = "fragments/compose.yaml"
strategy = "yaml"

[[fragments]]
target   = "config/.env.example"
from     = "fragments/env.eta"
strategy = "lines"
```

`bricks/caddy/files/Caddyfile.eta`:
```
<%= it.domain %> {
	reverse_proxy web:5173
}
```

`bricks/caddy/fragments/compose.yaml`:
```yaml
services:
  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
    depends_on:
      - web
    networks:
      - app
```

`bricks/caddy/fragments/env.eta`:
```
CADDY_DOMAIN=<%= it.domain %>
```

- [ ] **Step 5: Write the `postgres` brick**

`bricks/postgres/brick.toml`:
```toml
[brick]
name    = "postgres"
slot    = "db"
summary = "Postgres service, connection helper, and a migrations folder"

[requires]
container-runtime = "*"

[provides]
capabilities = ["sql-db"]

[params]
version = { type = "string", default = "16" }

[[files]]
from = "files/0001_init.sql"
to   = "db/migrations/0001_init.sql"

[[fragments]]
target   = "ops/compose.yml"
from     = "fragments/compose.yaml.eta"
strategy = "yaml"

[[fragments]]
target   = "config/.env.example"
from     = "fragments/env"
strategy = "lines"

[[inject]]
target = "app/src/hooks.server.ts"
marker = "stacky:server-init"
from   = "fragments/server-init.ts"
```

`bricks/postgres/files/0001_init.sql`:
```sql
-- initial migration
create table if not exists health (
  id integer primary key,
  checked_at timestamptz not null default now()
);
```

`bricks/postgres/fragments/compose.yaml.eta`:
```
services:
  postgres:
    image: postgres:<%= it.version %>-alpine
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - app
volumes:
  pgdata: {}
```

`bricks/postgres/fragments/env`:
```
POSTGRES_PASSWORD=change-me
DATABASE_URL=postgres://postgres:change-me@postgres:5432/postgres
```

`bricks/postgres/fragments/server-init.ts`:
```ts
import { DATABASE_URL } from '$env/static/private'
export const dbUrl = DATABASE_URL
```

- [ ] **Step 6: Write the registry integration test**

`packages/core/tests/bricks.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, emptyLock, loadRegistry, plan, resolve } from '../src/index.js'

const bricksDir = fileURLToPath(new URL('../../../bricks', import.meta.url))

describe('real registry', () => {
  it('loads all four bricks', async () => {
    const reg = await loadRegistry(bricksDir)
    expect([...reg.bricks.keys()].sort()).toEqual(['caddy', 'compose', 'postgres', 'sveltekit'])
  })

  it('resolves the full stack and infers container-runtime', async () => {
    const reg = await loadRegistry(bricksDir)
    const r = resolve({ bricks: { sveltekit: {}, caddy: {}, postgres: {} }, overrides: {} }, reg)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.graph.bricks.map((b) => b.brick.name)).toEqual(['compose', 'sveltekit', 'caddy', 'postgres'])
  })

  it('applies the full stack to a temp dir', async () => {
    const reg = await loadRegistry(bricksDir)
    const r = resolve({ bricks: { sveltekit: {}, caddy: {}, postgres: {} }, overrides: {} }, reg)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    const dir = await mkdtemp(join(tmpdir(), 'stacky-real-'))
    const ops = await plan(r.graph, { projectDir: dir, lock: emptyLock(), overrides: {} })
    await apply(ops, dir, r.graph)

    const compose = await readFile(join(dir, 'ops/compose.yml'), 'utf8')
    expect(compose).toContain('caddy:')
    expect(compose).toContain('postgres:')
    expect(compose).toContain('web:')

    const hooks = await readFile(join(dir, 'app/src/hooks.server.ts'), 'utf8')
    expect(hooks).toContain('DATABASE_URL')
    expect(hooks).toContain('>>> stacky:server-init')
  })
})
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/tests/bricks.test.ts`
Expected: PASS — 3 passed

- [ ] **Step 8: Commit**

```bash
git add bricks packages/core/tests/bricks.test.ts
git commit -m "feat(bricks): add sveltekit, compose, caddy and postgres bricks"
```

---

### Task 10: CLI

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`
- Create: `packages/cli/src/index.ts`, `packages/cli/src/git.ts`
- Create: `packages/cli/src/commands/{init,add,remove,plan,apply,list}.ts`
- Create: `packages/cli/src/render/{diff,json}.ts`
- Test: `packages/cli/tests/cli.test.ts`

**Interfaces:**
- Consumes: the entire `@stacky/core` barrel
- Produces: a `stacky` binary; `runCli(argv: string[]): Promise<number>` returning the exit code

- [ ] **Step 1: Scaffold the CLI package**

`packages/cli/package.json`:
```json
{
  "name": "@stacky/cli",
  "version": "0.0.0",
  "type": "module",
  "bin": { "stacky": "./src/index.ts" },
  "dependencies": {
    "@stacky/core": "workspace:*",
    "cac": "^7.0.0"
  }
}
```

`packages/cli/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "references": [{ "path": "../core" }]
}
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing CLI test**

`packages/cli/tests/cli.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
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

  it('exits 1 for an unknown brick', async () => {
    const dir = await project()
    expect(await runCli(argv(dir, 'add', 'nope'))).toBe(1)
  })

  it('remove reverses add', async () => {
    const dir = await project()
    await runCli(argv(dir, 'add', 'postgres'))
    expect(await runCli(argv(dir, 'remove', 'postgres'))).toBe(0)
    expect(await readFile(join(dir, 'stack.toml'), 'utf8')).not.toContain('postgres')
  })

  it('plan writes nothing to disk', async () => {
    const dir = await project()
    await runCli(argv(dir, 'add', 'postgres'))
    const before = await readFile(join(dir, 'ops/compose.yml'), 'utf8')
    expect(await runCli(argv(dir, 'plan'))).toBe(0)
    expect(await readFile(join(dir, 'ops/compose.yml'), 'utf8')).toBe(before)
  })

  it('refuses to apply into a dirty git worktree unless --allow-dirty', async () => {
    const dir = await project()
    await run('git', ['init'], { cwd: dir })
    await writeFile(join(dir, 'untracked.txt'), 'work in progress')

    expect(await runCli(argv(dir, 'add', 'postgres'))).toBe(1)
    expect(await runCli([...argv(dir, 'add', 'postgres'), '--allow-dirty'])).toBe(0)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/cli`
Expected: FAIL — cannot resolve `../src/index.js`

- [ ] **Step 4: Implement `git.ts`, `render/json.ts` and `render/diff.ts`**

`packages/cli/src/git.ts`:
```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** True if `dir` is a git repo with uncommitted changes. A non-repo is never "dirty". */
export async function isDirty(dir: string): Promise<boolean> {
  try {
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: dir })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}
```

`packages/cli/src/render/json.ts`:
```ts
import type { FileOp, ResolutionError } from '@stacky/core'

export function jsonPlan(ops: FileOp[]): string {
  return JSON.stringify({ ok: true, ops }, null, 2)
}

export function jsonErrors(errors: ResolutionError[]): string {
  return JSON.stringify({ ok: false, errors }, null, 2)
}
```

`packages/cli/src/render/diff.ts`:
```ts
import type { FileOp } from '@stacky/core'

const SIGIL: Record<FileOp['kind'], string> = {
  create: '+', overwrite: '~', compose: '~', inject: '>', delete: '-', conflict: '!',
}

export function renderPlan(ops: FileOp[]): string {
  if (ops.length === 0) return 'Nothing to do — the project already matches stack.toml.'
  return ops
    .map((op) => {
      const detail =
        op.kind === 'compose' ? ` (from ${op.contributors.join(', ')})`
        : op.kind === 'inject' ? ` [${op.marker}]`
        : op.kind === 'conflict' ? '  <- you edited this; stacky will not touch it'
        : ''
      return `  ${SIGIL[op.kind]} ${op.path}${detail}`
    })
    .join('\n')
}
```

- [ ] **Step 5: Implement the commands**

`packages/cli/src/commands/apply.ts` (shared engine used by `add`, `remove`, `apply`, `plan`):
```ts
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
```

`packages/cli/src/commands/add.ts`:
```ts
import { readManifest, writeManifest } from '@stacky/core'
import { runPlanApply, type RunOpts } from './apply.js'
import type { ParamBag } from '@stacky/core'

export async function add(name: string, params: ParamBag, opts: RunOpts): Promise<number> {
  const manifest = await readManifest(opts.cwd)
  manifest.bricks[name] = { ...(manifest.bricks[name] ?? {}), ...params }
  await writeManifest(opts.cwd, manifest)
  return runPlanApply(opts)
}
```

`packages/cli/src/commands/remove.ts`:
```ts
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
```

`packages/cli/src/commands/init.ts`:
```ts
import { emptyManifest, writeManifest } from '@stacky/core'

export async function init(cwd: string): Promise<number> {
  await writeManifest(cwd, emptyManifest())
  console.log(`Initialised stack.toml in ${cwd}. Add a brick with \`stacky add <name>\`.`)
  return 0
}
```

`packages/cli/src/commands/list.ts`:
```ts
import { loadRegistry } from '@stacky/core'

export async function list(registryDir: string, json: boolean): Promise<number> {
  const reg = await loadRegistry(registryDir)
  const rows = [...reg.bricks.values()].map((b) => ({
    name: b.name, slot: b.slot, summary: b.summary,
    provides: b.provides, requires: Object.keys(b.requires),
  }))
  console.log(json ? JSON.stringify(rows, null, 2)
    : rows.map((r) => `  ${r.name.padEnd(12)} ${r.slot.padEnd(10)} ${r.summary}`).join('\n'))
  return 0
}
```

- [ ] **Step 6: Implement `src/index.ts`**

```ts
#!/usr/bin/env node
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
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run packages/cli`
Expected: PASS — 6 passed

- [ ] **Step 8: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add init, add, remove, plan, apply and list commands"
```

---

### Task 11: Round-trip property test (acceptance gate)

**Files:**
- Create: `packages/core/tests/round-trip.test.ts`
- Create: `packages/core/tests/helpers/tree.ts`
- Create (generated, then committed): `packages/core/tests/golden/full-stack.compose.yml`, `packages/core/tests/golden/full-stack.env.example`

**Interfaces:**
- Consumes: `loadRegistry`, `resolve`, `plan`, `apply`
- Produces: `snapshotTree(dir): Promise<Record<string, string>>` — path → sha256, excluding `.git`

This is the gate for phase 1. If it fails for any brick, the ownership model is wrong and
that is a design problem, not a test problem — stop and report rather than weakening the test.

- [ ] **Step 1: Write the tree helper**

`packages/core/tests/helpers/tree.ts`:
```ts
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { hashContents } from '../../src/lockfile.js'

/** path -> content hash, for every file under dir except .git. */
export async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}

  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const abs = join(current, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else out[relative(dir, abs)] = hashContents(await readFile(abs, 'utf8'))
    }
  }

  await walk(dir)
  return out
}
```

- [ ] **Step 2: Write the failing round-trip test**

`packages/core/tests/round-trip.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, loadRegistry, plan, readLock, readManifest, resolve, writeManifest } from '../src/index.js'
import { snapshotTree } from './helpers/tree.js'
import type { Manifest } from '../src/types.js'

const bricksDir = fileURLToPath(new URL('../../../bricks', import.meta.url))

/** Converge a project directory onto a manifest. */
async function converge(dir: string, manifest: Manifest) {
  const registry = await loadRegistry(bricksDir)
  await writeManifest(dir, manifest)
  const r = resolve(manifest, registry)
  if (!r.ok) throw new Error(`resolve failed: ${JSON.stringify(r.errors)}`)
  const lock = await readLock(dir)
  const ops = await plan(r.graph, { projectDir: dir, lock, overrides: manifest.overrides })
  await apply(ops, dir, r.graph)
}

const BASE: Manifest = { bricks: { sveltekit: {} }, overrides: {} }

describe('round trip', () => {
  for (const brick of ['caddy', 'postgres']) {
    it(`add ${brick} then remove ${brick} restores the tree byte for byte`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `stacky-rt-${brick}-`))

      await converge(dir, structuredClone(BASE))
      const before = await snapshotTree(dir)

      await converge(dir, { bricks: { ...BASE.bricks, [brick]: {} }, overrides: {} })
      const during = await snapshotTree(dir)
      expect(Object.keys(during).length).toBeGreaterThan(Object.keys(before).length)

      await converge(dir, structuredClone(BASE))
      const after = await snapshotTree(dir)

      expect(after).toEqual(before)
    })
  }

  it('applying the same manifest twice changes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-rt-idem-'))
    const full: Manifest = { bricks: { sveltekit: {}, caddy: {}, postgres: {} }, overrides: {} }
    await converge(dir, structuredClone(full))
    const first = await snapshotTree(dir)
    await converge(dir, structuredClone(full))
    expect(await snapshotTree(dir)).toEqual(first)
  })

  it('a removed brick leaves no orphan files behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-rt-orphan-'))
    await converge(dir, { bricks: { sveltekit: {}, postgres: {} }, overrides: {} })
    await converge(dir, structuredClone(BASE))
    const paths = Object.keys(await snapshotTree(dir))
    expect(paths.filter((p) => p.startsWith('db/'))).toEqual([])
    const manifest = await readManifest(dir)
    expect(manifest.bricks).not.toHaveProperty('postgres')
  })
})
```

- [ ] **Step 3: Run test to verify it fails or passes**

Run: `pnpm vitest run packages/core/tests/round-trip.test.ts`
Expected: PASS — 4 passed.

If `after` differs from `before`, inspect the diff. The two likely causes are (a) a composed
file whose merge is not order-stable, or (b) an injected marker region that was filled but not
emptied on removal. Fix the tier, not the test.

- [ ] **Step 4: Add the golden-file test**

The round-trip test proves output is *reversible*; this one proves it is *stable*. Without it,
a change to slot order or merge strategy silently rewrites every generated file and the only
symptom is an enormous diff in a real project weeks later.

Append to `packages/core/tests/round-trip.test.ts`:
```ts
describe('golden files', () => {
  it('the full stack produces the committed compose file byte for byte', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-golden-'))
    await converge(dir, { bricks: { sveltekit: {}, caddy: {}, postgres: {} }, overrides: {} })
    const compose = await readFile(join(dir, 'ops/compose.yml'), 'utf8')
    await expect(compose).toMatchFileSnapshot('./golden/full-stack.compose.yml')
  })

  it('the full stack produces the committed env example byte for byte', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-golden-'))
    await converge(dir, { bricks: { sveltekit: {}, caddy: {}, postgres: {} }, overrides: {} })
    const env = await readFile(join(dir, 'config/.env.example'), 'utf8')
    await expect(env).toMatchFileSnapshot('./golden/full-stack.env.example')
  })
})
```

Add `readFile` to the `node:fs/promises` import at the top of the file.

- [ ] **Step 5: Generate and review the golden files**

Run: `pnpm vitest run packages/core/tests/round-trip.test.ts -u`
Expected: PASS, creating `packages/core/tests/golden/full-stack.compose.yml` and
`packages/core/tests/golden/full-stack.env.example`.

Open both and read them as if you were the developer receiving this project. The compose file
must list `caddy`, `postgres` and `web` services on the shared `app` network; the env example
must group variables under per-brick comments with no duplicate keys. If either looks wrong,
fix the brick — do not accept a bad snapshot.

- [ ] **Step 6: Re-run without `-u` to confirm the snapshots are stable**

Run: `pnpm vitest run packages/core/tests/round-trip.test.ts`
Expected: PASS — 6 passed, no snapshot writes

- [ ] **Step 7: Commit**

```bash
git add packages/core/tests/round-trip.test.ts packages/core/tests/helpers/tree.ts packages/core/tests/golden
git commit -m "test(core): add round-trip acceptance gate and golden files"
```

---

### Task 12: Artifact validation + docs

**Files:**
- Create: `packages/core/tests/artifacts.test.ts`
- Create: `AGENTS.md`
- Modify: `package.json` (add `test:artifacts` script)

**Interfaces:**
- Consumes: everything
- Produces: no new API — validation only

- [ ] **Step 1: Write the artifact validation test**

`packages/core/tests/artifacts.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the artifact tests**

Run: `pnpm vitest run packages/core/tests/artifacts.test.ts`
Expected: PASS (or SKIPPED where `docker` / `caddy` are absent — skips are acceptable locally, but both must run in CI)

- [ ] **Step 3: Write `AGENTS.md`**

```markdown
# Working in this repo

`stacky` composes project stacks from bricks. Read
`docs/superpowers/specs/2026-07-22-stacky-composable-stack-cli-design.md` for the full design.

## Authoring a brick

A brick is a folder under `bricks/` containing `brick.toml` plus its payload. The folder name
must equal `[brick].name`, and `[brick].slot` must be declared in `bricks/slots.toml`.

Every file a brick writes falls into exactly one of three tiers:

| Tier | Section | Ownership | Removal |
|---|---|---|---|
| Brick-owned | `[[files]]` | the brick | file is deleted |
| Composed | `[[fragments]]` | stacky, merged from all bricks | contribution disappears on regenerate |
| Injected | `[[inject]]` | the user; brick owns one marker region | region is emptied |

Files ending `.eta` are rendered with the brick's `params` exposed as `it`
(e.g. `<%= it.port %>`). Everything else is copied byte-for-byte.

`[[fragments]]` take `strategy = "yaml"` (deep-merged, keys sorted) or `strategy = "lines"`
(deduplicated, grouped under a per-brick comment). A brick that injects into a marker must not
also create the host file unless it owns it — the host's owner declares the marker region.

## Rules

- `packages/core` never imports from `packages/cli`.
- `resolve()` and `plan()` are pure. Only `apply()` writes to disk.
- `resolve()` never prompts. Ambiguity is returned as data, not resolved.
- Composed output must be byte-stable for an unchanged manifest.
- Every new brick must pass the round-trip test in
  `packages/core/tests/round-trip.test.ts` — add it to the brick list there.

## Commands

```bash
pnpm test              # full suite
pnpm typecheck         # tsc -b
node packages/cli/src/index.ts list
node packages/cli/src/index.ts add postgres --cwd /path/to/project
```
```

- [ ] **Step 4: Add the artifacts script to the root `package.json`**

Replace the `scripts` block with:
```json
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:artifacts": "vitest run packages/core/tests/artifacts.test.ts",
    "typecheck": "tsc -b"
  },
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean, all tests PASS

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md package.json packages/core/tests/artifacts.test.ts
git commit -m "test(core): validate generated artifacts and document brick authoring"
```
