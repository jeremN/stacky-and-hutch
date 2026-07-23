# Stacky Phase 2a — Multi-Framework / Vite Barebone Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the brick registry so the composer is no longer locked to SvelteKit — extract a shared Vite build base, add capability-named injection points, and prove framework portability with a second framework (TanStack Start).

**Architecture:** Bricks move into `bricks/<concern>/<name>/` (concern = slot = registry group = output root). A new `build/vite` brick owns the build/Docker/Compose-web foundation; framework bricks layer onto it by injecting into a named `vite-plugins` seam and publishing a `server-init` seam. DB bricks inject into `server-init` by *name*, resolved through the existing capability graph (publishing a point ≡ providing `inject:<name>`, consuming ≡ requiring it). `app/package.json` becomes a composed file via a new `json` merge strategy. The gate is the round-trip property, run against both framework stacks with the same DB bricks.

**Tech Stack:** TypeScript (strict, ESM), Node ≥22, pnpm workspace, vitest, smol-toml, yaml, eta, cac, tsup (new, CLI build).

## Global Constraints

- **Node ≥22, ESM only** (`"type": "module"`), TypeScript strict; **no `any` in `@stacky/core`**.
- **Purity:** `resolve()` and `plan()` never write; `apply()` is the only writer.
- **Byte-stability:** composed output must be deterministic for an unchanged manifest — stable brick order is `(slot declaration order, brick name)`; yaml sorts keys via `sortMapEntries: true`; json sorts keys recursively.
- **Three-tier ownership:** every path has exactly one owner — brick-owned (`[[files]]`, deleted on removal), composed (`[[fragments]]`, regenerated), marker-injected (`[[inject]]`, region emptied). Injection is now *aggregating*: multiple bricks may contribute to one marker; the region is regenerated from all current contributors.
- **Injection points ride the capability graph:** publishing point `N` ≡ providing capability `inject:N` (carrying `{target, marker}`); a point-based `[[inject]]` ≡ requiring `inject:N`.
- **Generated repos carry zero dependency on stacky.** Bricks emit plain files; the app runs under standard tooling.
- **Slot order in `bricks/slots.toml` is load-bearing** (it is the fragment-merge tiebreaker). Final order: `container, build, web, edge, db`.
- **The registry lives at repo-root `bricks/`.** `@stacky/cli` resolves it as `../../../bricks` relative to its entry file — this path must stay valid from the built output.

**Spec:** `docs/superpowers/specs/2026-07-23-stacky-phase-2a-multiframework-design.md`

**Note on two spec corrections discovered during planning (both fold into the tasks below):**
1. Phase 1's inject tier does *not* actually merge multiple contributors under one marker — it clobbers (last-writer-wins). Task 5 implements the aggregation the spec assumed existed.
2. To keep `db` single-occupancy semantics while hosting both `postgres` (engine) and `drizzle` (ORM), the `db` slot is made **multi-occupancy** (`single = false`); two engines are still caught by capability ambiguity when an ORM consumes `sql-db`. Set in Task 6.

---

### Task 1: Two-level registry glob + relocate bricks and fixtures

Move every brick into a `<concern>/<name>/` folder and teach `loadRegistry` to read two levels. Pure relocation + loader change; all existing tests stay green (brick names and slots are unchanged, only their folders move).

**Files:**
- Modify: `packages/core/src/registry.ts` (the `loadRegistry` scan loop)
- Move (real bricks): `bricks/compose/`→`bricks/container/compose/`, `bricks/sveltekit/`→`bricks/web/sveltekit/`, `bricks/caddy/`→`bricks/edge/caddy/`, `bricks/postgres/`→`bricks/db/postgres/`
- Move (fixtures): each `fixtures/<reg>/<brick>/` → `fixtures/<reg>/<slot>/<brick>/` per the map below
- Test: `packages/core/tests/registry.test.ts` (unchanged — must still pass)

**Interfaces:**
- Consumes: nothing new.
- Produces: `loadRegistry(dir)` now expects `dir/<concern>/<name>/brick.toml` (two levels). Concern folder name is organizational, not validated; the brick's declared `slot` still governs. Directories without a `brick.toml` are skipped.

- [ ] **Step 1: Relocate the four real bricks (folders move whole, contents unchanged)**

```bash
mkdir -p bricks/container bricks/web bricks/edge bricks/db
git mv bricks/compose   bricks/container/compose
git mv bricks/sveltekit bricks/web/sveltekit
git mv bricks/caddy     bricks/edge/caddy
git mv bricks/postgres  bricks/db/postgres
```

- [ ] **Step 2: Relocate the test fixtures under slot-named concern folders**

```bash
cd packages/core/tests/fixtures
# registry-basic: alpha(web), beta(db)
mkdir -p registry-basic/web registry-basic/db
git mv registry-basic/alpha registry-basic/web/alpha
git mv registry-basic/beta  registry-basic/db/beta
# registry-bad-slot: beta(slot "cache", intentionally undeclared) — concern folder name is arbitrary
mkdir -p registry-bad-slot/cache
git mv registry-bad-slot/beta registry-bad-slot/cache/beta
# resolve: web-a(web) web-b(web) pg(db) mysql(db) needs-cache(cache)
mkdir -p resolve/web resolve/db resolve/cache
git mv resolve/web-a resolve/web/web-a
git mv resolve/web-b resolve/web/web-b
git mv resolve/pg    resolve/db/pg
git mv resolve/mysql resolve/db/mysql
git mv resolve/needs-cache resolve/cache/needs-cache
# resolve-single: web-a(web) web-b(web) pg(db) needs-cache(cache)
mkdir -p resolve-single/web resolve-single/db resolve-single/cache
git mv resolve-single/web-a resolve-single/web/web-a
git mv resolve-single/web-b resolve-single/web/web-b
git mv resolve-single/pg    resolve-single/db/pg
git mv resolve-single/needs-cache resolve-single/cache/needs-cache
cd -
```

- [ ] **Step 3: Run the registry test to see it fail (loader still expects one level)**

Run: `pnpm vitest run packages/core/tests/registry.test.ts`
Expected: FAIL — `loadRegistry` no longer finds bricks (it reads the concern dirs as if they were bricks and can't find their `brick.toml`).

- [ ] **Step 4: Rewrite the `loadRegistry` scan loop to descend two levels**

Replace the scan loop in `packages/core/src/registry.ts` (the block from `const entries = await readdir(...)` through the closing `}` of the `for (const entry of entries)` loop) with:

```ts
  const bricks = new Map<string, Brick>()

  for (const concern of await readdir(dir, { withFileTypes: true })) {
    if (!concern.isDirectory()) continue
    const concernDir = join(dir, concern.name)

    for (const entry of await readdir(concernDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const brickDir = join(concernDir, entry.name)

      let text: string
      try {
        text = await readFile(join(brickDir, 'brick.toml'), 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw err
      }
      const raw = parseToml(text) as RawBrickFile

      const name = raw.brick?.name
      const slot = raw.brick?.slot
      if (!name) throw new Error(`${concern.name}/${entry.name}/brick.toml: missing [brick].name`)
      if (!slot) throw new Error(`${concern.name}/${entry.name}/brick.toml: missing [brick].slot`)
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
  }
```

- [ ] **Step 5: Run the full suite — everything green again**

Run: `pnpm vitest run`
Expected: PASS (same count as before: 68 passing / 1 skipped). `registry.test.ts` asserts slots `['container','web','db']` and `alpha` in slot `web`; both still hold after relocation.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm tsc -b`
Expected: clean.

```bash
git add -A
git commit -m "refactor(registry): read bricks from two-level concern folders"
```

---

### Task 2: `json` merge strategy for composed files

Add a third fragment strategy so `app/package.json` can be composed from multiple bricks. Deep-merge JSON objects, sort keys recursively for byte-stability, and carry the generated banner as a `"//"` key (JSON forbids comments; npm tolerates a `"//"` key). Extend overrides to json too.

**Files:**
- Modify: `packages/core/src/merge.ts` (add `mergeJson`, `stringifyJson`, `BANNER_JSON`)
- Modify: `packages/core/src/types.ts` (`FragmentSpec.strategy` gains `'json'`)
- Modify: `packages/core/src/registry.ts` (`parseFragment` accepts `'json'`)
- Modify: `packages/core/src/plan/tier-composed.ts` (dispatch json; json override path)
- Modify: `packages/core/src/index.ts` (export `mergeJson`)
- Test: `packages/core/tests/merge.test.ts`, `packages/core/tests/tier-composed.test.ts`

**Interfaces:**
- Consumes: `deepMerge` (existing).
- Produces:
  - `mergeJson(fragments: string[]): string` — parse each fragment as JSON, deep-merge in order, prepend a `"//"` banner key, serialize sorted with a trailing newline.
  - `stringifyJson(value: unknown): string` — recursively key-sorted `JSON.stringify(…, null, 2)` + `\n`.
  - `FragmentSpec.strategy: 'yaml' | 'lines' | 'json'`.

- [ ] **Step 1: Write failing tests for `mergeJson`**

Append to `packages/core/tests/merge.test.ts` (and update the import on line 2):

```ts
// line 2 becomes:
import { deepMerge, mergeJson, mergeLines, mergeYaml, stringifyJson } from '../src/merge.js'
```

```ts
describe('mergeJson', () => {
  it('deep-merges contributors and sorts keys, order-independent for disjoint keys', () => {
    const a = JSON.stringify({ scripts: { dev: 'vite dev' }, devDependencies: { vite: '^6.0.0' } })
    const b = JSON.stringify({ scripts: { check: 'svelte-check' }, devDependencies: { svelte: '^5.0.0' } })
    expect(mergeJson([a, b])).toBe(mergeJson([b, a]))
    const parsed = JSON.parse(mergeJson([a, b]))
    expect(parsed.scripts).toEqual({ check: 'svelte-check', dev: 'vite dev' })
    expect(parsed.devDependencies).toEqual({ svelte: '^5.0.0', vite: '^6.0.0' })
  })

  it('carries a "//" banner key and a trailing newline', () => {
    const out = mergeJson([JSON.stringify({ name: 'app' })])
    expect(JSON.parse(out)['//']).toContain('Generated by stacky')
    expect(out.endsWith('\n')).toBe(true)
  })

  it('lets the later contributor win on a scalar conflict', () => {
    const out = mergeJson([JSON.stringify({ type: 'commonjs' }), JSON.stringify({ type: 'module' })])
    expect(JSON.parse(out).type).toBe('module')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/core/tests/merge.test.ts`
Expected: FAIL — `mergeJson`/`stringifyJson` not exported.

- [ ] **Step 3: Implement `mergeJson` and `stringifyJson` in `merge.ts`**

Add to `packages/core/src/merge.ts` (after `BANNER_LINES`):

```ts
export const BANNER_JSON =
  'Generated by stacky — edit deviations via a stack.toml override; regenerated on `stacky apply`.'
```

Add after `deepMerge`:

```ts
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k])
    return out
  }
  return v
}

/** Recursively key-sorted JSON, 2-space indent, trailing newline. */
export function stringifyJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`
}

/** Merges JSON fragments in order; keys sorted for byte-stability. */
export function mergeJson(fragments: string[]): string {
  let acc: Record<string, unknown> = {}
  for (const frag of fragments) {
    const parsed = JSON.parse(frag) as unknown
    if (isPlainObject(parsed)) acc = deepMerge(acc, parsed)
  }
  return stringifyJson({ '//': BANNER_JSON, ...acc })
}
```

- [ ] **Step 4: Run to verify the merge tests pass**

Run: `pnpm vitest run packages/core/tests/merge.test.ts`
Expected: PASS.

- [ ] **Step 5: Accept `json` in the type, registry, and tier-composed dispatch**

In `packages/core/src/types.ts` line 12, change:

```ts
export interface FragmentSpec { target: string; from: string; strategy: 'yaml' | 'lines' | 'json' }
```

In `packages/core/src/registry.ts`, update `parseFragment`:

```ts
function parseFragment(raw: { target: string; from: string; strategy?: string }, brick: string): FragmentSpec {
  const strategy = raw.strategy ?? 'yaml'
  if (strategy !== 'yaml' && strategy !== 'lines' && strategy !== 'json') {
    throw new Error(`brick "${brick}": unknown fragment strategy "${strategy}" (expected "yaml", "lines", or "json")`)
  }
  return { target: raw.target, from: raw.from, strategy }
}
```

In `packages/core/src/plan/tier-composed.ts`, update the import (line 4) and the merge/override block. Import:

```ts
import { BANNER_YAML, deepMerge, mergeJson, mergeLines, mergeYaml, stringifyJson } from '../merge.js'
```

Replace the `let contents = …` assignment and the `if (override)` block (lines 35–47) with:

```ts
    let contents =
      strategy === 'yaml'
        ? mergeYaml(contributions.map((c) => c.text))
        : strategy === 'lines'
          ? mergeLines(contributions.map((c) => ({ brick: c.brick, text: c.text })))
          : mergeJson(contributions.map((c) => c.text))

    const override = ctx.overrides[target]
    if (override) {
      if (strategy === 'yaml') {
        const merged = deepMerge(parseYaml(contents) as Record<string, unknown>, override)
        contents = BANNER_YAML + stringifyYaml(merged, { sortMapEntries: true })
      } else if (strategy === 'json') {
        contents = stringifyJson(deepMerge(JSON.parse(contents) as Record<string, unknown>, override))
      } else {
        throw new Error(`overrides for "${target}" require a yaml or json fragment strategy`)
      }
    }
```

- [ ] **Step 6: Write a failing test for json compose + override in `tier-composed.test.ts`**

Append to `packages/core/tests/tier-composed.test.ts` (reuse its existing imports; add `writeFile`/`mkdtemp` already imported):

```ts
describe('planComposedFiles — json strategy', () => {
  it('deep-merges json fragments and applies a json override', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-json-'))
    const bricksDir = await mkdtemp(join(tmpdir(), 'stacky-json-bricks-'))
    await writeFile(join(bricksDir, 'a.json'), JSON.stringify({ scripts: { dev: 'vite' } }), 'utf8')
    await writeFile(join(bricksDir, 'b.json'), JSON.stringify({ scripts: { build: 'vite build' } }), 'utf8')

    const mk = (name: string, from: string): ResolvedBrick => ({
      brick: {
        name, slot: name, summary: '', dir: bricksDir, requires: {}, provides: {} as never,
        params: {}, files: [], fragments: [{ target: 'app/package.json', from, strategy: 'json' }], inject: [],
      } as never,
      params: {}, inferred: false,
    })
    const g: Graph = { bricks: [mk('a', 'a.json'), mk('b', 'b.json')] }

    const ops = await planComposedFiles(g, {
      projectDir: dir, lock: emptyLock(),
      overrides: { 'app/package.json': { scripts: { dev: 'vite dev --host' } } },
    })
    const contents = (ops[0] as { contents: string }).contents
    const parsed = JSON.parse(contents)
    expect(parsed.scripts).toEqual({ build: 'vite build', dev: 'vite dev --host' })
    expect(parsed['//']).toContain('Generated by stacky')
  })
})
```

> Note: the `provides` field on the fixture brick is set via `as never` because this inline literal predates the injection-point additions; keep it as shown to avoid coupling this task to Task 3's type change.

- [ ] **Step 7: Run json compose test, verify pass; then full suite + typecheck; commit**

Run: `pnpm vitest run packages/core/tests/tier-composed.test.ts && pnpm vitest run && pnpm tsc -b`
Expected: PASS, PASS (71 tests now), clean.

Add the `mergeJson` export to `packages/core/src/index.ts` line 8:

```ts
export { deepMerge, mergeJson, mergeLines, mergeYaml, stringifyJson } from './merge.js'
```

```bash
git add -A
git commit -m "feat(core): add json fragment merge strategy for composed package.json"
```

---

### Task 3: Injection-point types + registry parsing

Introduce `[[injection_points]]` (a brick publishes a named seam) and the point form of `[[inject]]` (a brick consumes a seam by name). Bake them into the capability graph: publishing point `N` adds synthetic capability `inject:N` to `provides`; a point-based inject adds `inject:N` to `requires`. Add the two new error kinds to the type union (they are emitted in Task 4).

**Files:**
- Modify: `packages/core/src/types.ts` (`InjectionPoint`, `InjectSpec`, `Brick.injectionPoints`, 2 error kinds)
- Modify: `packages/core/src/registry.ts` (`RawBrickFile`, parse injection points + point-inject, synthesize capabilities)
- Create: `packages/core/tests/fixtures/inject-points/` (shared fixture for Tasks 3–5)
- Test: `packages/core/tests/registry.test.ts`

**Interfaces:**
- Produces:
  - `interface InjectionPoint { name: string; target: string; marker: string }`
  - `interface InjectSpec { point?: string; target?: string; marker?: string; from: string }`
  - `Brick.injectionPoints: InjectionPoint[]`
  - A loaded brick's `provides` includes `inject:<name>` for each published point; its `requires` includes `inject:<point>` for each point-based inject.
  - Error kinds `unsatisfiable-injection-point` `{ point, requiredBy }` and `ambiguous-injection-point` `{ point, candidates, requiredBy }`.

- [ ] **Step 1: Extend `types.ts`**

In `packages/core/src/types.ts`, replace line 13 (`InjectSpec`) and add `InjectionPoint`:

```ts
export interface InjectSpec { point?: string; target?: string; marker?: string; from: string }
export interface InjectionPoint { name: string; target: string; marker: string }
```

Add to the `Brick` interface (after `inject: InjectSpec[]`):

```ts
  injectionPoints: InjectionPoint[]
```

Add to the `ResolutionError` union:

```ts
  | { kind: 'unsatisfiable-injection-point'; point: string; requiredBy: BrickId }
  | { kind: 'ambiguous-injection-point'; point: string; candidates: BrickId[]; requiredBy: BrickId }
```

- [ ] **Step 2: Create the shared injection-points fixture**

```
packages/core/tests/fixtures/inject-points/slots.toml
packages/core/tests/fixtures/inject-points/web/host-a/brick.toml
packages/core/tests/fixtures/inject-points/web/host-b/brick.toml
packages/core/tests/fixtures/inject-points/db/consumer/brick.toml
packages/core/tests/fixtures/inject-points/db/consumer/fragments/seam.ts
packages/core/tests/fixtures/inject-points/db/orphan/brick.toml
packages/core/tests/fixtures/inject-points/db/orphan/fragments/seam.ts
packages/core/tests/fixtures/inject-points/web/host-a/files/host.ts
packages/core/tests/fixtures/inject-points/web/host-b/files/host.ts
```

`slots.toml`:

```toml
[[slot]]
name = "web"
single = true

[[slot]]
name = "db"
single = false
```

`web/host-a/brick.toml`:

```toml
[brick]
name    = "host-a"
slot    = "web"
summary = "Publishes the seam at host-a.ts"

[[files]]
from = "files/host.ts"
to   = "app/host-a.ts"

[[injection_points]]
name   = "seam"
target = "app/host-a.ts"
marker = "stacky:seam"
```

`web/host-b/brick.toml` (identical shape, different target):

```toml
[brick]
name    = "host-b"
slot    = "web"
summary = "Publishes the seam at host-b.ts"

[[files]]
from = "files/host.ts"
to   = "app/host-b.ts"

[[injection_points]]
name   = "seam"
target = "app/host-b.ts"
marker = "stacky:seam"
```

`web/host-a/files/host.ts` and `web/host-b/files/host.ts` (both):

```ts
// >>> stacky:seam
// <<< stacky:seam
```

`db/consumer/brick.toml`:

```toml
[brick]
name    = "consumer"
slot    = "db"
summary = "Injects into the seam by name"

[[inject]]
point = "seam"
from  = "fragments/seam.ts"
```

`db/consumer/fragments/seam.ts`:

```ts
export const injected = true
```

`db/orphan/brick.toml`:

```toml
[brick]
name    = "orphan"
slot    = "db"
summary = "Injects into a seam nobody publishes"

[[inject]]
point = "nonexistent"
from  = "fragments/seam.ts"
```

`db/orphan/fragments/seam.ts`:

```ts
export const orphan = true
```

- [ ] **Step 3: Write failing registry tests for injection-point parsing**

Append to `packages/core/tests/registry.test.ts`:

```ts
describe('loadRegistry — injection points', () => {
  const injFixture = fileURLToPath(new URL('./fixtures/inject-points', import.meta.url))

  it('parses [[injection_points]] and adds a synthetic inject:<name> capability', async () => {
    const reg = await loadRegistry(injFixture)
    const hostA = reg.bricks.get('host-a')!
    expect(hostA.injectionPoints).toEqual([{ name: 'seam', target: 'app/host-a.ts', marker: 'stacky:seam' }])
    expect(hostA.provides).toContain('inject:seam')
  })

  it('turns a point-based [[inject]] into an inject:<point> requirement', async () => {
    const reg = await loadRegistry(injFixture)
    const consumer = reg.bricks.get('consumer')!
    expect(consumer.inject).toEqual([{ point: 'seam', from: 'fragments/seam.ts' }])
    expect(consumer.requires['inject:seam']).toBe('*')
  })

  it('rejects an [[inject]] with neither point nor target+marker', async () => {
    const bad = fileURLToPath(new URL('./fixtures/inject-bad', import.meta.url))
    await expect(loadRegistry(bad)).rejects.toThrow(/exactly one of "point"/)
  })
})
```

Create the `inject-bad` fixture:

```
packages/core/tests/fixtures/inject-bad/slots.toml       # [[slot]] name="db" single=false
packages/core/tests/fixtures/inject-bad/db/bad/brick.toml
packages/core/tests/fixtures/inject-bad/db/bad/fragments/x.ts   # export const x = 1
```

`inject-bad/slots.toml`:

```toml
[[slot]]
name = "db"
single = false
```

`inject-bad/db/bad/brick.toml`:

```toml
[brick]
name    = "bad"
slot    = "db"
summary = "Malformed inject"

[[inject]]
from = "fragments/x.ts"
```

- [ ] **Step 4: Run to verify failure**

Run: `pnpm vitest run packages/core/tests/registry.test.ts`
Expected: FAIL — `injectionPoints` undefined, synthetic capabilities absent, no one-of validation.

- [ ] **Step 5: Implement parsing in `registry.ts`**

Update `RawBrickFile` (add fields; change `inject`):

```ts
interface RawBrickFile {
  brick?: { name?: string; slot?: string; summary?: string }
  requires?: Record<string, string>
  provides?: { capabilities?: string[] }
  params?: Record<string, BrickParam>
  files?: { from: string; to: string }[]
  fragments?: { target: string; from: string; strategy?: string }[]
  inject?: { point?: string; target?: string; marker?: string; from: string }[]
  injection_points?: { name: string; target: string; marker: string }[]
}
```

Update the import on line 4 to include the new types:

```ts
import type { Brick, BrickParam, FragmentSpec, InjectSpec, InjectionPoint, Registry, SlotDef } from './types.js'
```

Add a `parseInject` helper (next to `parseFragment`):

```ts
function parseInject(raw: { point?: string; target?: string; marker?: string; from: string }, brick: string): InjectSpec {
  const hasPoint = raw.point != null
  const hasExplicit = raw.target != null && raw.marker != null
  if (hasPoint === hasExplicit) {
    throw new Error(`brick "${brick}": each [[inject]] needs exactly one of "point" or ("target" and "marker")`)
  }
  return hasPoint ? { point: raw.point, from: raw.from } : { target: raw.target, marker: raw.marker, from: raw.from }
}
```

In the `bricks.set(...)` call, compute injection points and synthetic capabilities. Replace the object literal's `provides`, `inject` lines and add `injectionPoints`:

```ts
      const injectionPoints: InjectionPoint[] = (raw.injection_points ?? []).map((p) => ({
        name: p.name, target: p.target, marker: p.marker,
      }))
      const inject = (raw.inject ?? []).map((i) => parseInject(i, name))
      const provides = [
        ...(raw.provides?.capabilities ?? []),
        ...injectionPoints.map((p) => `inject:${p.name}`),
      ]
      const requires: Record<string, string> = { ...(raw.requires ?? {}) }
      for (const i of inject) if (i.point) requires[`inject:${i.point}`] = '*'

      bricks.set(name, {
        name, slot, summary: raw.brick?.summary ?? '', dir: brickDir,
        requires, provides, params: raw.params ?? {},
        files: raw.files ?? [],
        fragments: (raw.fragments ?? []).map((f) => parseFragment(f, name)),
        inject, injectionPoints,
      })
```

- [ ] **Step 6: Run registry tests, then full suite + typecheck**

Run: `pnpm vitest run packages/core/tests/registry.test.ts && pnpm vitest run && pnpm tsc -b`
Expected: registry PASS; full suite PASS. Note: the inline `mkBrick` in `tier-composed.test.ts` now needs `injectionPoints: []` — add it to that literal (in the `brick: { … }` object) if tsc flags it.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): parse injection points and point-based injects as capabilities"
```

---

### Task 4: Injection-point resolution + error formatting

Emit the two point-specific error kinds. Because injection points are already `inject:<name>` capabilities, `resolve` needs only to re-label the `ambiguous`/`unsatisfiable` it would otherwise emit when the capability is an `inject:` one. Wire `ambiguous-injection-point` into the exit-2 (needs-input) set and add human messages.

**Files:**
- Modify: `packages/core/src/resolve.ts` (the two `errors.push(...)` in the capability loop)
- Modify: `packages/core/src/errors.ts` (`formatError`, `exitCodeFor`)
- Test: `packages/core/tests/resolve.test.ts`, `packages/core/tests/errors.test.ts` (create if absent)

**Interfaces:**
- Consumes: the `inject:<name>` capabilities and error kinds from Task 3.
- Produces: `resolve` returns `ambiguous-injection-point` (≥2 publishers, none selected) and `unsatisfiable-injection-point` (no publisher). `exitCodeFor` treats `ambiguous-injection-point` as exit 2.

- [ ] **Step 1: Write failing resolve tests**

Append to `packages/core/tests/resolve.test.ts`:

```ts
describe('resolve — injection points', () => {
  const injFixture = fileURLToPath(new URL('./fixtures/inject-points', import.meta.url))

  it('reports ambiguous-injection-point when a consumed point has two publishers', async () => {
    const reg = await loadRegistry(injFixture)
    const r = resolve({ bricks: { consumer: {} }, overrides: {} }, reg)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContainEqual({
      kind: 'ambiguous-injection-point', point: 'seam', candidates: ['host-a', 'host-b'], requiredBy: 'consumer',
    })
  })

  it('resolves cleanly once a publisher is selected', async () => {
    const reg = await loadRegistry(injFixture)
    const r = resolve({ bricks: { consumer: {}, 'host-a': {} }, overrides: {} }, reg)
    expect(r.ok).toBe(true)
  })

  it('reports unsatisfiable-injection-point when nobody publishes the point', async () => {
    const reg = await loadRegistry(injFixture)
    const r = resolve({ bricks: { orphan: {} }, overrides: {} }, reg)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContainEqual({
      kind: 'unsatisfiable-injection-point', point: 'nonexistent', requiredBy: 'orphan',
    })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/core/tests/resolve.test.ts`
Expected: FAIL — resolve emits generic `ambiguous`/`unsatisfiable` with capability `inject:seam`, not the point-specific kinds.

- [ ] **Step 3: Re-label inject capability errors in `resolve.ts`**

In the capability loop (the `if (candidates.length === 0) … else if (candidates.length > 1)` block, lines 82–86), replace with:

```ts
        const isInject = cap.startsWith('inject:')
        const point = cap.slice('inject:'.length)
        if (candidates.length === 0) {
          errors.push(
            isInject
              ? { kind: 'unsatisfiable-injection-point', point, requiredBy: r.brick.name }
              : { kind: 'unsatisfiable', capability: cap, requiredBy: r.brick.name },
          )
        } else if (candidates.length > 1) {
          errors.push(
            isInject
              ? { kind: 'ambiguous-injection-point', point, candidates, requiredBy: r.brick.name }
              : { kind: 'ambiguous', capability: cap, candidates, requiredBy: r.brick.name },
          )
        } else {
```

(The `else {` continues into the existing auto-add branch — leave that unchanged.)

- [ ] **Step 4: Add messages and exit codes in `errors.ts`**

In `formatError`, add cases before the closing brace of the switch:

```ts
    case 'unsatisfiable-injection-point':
      return `"${e.requiredBy}" injects into "${e.point}", but no brick publishes that injection point.`
    case 'ambiguous-injection-point':
      return `"${e.requiredBy}" injects into "${e.point}", published by: ${e.candidates.join(', ')}. Pick one and add it to stack.toml.`
```

In `exitCodeFor`, extend the needs-input predicate:

```ts
  const needsInput = errors.every(
    (e) => e.kind === 'ambiguous' || e.kind === 'missing-param' || e.kind === 'ambiguous-injection-point',
  )
```

- [ ] **Step 5: Write a failing errors test for the new formats**

Create/append `packages/core/tests/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { exitCodeFor, formatError } from '../src/errors.js'

describe('injection-point errors', () => {
  it('formats ambiguous-injection-point with candidates', () => {
    const msg = formatError({ kind: 'ambiguous-injection-point', point: 'server-init', candidates: ['a', 'b'], requiredBy: 'pg' })
    expect(msg).toContain('server-init')
    expect(msg).toContain('a, b')
  })

  it('treats ambiguous-injection-point as exit 2, unsatisfiable as exit 1', () => {
    expect(exitCodeFor([{ kind: 'ambiguous-injection-point', point: 'x', candidates: ['a', 'b'], requiredBy: 'c' }])).toBe(2)
    expect(exitCodeFor([{ kind: 'unsatisfiable-injection-point', point: 'x', requiredBy: 'c' }])).toBe(1)
  })
})
```

- [ ] **Step 6: Run resolve + errors tests, full suite, typecheck, commit**

Run: `pnpm vitest run packages/core/tests/resolve.test.ts packages/core/tests/errors.test.ts && pnpm vitest run && pnpm tsc -b`
Expected: all PASS.

```bash
git add -A
git commit -m "feat(core): surface unsatisfiable/ambiguous injection-point errors"
```

---

### Task 5: Injection planning — resolve points + aggregate contributors

Two changes to the inject tier: (1) resolve a consumer's `point` to the publisher's `{target, marker}` from the graph; (2) aggregate *all* contributors to a marker into one regenerated region (phase 1 clobbered — last writer won). The region becomes composed-like: rebuilt from every current contributor in graph order, emptied when none remain.

**Files:**
- Modify: `packages/core/src/plan/tier-inject.ts` (`planInjections` rewrite; add `resolvePoint`)
- Test: `packages/core/tests/tier-inject.test.ts` (add planning tests), `packages/core/tests/round-trip.test.ts` (still green)

**Interfaces:**
- Consumes: `Brick.injectionPoints`, point-based `InjectSpec` (Task 3); `applyMarker` (existing).
- Produces: `planInjections` emits one `inject` op per `target#marker`, `contents` = contributors' bodies joined in graph order, `owner: '@composed'`. Orphaned markers (in lock, no contributor) get an empty-region strip op.

- [ ] **Step 1: Write failing planning tests in `tier-inject.test.ts`**

Append to `packages/core/tests/tier-inject.test.ts`:

```ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRegistry } from '../src/registry.js'
import { resolve } from '../src/resolve.js'
import { emptyLock } from '../src/lockfile.js'
import { planInjections } from '../src/plan/tier-inject.js'

const injFixture = fileURLToPath(new URL('./fixtures/inject-points', import.meta.url))

describe('planInjections — point resolution', () => {
  it('resolves a point-based inject to the selected publisher target and marker', async () => {
    const reg = await loadRegistry(injFixture)
    const r = resolve({ bricks: { consumer: {}, 'host-a': {} }, overrides: {} }, reg)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    const dir = await mkdtemp(join(tmpdir(), 'stacky-inj-'))
    const ops = await planInjections(r.graph, { projectDir: dir, lock: emptyLock(), overrides: {} })
    const inj = ops.find((o) => o.kind === 'inject')!
    expect(inj).toMatchObject({ kind: 'inject', path: 'app/host-a.ts', marker: 'stacky:seam' })
    expect((inj as { contents: string }).contents).toContain('export const injected = true')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/core/tests/tier-inject.test.ts`
Expected: FAIL — `planInjections` reads `spec.target`/`spec.marker`, which are undefined for a point-based inject.

- [ ] **Step 3: Rewrite `planInjections` (and add `resolvePoint`) in `tier-inject.ts`**

Replace `planInjections` (lines 34–64) with:

```ts
function resolvePoint(graph: Graph, point: string): { target: string; marker: string } {
  for (const { brick } of graph.bricks) {
    const ip = brick.injectionPoints.find((p) => p.name === point)
    if (ip) return { target: ip.target, marker: ip.marker }
  }
  // Unreachable when resolve() succeeded: consuming a point requires its publisher.
  throw new Error(`no brick in the graph publishes injection point "${point}"`)
}

export async function planInjections(graph: Graph, ctx: PlanContext): Promise<FileOp[]> {
  const ops: FileOp[] = []
  // "target#marker" -> contributors, collected in graph order (stable).
  const byMarker = new Map<string, { target: string; marker: string; parts: string[] }>()

  for (const { brick, params } of graph.bricks) {
    for (const spec of brick.inject) {
      const { target, marker } = spec.point
        ? resolvePoint(graph, spec.point)
        : { target: spec.target!, marker: spec.marker! }
      const raw = await readFile(join(brick.dir, spec.from), 'utf8')
      const text = spec.from.endsWith('.eta') ? renderTemplate(raw, params) : raw
      const key = `${target}#${marker}`
      const group = byMarker.get(key) ?? { target, marker, parts: [] }
      group.parts.push(text.replace(/\n+$/, ''))
      byMarker.set(key, group)
    }
  }

  const wanted = new Set(byMarker.keys())
  for (const { target, marker, parts } of byMarker.values()) {
    ops.push({ kind: 'inject', path: target, marker, contents: parts.join('\n'), owner: '@composed' })
  }

  // A locked marker with no current contributor gets its region emptied (host stays).
  for (const entry of ctx.lock.files) {
    if (entry.tier !== 'inject') continue
    const [path, marker] = entry.path.split('#')
    if (!marker || wanted.has(entry.path)) continue
    const hostExists = await access(join(ctx.projectDir, path!)).then(() => true, () => false)
    if (hostExists) ops.push({ kind: 'inject', path: path!, marker, contents: '', owner: '@composed' })
  }

  return ops
}
```

> The `owner: '@composed'` sentinel matches the composed tier — the region has no single owner. `apply` records the inject lock entry with this owner; nothing downstream depends on a per-brick inject owner.

- [ ] **Step 4: Run inject + round-trip tests**

Run: `pnpm vitest run packages/core/tests/tier-inject.test.ts packages/core/tests/round-trip.test.ts`
Expected: PASS. The existing postgres round-trip still passes: a single contributor's body is joined alone (byte-identical to before, since `applyMarker` already trimmed trailing newlines). The inject lock `owner` changes from `postgres` to `@composed`, but `snapshotTree` compares the whole tree symmetrically, so before/after still match.

- [ ] **Step 5: Full suite + typecheck; commit**

Run: `pnpm vitest run && pnpm tsc -b`
Expected: PASS (the `bricks.test.ts` "hooks contains DATABASE_URL / >>> stacky:server-init" assertions still hold — postgres still injects the same body into the same marker).

```bash
git add -A
git commit -m "feat(core): resolve injection points and aggregate multi-brick markers"
```

---

### Task 6: Extract `build/vite`; slim `web/sveltekit` onto it

Create the Vite barebone base and refactor SvelteKit to layer onto it. Vite owns the Dockerfile, `vite.config.ts` (with the `vite-plugins` seam), `.dockerignore`, composes `app/package.json` (json) and the compose `web` service. SvelteKit drops the Dockerfile/compose-web, requires `build`, injects into `vite-plugins`, publishes `server-init`, and contributes its deps to `package.json`.

**Files:**
- Modify: `bricks/slots.toml` (final order + `db` multi-occupancy)
- Create: `bricks/build/vite/brick.toml` + `files/vite.config.ts`, `files/Dockerfile.eta`, `files/dockerignore`, `fragments/package.json`, `fragments/compose.yaml.eta`
- Rewrite: `bricks/web/sveltekit/brick.toml`; create `bricks/web/sveltekit/fragments/package.json`, `fragments/plugin.ts`; delete `bricks/web/sveltekit/files/Dockerfile.eta`, `fragments/compose.yaml.eta`, `fragments/env.eta`
- Modify: `packages/core/tests/bricks.test.ts`, `packages/core/tests/round-trip.test.ts`, `packages/core/tests/golden/full-stack.env.example`
- Test: the above two test files

**Interfaces:**
- Produces: brick `vite` (slot `build`, provides `build`, publishes `vite-plugins`); brick `sveltekit` (slot `web`, requires `build`, provides `http-origin`, publishes `server-init`, injects `vite-plugins`). Both contribute `app/package.json`.

- [ ] **Step 1: Rewrite `bricks/slots.toml` with the final order**

```toml
# Slot order here IS the merge order for composed files. Changing it rewrites diffs.
[[slot]]
name = "container"
single = true

[[slot]]
name = "build"
single = true

[[slot]]
name = "web"
single = true

[[slot]]
name = "edge"
single = true

# db is multi-occupancy: it hosts the engine (postgres) AND the ORM (drizzle).
# Two engines are still caught by capability ambiguity when an ORM consumes sql-db.
[[slot]]
name = "db"
single = false
```

- [ ] **Step 2: Create the `build/vite` brick**

`bricks/build/vite/brick.toml`:

```toml
[brick]
name    = "vite"
slot    = "build"
summary = "Vite build base — dev/build/preview scripts, Dockerfile, and the plugin seam frameworks extend"

[requires]
container-runtime = "*"

[provides]
capabilities = ["build"]

[params]
port = { type = "string", default = "5173" }

[[files]]
from = "files/vite.config.ts"
to   = "app/vite.config.ts"

[[files]]
from = "files/Dockerfile.eta"
to   = "app/Dockerfile"

[[files]]
from = "files/dockerignore"
to   = "app/.dockerignore"

[[fragments]]
target   = "app/package.json"
from     = "fragments/package.json"
strategy = "json"

[[fragments]]
target   = "ops/compose.yml"
from     = "fragments/compose.yaml.eta"
strategy = "yaml"

[[injection_points]]
name   = "vite-plugins"
target = "app/vite.config.ts"
marker = "stacky:vite-plugins"
```

`bricks/build/vite/files/vite.config.ts`:

```ts
import { defineConfig } from 'vite'

// >>> stacky:vite-plugins
const stackyPlugins = []
// <<< stacky:vite-plugins

export default defineConfig({
  plugins: stackyPlugins,
})
```

`bricks/build/vite/files/Dockerfile.eta`:

```
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE <%= it.port %>
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "<%= it.port %>"]
```

`bricks/build/vite/files/dockerignore`:

```
node_modules
.git
dist
```

`bricks/build/vite/fragments/package.json`:

```json
{
  "name": "app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview"
  },
  "devDependencies": {
    "vite": "^6.0.0"
  }
}
```

`bricks/build/vite/fragments/compose.yaml.eta` (mirrors the old sveltekit web service byte-for-byte, so the compose golden is unchanged):

```
services:
  web:
    build: ../app
    ports:
      - "<%= it.port %>:<%= it.port %>"
    networks:
      - app
```

- [ ] **Step 3: Rewrite the `web/sveltekit` brick to layer onto Vite**

`bricks/web/sveltekit/brick.toml`:

```toml
[brick]
name    = "sveltekit"
slot    = "web"
summary = "SvelteKit app layered on the Vite base"

[requires]
build = "*"

[provides]
capabilities = ["http-origin"]

[[files]]
from = "files/hooks.server.ts"
to   = "app/src/hooks.server.ts"

[[fragments]]
target   = "app/package.json"
from     = "fragments/package.json"
strategy = "json"

[[injection_points]]
name   = "server-init"
target = "app/src/hooks.server.ts"
marker = "stacky:server-init"

[[inject]]
point = "vite-plugins"
from  = "fragments/plugin.ts"
```

Delete the now-owned-by-vite files:

```bash
git rm bricks/web/sveltekit/files/Dockerfile.eta bricks/web/sveltekit/fragments/compose.yaml.eta bricks/web/sveltekit/fragments/env.eta
```

Keep `bricks/web/sveltekit/files/hooks.server.ts` as-is (it already carries the `stacky:server-init` marker).

Create `bricks/web/sveltekit/fragments/package.json`:

```json
{
  "scripts": {
    "check": "svelte-check --tsconfig ./tsconfig.json"
  },
  "devDependencies": {
    "@sveltejs/kit": "^2.0.0",
    "@sveltejs/vite-plugin-svelte": "^5.0.0",
    "svelte": "^5.0.0"
  }
}
```

Create `bricks/web/sveltekit/fragments/plugin.ts` (replaces the region body, so it redefines `stackyPlugins` and brings its own import):

```ts
import { sveltekit } from '@sveltejs/kit/vite'
const stackyPlugins = [sveltekit()]
```

- [ ] **Step 4: Update `bricks.test.ts` for the new stack shape**

In `packages/core/tests/bricks.test.ts`, update the census and graph-order assertions:

```ts
  it('loads all bricks', async () => {
    const reg = await loadRegistry(bricksDir)
    expect([...reg.bricks.keys()].sort()).toEqual(['caddy', 'compose', 'postgres', 'sveltekit', 'vite'])
  })

  it('resolves the full stack, inferring vite and compose', async () => {
    const reg = await loadRegistry(bricksDir)
    const r = resolve({ bricks: { sveltekit: {}, caddy: {}, postgres: {} }, overrides: {} }, reg)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.graph.bricks.map((b) => b.brick.name)).toEqual(['compose', 'vite', 'sveltekit', 'caddy', 'postgres'])
  })
```

The third bricks.test case ("applies the full stack") still asserts `hooks` contains `DATABASE_URL` and `>>> stacky:server-init` and `compose` contains `web:`/`caddy:`/`postgres:` — all still true; leave it.

- [ ] **Step 5: Update the round-trip BASE and regenerate the env golden**

In `packages/core/tests/round-trip.test.ts`, the `BASE` now pulls vite+compose automatically; no change needed to `BASE` itself (`{ sveltekit: {} }` still resolves). Run the suite to regenerate the env golden (sveltekit no longer contributes `PUBLIC_APP_PORT`):

Run: `pnpm vitest run packages/core/tests/round-trip.test.ts -u`
Expected: PASS; `golden/full-stack.env.example` is rewritten (the `# sveltekit` / `PUBLIC_APP_PORT` block is gone). `golden/full-stack.compose.yml` is unchanged (vite's web service mirrors the old bytes).

- [ ] **Step 6: Full suite + typecheck**

Run: `pnpm vitest run && pnpm tsc -b`
Expected: PASS. Review the golden diff (`git diff packages/core/tests/golden/`) to confirm only the env `PUBLIC_APP_PORT` block changed.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(bricks): extract vite build base and slim sveltekit onto it"
```

---

### Task 7: Refactor `db/postgres` to point-driven, framework-agnostic injection

Drop `requires.ssr`, switch the inject to `point = "server-init"`, make the injected body framework-neutral (`process.env` + `pg` pool, not SvelteKit's `$env`), and contribute the `pg` dependency to `package.json`.

**Files:**
- Modify: `bricks/db/postgres/brick.toml`
- Rewrite: `bricks/db/postgres/fragments/server-init.ts`
- Create: `bricks/db/postgres/fragments/package.json`
- Test: `packages/core/tests/bricks.test.ts`, `packages/core/tests/round-trip.test.ts` (still green)

**Interfaces:**
- Produces: `postgres` requires only `container-runtime`, provides `sql-db`, injects `server-init` by point, and contributes `{ dependencies: { pg }, devDependencies: { @types/pg } }` to `app/package.json`.

- [ ] **Step 1: Rewrite `bricks/db/postgres/brick.toml`**

```toml
[brick]
name    = "postgres"
slot    = "db"
summary = "Postgres service, connection pool, and a migrations folder"

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

[[fragments]]
target   = "app/package.json"
from     = "fragments/package.json"
strategy = "json"

[[inject]]
point = "server-init"
from  = "fragments/server-init.ts"
```

- [ ] **Step 2: Rewrite the injected body to be framework-neutral**

`bricks/db/postgres/fragments/server-init.ts`:

```ts
import { Pool } from 'pg'

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })
```

Create `bricks/db/postgres/fragments/package.json`:

```json
{
  "dependencies": {
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0"
  }
}
```

- [ ] **Step 3: Update the bricks.test assertion that pins the injected body**

In `packages/core/tests/bricks.test.ts`, the "applies the full stack" test asserts `hooks` contains `DATABASE_URL`. It still does (`process.env.DATABASE_URL`). Add an assertion that pins the new agnostic form:

```ts
    expect(hooks).toContain('new Pool')
    expect(hooks).toContain('process.env.DATABASE_URL')
```

- [ ] **Step 4: Run the suite (regenerate goldens if needed)**

Run: `pnpm vitest run -u`
Expected: PASS. The postgres round-trip still holds. `golden/full-stack.compose.yml` unchanged; `full-stack.env.example` unchanged (postgres env fragment unchanged). No golden churn expected here, but `-u` covers the hooks body if any snapshot references it.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm tsc -b`

```bash
git add -A
git commit -m "feat(bricks): make postgres inject by point with a framework-neutral pool"
```

---

### Task 8: Add `web/tanstack-start`

The second framework — a React peer to SvelteKit. Publishes `server-init` at a *different* file (`app/src/server.ts`), injects into `vite-plugins`, contributes React deps. This brick is the portability proof: the same postgres/drizzle bricks inject into it unchanged.

**Files:**
- Create: `bricks/web/tanstack-start/brick.toml` + `files/server.ts`, `fragments/package.json`, `fragments/plugin.ts`
- Test: `packages/core/tests/bricks.test.ts`

**Interfaces:**
- Produces: brick `tanstack-start` (slot `web`, requires `build`, provides `http-origin`, publishes `server-init` at `app/src/server.ts`, injects `vite-plugins`).

- [ ] **Step 1: Create the brick**

`bricks/web/tanstack-start/brick.toml`:

```toml
[brick]
name    = "tanstack-start"
slot    = "web"
summary = "TanStack Start (React) app layered on the Vite base"

[requires]
build = "*"

[provides]
capabilities = ["http-origin"]

[[files]]
from = "files/server.ts"
to   = "app/src/server.ts"

[[fragments]]
target   = "app/package.json"
from     = "fragments/package.json"
strategy = "json"

[[injection_points]]
name   = "server-init"
target = "app/src/server.ts"
marker = "stacky:server-init"

[[inject]]
point = "vite-plugins"
from  = "fragments/plugin.ts"
```

`bricks/web/tanstack-start/files/server.ts`:

```ts
// >>> stacky:server-init
// <<< stacky:server-init

export default {
  fetch(_request: Request): Response {
    return new Response('ok')
  },
}
```

`bricks/web/tanstack-start/fragments/package.json`:

```json
{
  "dependencies": {
    "@tanstack/react-start": "^1.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

`bricks/web/tanstack-start/fragments/plugin.ts`:

```ts
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
const stackyPlugins = [tanstackStart()]
```

- [ ] **Step 2: Write a failing test that the tanstack stack resolves and applies**

Append to `packages/core/tests/bricks.test.ts`:

```ts
describe('tanstack-start stack', () => {
  it('resolves vite + tanstack-start + postgres and injects server-init into server.ts', async () => {
    const reg = await loadRegistry(bricksDir)
    const r = resolve({ bricks: { 'tanstack-start': {}, postgres: {} }, overrides: {} }, reg)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const dir = await mkdtemp(join(tmpdir(), 'stacky-tanstack-'))
    await apply(await plan(r.graph, { projectDir: dir, lock: emptyLock(), overrides: {} }), dir, r.graph)

    const server = await readFile(join(dir, 'app/src/server.ts'), 'utf8')
    expect(server).toContain('new Pool')
    expect(server).toContain('>>> stacky:server-init')

    const pkg = JSON.parse(await readFile(join(dir, 'app/package.json'), 'utf8'))
    expect(pkg.dependencies).toHaveProperty('@tanstack/react-start')
    expect(pkg.dependencies).toHaveProperty('pg')
  })
})
```

Also update the census assertion in the "loads all bricks" test:

```ts
    expect([...reg.bricks.keys()].sort()).toEqual(['caddy', 'compose', 'postgres', 'sveltekit', 'tanstack-start', 'vite'])
```

- [ ] **Step 3: Run to verify, then full suite + typecheck**

Run: `pnpm vitest run packages/core/tests/bricks.test.ts && pnpm vitest run && pnpm tsc -b`
Expected: PASS. The portability proof: postgres's unchanged `server-init` body lands in `app/src/server.ts` (tanstack) exactly as it lands in `hooks.server.ts` (sveltekit).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(bricks): add tanstack-start as a second web framework"
```

---

### Task 9: Add `db/drizzle`

The ORM — the second `server-init` contributor (proving multi-brick aggregation). Owns the schema and drizzle config, contributes its scripts/deps to `package.json`, and injects an independent client (its own `process.env.DATABASE_URL` connection, so ordering versus postgres never matters).

**Files:**
- Create: `bricks/db/drizzle/brick.toml` + `files/schema.ts`, `files/drizzle.config.ts`, `fragments/package.json`, `fragments/server-init.ts`
- Test: `packages/core/tests/bricks.test.ts`

**Interfaces:**
- Produces: brick `drizzle` (slot `db`, requires `sql-db`, provides `orm`, injects `server-init`). Coexists with postgres in the multi-occupancy `db` slot.

- [ ] **Step 1: Create the brick**

`bricks/db/drizzle/brick.toml`:

```toml
[brick]
name    = "drizzle"
slot    = "db"
summary = "Drizzle ORM — schema, config, and a typed client"

[requires]
sql-db = "*"

[provides]
capabilities = ["orm"]

[[files]]
from = "files/schema.ts"
to   = "db/schema.ts"

[[files]]
from = "files/drizzle.config.ts"
to   = "app/drizzle.config.ts"

[[fragments]]
target   = "app/package.json"
from     = "fragments/package.json"
strategy = "json"

[[inject]]
point = "server-init"
from  = "fragments/server-init.ts"
```

`bricks/db/drizzle/files/schema.ts`:

```ts
import { pgTable, serial, timestamp } from 'drizzle-orm/pg-core'

export const health = pgTable('health', {
  id: serial('id').primaryKey(),
  checkedAt: timestamp('checked_at').notNull().defaultNow(),
})
```

`bricks/db/drizzle/files/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: '../db/schema.ts',
  out: '../db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

`bricks/db/drizzle/fragments/package.json`:

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "drizzle-orm": "^0.36.0"
  },
  "devDependencies": {
    "drizzle-kit": "^0.28.0"
  }
}
```

`bricks/db/drizzle/fragments/server-init.ts` (self-contained; does not reference postgres's `pool`):

```ts
import { drizzle } from 'drizzle-orm/node-postgres'

export const db = drizzle(process.env.DATABASE_URL!)
```

- [ ] **Step 2: Write a failing test for the multi-contributor server-init region**

Append to `packages/core/tests/bricks.test.ts`:

```ts
describe('drizzle + postgres multi-contributor server-init', () => {
  it('lands both the pool and the drizzle client in one marker region', async () => {
    const reg = await loadRegistry(bricksDir)
    const r = resolve({ bricks: { sveltekit: {}, postgres: {}, drizzle: {} }, overrides: {} }, reg)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const dir = await mkdtemp(join(tmpdir(), 'stacky-drizzle-'))
    await apply(await plan(r.graph, { projectDir: dir, lock: emptyLock(), overrides: {} }), dir, r.graph)

    const hooks = await readFile(join(dir, 'app/src/hooks.server.ts'), 'utf8')
    expect(hooks).toContain('new Pool')
    expect(hooks).toContain('drizzle(process.env.DATABASE_URL')
    // both bodies live inside the single server-init region
    const region = hooks.split('>>> stacky:server-init')[1].split('<<< stacky:server-init')[0]
    expect(region).toContain('new Pool')
    expect(region).toContain('drizzle(')

    const pkg = JSON.parse(await readFile(join(dir, 'app/package.json'), 'utf8'))
    expect(pkg.scripts).toHaveProperty('db:migrate')
  })
})
```

Update the census assertion in "loads all bricks":

```ts
    expect([...reg.bricks.keys()].sort())
      .toEqual(['caddy', 'compose', 'drizzle', 'postgres', 'sveltekit', 'tanstack-start', 'vite'])
```

- [ ] **Step 3: Run to verify, then full suite + typecheck**

Run: `pnpm vitest run packages/core/tests/bricks.test.ts && pnpm vitest run && pnpm tsc -b`
Expected: PASS. Both contributors appear in the one region, in graph order (drizzle then postgres — both slot `db`, sorted by name; order is irrelevant since each reads its own env).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(bricks): add drizzle as a second server-init contributor"
```

---

### Task 10: CLI build step — `stacky` runs under plain `node`

Bundle the CLI with tsup so the `bin` is runnable JS (phase 1's `bin` pointed at a `.ts`). tsup inlines `@stacky/core` (whose `main` is a `.ts` source) into one file and externalizes real npm deps. The bundle lands at `packages/cli/dist/index.js`, keeping the `../../../bricks` registry path valid.

**Files:**
- Create: `packages/cli/tsup.config.ts`
- Modify: `packages/cli/package.json` (`bin`, `files`, `scripts.build`, `prepublishOnly`, devDep `tsup`)
- Modify: root `package.json` (a `build` script, optional)
- Test: `packages/cli/tests/cli.test.ts` (add a "runs from the bundle" case)

**Interfaces:**
- Produces: `packages/cli/dist/index.js` — an executable ESM bundle with a `#!/usr/bin/env node` shebang, resolving the registry as `../../../bricks`.

- [ ] **Step 1: Add tsup and the config**

`packages/cli/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // Bundle the workspace core (its package main is a .ts source); keep real deps external.
  noExternal: ['@stacky/core'],
  external: ['cac', 'smol-toml', 'yaml', 'eta'],
  banner: { js: '#!/usr/bin/env node' },
})
```

Update `packages/cli/package.json`:

```json
{
  "name": "@stacky/cli",
  "version": "0.0.0",
  "type": "module",
  "bin": { "stacky": "./dist/index.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "prepublishOnly": "tsup"
  },
  "dependencies": {
    "@stacky/core": "workspace:*",
    "cac": "^7.0.0"
  },
  "devDependencies": {
    "tsup": "^8.3.0"
  }
}
```

Install:

```bash
pnpm install
```

- [ ] **Step 2: Write a failing test that the built bundle runs under node**

Append to `packages/cli/tests/cli.test.ts`:

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const bundle = fileURLToPath(new URL('../dist/index.js', import.meta.url))

describe('built bundle', () => {
  it('runs `stacky list` under plain node', async () => {
    const { stdout } = await exec('node', [bundle, 'list'])
    expect(stdout).toContain('sveltekit')
    expect(stdout).toContain('vite')
  })
})
```

- [ ] **Step 3: Run to verify failure (no bundle yet)**

Run: `pnpm vitest run packages/cli/tests/cli.test.ts -t "built bundle"`
Expected: FAIL — `dist/index.js` does not exist.

- [ ] **Step 4: Build, then run the test**

Run: `pnpm --filter @stacky/cli build && pnpm vitest run packages/cli/tests/cli.test.ts -t "built bundle"`
Expected: PASS — `list` prints the registry (resolved via `../../../bricks` from `dist/index.js`).

> Distribution note: an npm-installed `stacky` still expects `bricks/` at `../../../bricks`; bundling the registry into the published package is out of scope for phase 2a (the done-criterion is "runs under plain node," which this satisfies in-repo).

- [ ] **Step 5: Full suite + typecheck; commit**

Run: `pnpm vitest run && pnpm tsc -b`
Expected: PASS. (Ensure `dist/` is git-ignored if the repo ignores build output; if `packages/*/dist` is already ignored, the bundle is not committed — the test builds it on demand. If CI runs `vitest` without a prior build, gate the "built bundle" test with a skip-if-absent guard like the artifact tests.)

If the bundle may be absent in CI, wrap the test:

```ts
  it('runs `stacky list` under plain node', async ({ skip }) => {
    const exists = await access(bundle).then(() => true, () => false)
    if (!exists) skip()
    // …
  })
```

```bash
git add -A
git commit -m "build(cli): bundle stacky with tsup so bin runs under node"
```

---

### Task 11: Extended acceptance gate — both framework stacks, registry-derived

Replace the round-trip gate with a registry-derived one that runs against both framework stacks, plus the load-bearing multi-contributor test (remove drizzle, postgres's line survives) and per-framework goldens.

**Files:**
- Rewrite: `packages/core/tests/round-trip.test.ts`
- Create goldens (generated): `golden/sveltekit.compose.yml`, `golden/sveltekit.package.json`, `golden/sveltekit.vite.config.ts`, `golden/tanstack.compose.yml`, `golden/tanstack.package.json`, `golden/tanstack.vite.config.ts`
- Modify: `packages/core/tests/artifacts.test.ts` (both stacks)

**Interfaces:**
- Consumes: the full registry (7 bricks). No new production code.

- [ ] **Step 1: Rewrite `round-trip.test.ts` as a registry-derived, two-framework gate**

Replace the whole file with:

```ts
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, loadRegistry, plan, readLock, readManifest, resolve, writeManifest } from '../src/index.js'
import { snapshotTree } from './helpers/tree.js'
import type { Manifest } from '../src/types.js'

const bricksDir = fileURLToPath(new URL('../../../bricks', import.meta.url))

async function converge(dir: string, manifest: Manifest) {
  const registry = await loadRegistry(bricksDir)
  await writeManifest(dir, manifest)
  const r = resolve(manifest, registry)
  if (!r.ok) throw new Error(`resolve failed: ${JSON.stringify(r.errors)}`)
  const lock = await readLock(dir)
  const ops = await plan(r.graph, { projectDir: dir, lock, overrides: manifest.overrides })
  await apply(ops, dir, r.graph)
}

const FRAMEWORKS = ['sveltekit', 'tanstack-start'] as const
// The foundation is fixed per stack and never round-tripped.
const FOUNDATION = new Set<string>(['vite', 'compose', ...FRAMEWORKS])

describe('round trip — both framework stacks', () => {
  for (const fw of FRAMEWORKS) {
    const base: Manifest = { bricks: { vite: {}, [fw]: {} }, overrides: {} }

    // Derive removable bricks from the registry: everything not in the foundation.
    it(`[${fw}] every removable brick round-trips byte for byte`, async () => {
      const registry = await loadRegistry(bricksDir)
      const removable = [...registry.bricks.values()]
        .filter((b) => !FOUNDATION.has(b.name) && b.slot !== 'web')
        .map((b) => b.name)
        .sort()
      expect(removable).toEqual(['caddy', 'drizzle', 'postgres'])

      for (const brick of removable) {
        const dir = await mkdtemp(join(tmpdir(), `stacky-rt-${fw}-${brick}-`))
        await converge(dir, structuredClone(base))
        const before = await snapshotTree(dir)

        await converge(dir, { bricks: { ...base.bricks, [brick]: {} }, overrides: {} })
        const during = await snapshotTree(dir)
        expect(Object.keys(during).length).toBeGreaterThan(Object.keys(before).length)

        await converge(dir, structuredClone(base))
        expect(await snapshotTree(dir)).toEqual(before)
      }
    })
  }

  it('[sveltekit] removing drizzle leaves postgres server-init intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-rt-multi-'))
    const withPg: Manifest = { bricks: { vite: {}, sveltekit: {}, postgres: {} }, overrides: {} }
    await converge(dir, structuredClone(withPg))
    const before = await snapshotTree(dir)

    await converge(dir, { bricks: { ...withPg.bricks, drizzle: {} }, overrides: {} })
    const hooks = await readFile(join(dir, 'app/src/hooks.server.ts'), 'utf8')
    expect(hooks).toContain('new Pool')
    expect(hooks).toContain('drizzle(')

    await converge(dir, structuredClone(withPg))
    expect(await snapshotTree(dir)).toEqual(before)
    const after = await readFile(join(dir, 'app/src/hooks.server.ts'), 'utf8')
    expect(after).toContain('new Pool')
    expect(after).not.toContain('drizzle(')
  })

  it('applying the same manifest twice changes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-rt-idem-'))
    const full: Manifest = { bricks: { vite: {}, sveltekit: {}, caddy: {}, postgres: {}, drizzle: {} }, overrides: {} }
    await converge(dir, structuredClone(full))
    const first = await snapshotTree(dir)
    await converge(dir, structuredClone(full))
    expect(await snapshotTree(dir)).toEqual(first)
  })

  it('a removed brick leaves no orphan files behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-rt-orphan-'))
    await converge(dir, { bricks: { vite: {}, sveltekit: {}, postgres: {} }, overrides: {} })
    await converge(dir, { bricks: { vite: {}, sveltekit: {} }, overrides: {} })
    const paths = Object.keys(await snapshotTree(dir))
    expect(paths.filter((p) => p.startsWith('db/'))).toEqual([])
    const manifest = await readManifest(dir)
    expect(manifest.bricks).not.toHaveProperty('postgres')
  })
})

describe('golden files — per framework', () => {
  for (const fw of FRAMEWORKS) {
    const short = fw === 'sveltekit' ? 'sveltekit' : 'tanstack'
    it(`[${fw}] full stack matches the committed goldens`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `stacky-golden-${short}-`))
      await converge(dir, { bricks: { vite: {}, [fw]: {}, caddy: {}, postgres: {}, drizzle: {} }, overrides: {} })
      await expect(await readFile(join(dir, 'ops/compose.yml'), 'utf8'))
        .toMatchFileSnapshot(`./golden/${short}.compose.yml`)
      await expect(await readFile(join(dir, 'app/package.json'), 'utf8'))
        .toMatchFileSnapshot(`./golden/${short}.package.json`)
      await expect(await readFile(join(dir, 'app/vite.config.ts'), 'utf8'))
        .toMatchFileSnapshot(`./golden/${short}.vite.config.ts`)
    })
  }
})
```

- [ ] **Step 2: Generate the goldens and run the gate**

Run: `pnpm vitest run packages/core/tests/round-trip.test.ts -u`
Expected: PASS. Six golden files are written under `packages/core/tests/golden/`. The old `full-stack.compose.yml` / `full-stack.env.example` are now unused — remove them:

```bash
git rm packages/core/tests/golden/full-stack.compose.yml packages/core/tests/golden/full-stack.env.example
```

- [ ] **Step 3: Inspect the goldens for correctness**

Confirm by eye:
- `sveltekit.vite.config.ts` region contains `const stackyPlugins = [sveltekit()]` and the `@sveltejs/kit/vite` import; `tanstack.vite.config.ts` contains `tanstackStart()`.
- Both `*.package.json` carry the `"//"` banner key first, sorted keys, `vite` + framework + `pg` + `drizzle-orm` deps.
- `sveltekit.compose.yml` and `tanstack.compose.yml` both carry `web:`, `caddy:`, `postgres:` services.

- [ ] **Step 4: Extend artifact validation to both stacks**

Replace `buildStack` in `packages/core/tests/artifacts.test.ts` with a parameterized helper and add a per-framework compose check:

```ts
async function buildStack(fw: 'sveltekit' | 'tanstack-start'): Promise<string> {
  const reg = await loadRegistry(bricksDir)
  const r = resolve({ bricks: { vite: {}, [fw]: {}, caddy: {}, postgres: {}, drizzle: {} }, overrides: {} }, reg)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  const dir = await mkdtemp(join(tmpdir(), 'stacky-artifact-'))
  await apply(await plan(r.graph, { projectDir: dir, lock: emptyLock(), overrides: {} }), dir, r.graph)
  return dir
}

describe('generated artifacts are valid', () => {
  for (const fw of ['sveltekit', 'tanstack-start'] as const) {
    it(`[${fw}] docker compose accepts the composed file`, async ({ skip }) => {
      if (!(await has('docker'))) skip()
      const dir = await buildStack(fw)
      const { stdout } = await run('docker', ['compose', '-f', join(dir, 'ops/compose.yml'), 'config'])
      expect(stdout).toContain('postgres')
    })
  }

  it('caddy accepts the generated Caddyfile', async ({ skip }) => {
    if (!(await has('caddy'))) skip()
    const dir = await buildStack('sveltekit')
    await expect(
      run('caddy', ['validate', '--config', join(dir, 'ops/caddy/Caddyfile'), '--adapter', 'caddyfile']),
    ).resolves.toBeDefined()
  })
})
```

- [ ] **Step 5: Full suite + typecheck**

Run: `pnpm vitest run && pnpm tsc -b`
Expected: PASS. The gate now proves: every removable brick round-trips against both frameworks; the same postgres/drizzle bricks inject into `hooks.server.ts` and `server.ts` unchanged; removing drizzle leaves postgres intact.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test(core): extend the round-trip gate to both framework stacks"
```

---

## Self-Review

**Spec coverage:**
- Concern taxonomy / two-level glob → Task 1. ✅
- `json` merge strategy for `app/package.json` → Task 2. ✅
- Injection-point publish/consume + capability wiring → Tasks 3–5. ✅
- New error kinds (`unsatisfiable`/`ambiguous-injection-point`) + exit codes → Task 4. ✅
- Multi-contributor `server-init` aggregation (spec assumed it existed; plan implements) → Task 5, proven in Tasks 9 & 11. ✅
- `build/vite` base + slimmed `sveltekit` → Task 6. ✅
- `postgres` point-driven, `requires ssr` dropped, framework-neutral body → Task 7. ✅
- `web/tanstack-start` → Task 8. ✅
- `db/drizzle` → Task 9. ✅
- CLI build step (bin under node) → Task 10. ✅
- Extended registry-derived gate, both frameworks, goldens, artifacts → Task 11. ✅
- Slot order + `db` multi-occupancy → Task 6. ✅

**Placeholder scan:** No TBD/TODO; every code step carries complete content. Test bodies are concrete.

**Type consistency:** `InjectSpec { point?, target?, marker?, from }`, `InjectionPoint { name, target, marker }`, and `Brick.injectionPoints` are defined in Task 3 and consumed identically in Tasks 5–9. `FragmentSpec.strategy` gains `'json'` in Task 2 and is used in Tasks 6–9. `mergeJson`/`stringifyJson` defined in Task 2, exported and reused. Error kinds defined in Task 3, emitted in Task 4, formatted in Task 4. The `@composed` inject owner sentinel (Task 5) is a plain string, consistent with the existing `LockEntry.owner: BrickId | '@composed'`.

**Ordering:** Core mechanism (1–5) precedes bricks (6–9); each brick task keeps the shared tests green by updating assertions; the gate rewrite (11) is last. Every task ends with a green suite and a commit.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-23-stacky-phase-2a.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
