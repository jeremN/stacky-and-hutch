# Stacky S-DB (Database Slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SQLite as a second, swappable database engine alongside Postgres, and make Drizzle engine-aware, proving the registry can host two providers of one capability that a consumer selects between.

**Architecture:** Split the multi-occupancy `db` slot into two single-occupancy slots (`db-engine`, `orm`) so engines are mutually exclusive. Add one small core primitive — an optional `when = "<capability>"` gate on a brick's contributions — so Drizzle emits the file/fragment/injection matching whichever engine's driver capability is in the resolved graph. No production framework code changes.

**Tech Stack:** `@stacky/core` (TypeScript strict, ESM, Node ≥22), the TOML brick registry, Drizzle ORM, `pg`, `better-sqlite3`, Vitest.

Spec: `docs/superpowers/specs/2026-07-24-stacky-s-db-database-slice-design.md`.

## Global Constraints

- Slots split: `db` (multi) → `db-engine` (single) + `orm` (single). Engines are mutually exclusive.
- `when = "<capability>"` on a contribution: emit it only if some brick in the **resolved** graph provides that capability. Absent `when` ⇒ always emitted (unchanged behavior). `Brick.provides` is a flat `string[]`.
- The gate is safe by construction — no new error kind: `db-engine` single-occupancy ⇒ at most one driver capability present ⇒ at most one variant fires; `drizzle` requires `sql-db` and every engine provides a driver capability ⇒ exactly one fires when drizzle is in the graph.
- `drizzle` uses the **connection-string form** for both engines: `drizzle(process.env.DATABASE_URL!)` — no `better-sqlite3` import in the drizzle fragment (avoids duplicating the engine's `import Database` in the aggregated `server-init` region). Both variants are self-contained (make their own connection), preserving order-independence.
- `sqlite` engine: **no compose service, no `container-runtime`**; reuses the single `DATABASE_URL` as a file path (`./data/app.db`); its raw client export is named `sqlite` (never `db`, to avoid colliding with drizzle's `db`).
- Engine ambiguity is reported as data: `add drizzle` with two engines and none chosen → `ambiguous`, capability `sql-db`, candidates `['postgres','sqlite']` (exit 2). Never prompt.
- The round-trip gate (add X → remove X → byte-identical) must not be weakened. Determinism/byte-stability preserved (gating is a pure function of the resolved graph).
- No `any` in `@stacky/core`. Tests derive brick names from the registry (census asserted), never hardcode escapes.
- Deferred, out of scope: a second ORM, more engines (MySQL/libsql), SQLite production persistence (volume on `web`), and the pnpm `catalog:`/exact-pin layer.

---

## File Structure

**Core (Task 1):**
- `packages/core/src/types.ts` — add `when?: string` to `FileSpec`, `FragmentSpec`, `InjectSpec`.
- `packages/core/src/registry.ts` — parse `when` on files/fragments/inject.
- `packages/core/src/plan/gate.ts` *(new)* — `providedCapabilities(graph)` + `gatePasses(when, provided)`.
- `packages/core/src/plan/tier-brick.ts`, `tier-composed.ts`, `tier-inject.ts` — apply the gate.
- `packages/core/tests/fixtures/when-gate/` *(new)* — mini-registry exercising file + inject gating.
- `packages/core/tests/when-gate.test.ts` *(new)*.

**Registry (Tasks 2–3):**
- `bricks/slots.toml` — `db` → `db-engine` + `orm`.
- `bricks/db/postgres/brick.toml` — slot `db-engine`, provides `pg-driver`.
- `bricks/db/drizzle/**` — slot `orm`; per-engine gated variants.
- `bricks/db/sqlite/**` *(new)*.

**Gate/tests (Tasks 3–4):**
- `packages/core/tests/round-trip.test.ts` — census + engine-aware round trip + engine-swap proof + ambiguity.
- `packages/core/tests/artifacts.test.ts` — sqlite stack (no db service).
- `packages/core/tests/golden/sqlite.*` *(new goldens)*.

---

## Task 1: The `when` gate primitive in core

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/registry.ts`
- Create: `packages/core/src/plan/gate.ts`
- Modify: `packages/core/src/plan/tier-brick.ts`, `packages/core/src/plan/tier-composed.ts`, `packages/core/src/plan/tier-inject.ts`
- Create fixture: `packages/core/tests/fixtures/when-gate/**`
- Test: `packages/core/tests/when-gate.test.ts`

**Interfaces:**
- Produces: `providedCapabilities(graph: Graph): Set<string>`, `gatePasses(when: string | undefined, provided: Set<string>): boolean` (from `packages/core/src/plan/gate.js`). Optional `when?: string` on `FileSpec`, `FragmentSpec`, `InjectSpec`.

- [ ] **Step 1: Create the fixture mini-registry**

`packages/core/tests/fixtures/when-gate/slots.toml`:
```toml
[[slot]]
name = "host"
single = true

[[slot]]
name = "flag"
single = false
```

`packages/core/tests/fixtures/when-gate/host/base/brick.toml`:
```toml
[brick]
name = "base"
slot = "host"

[[injection_points]]
name   = "seam"
target = "app.ts"
marker = "gate:seam"

[[files]]
from = "files/app.ts"
to   = "app.ts"

[[files]]
from = "files/conf.on.txt"
to   = "conf.txt"
when = "feature-on"

[[files]]
from = "files/conf.off.txt"
to   = "conf.txt"
when = "feature-off"

[[inject]]
point = "seam"
from  = "fragments/seam.on.ts"
when  = "feature-on"

[[inject]]
point = "seam"
from  = "fragments/seam.off.ts"
when  = "feature-off"
```

`host/base/files/app.ts`:
```ts
// >>> gate:seam
// <<< gate:seam
```
`host/base/files/conf.on.txt` (exactly, no trailing newline): `mode=on`
`host/base/files/conf.off.txt`: `mode=off`
`host/base/fragments/seam.on.ts`: `export const mode = 'on'`
`host/base/fragments/seam.off.ts`: `export const mode = 'off'`

`flag/on/brick.toml`:
```toml
[brick]
name = "on"
slot = "flag"

[provides]
capabilities = ["feature-on"]
```

`flag/off/brick.toml`:
```toml
[brick]
name = "off"
slot = "flag"

[provides]
capabilities = ["feature-off"]
```

- [ ] **Step 2: Write the failing test**

`packages/core/tests/when-gate.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { access, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, loadRegistry, plan, readLock, resolve, writeManifest } from '../src/index.js'
import type { Manifest } from '../src/types.js'

const fixture = fileURLToPath(new URL('./fixtures/when-gate', import.meta.url))

async function converge(dir: string, manifest: Manifest) {
  const registry = await loadRegistry(fixture)
  await writeManifest(dir, manifest)
  const r = resolve(manifest, registry)
  if (!r.ok) throw new Error(`resolve failed: ${JSON.stringify(r.errors)}`)
  const lock = await readLock(dir)
  const ops = await plan(r.graph, { projectDir: dir, lock, overrides: manifest.overrides })
  await apply(ops, dir, r.graph)
}

describe('when-gated contributions', () => {
  it('emits the variant whose gating capability is present (feature-on)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-gate-on-'))
    await converge(dir, { bricks: { base: {}, on: {} }, overrides: {} })
    expect(await readFile(join(dir, 'conf.txt'), 'utf8')).toBe('mode=on')
    expect(await readFile(join(dir, 'app.ts'), 'utf8')).toContain("export const mode = 'on'")
  })

  it('emits the other variant when the other capability is present (feature-off)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-gate-off-'))
    await converge(dir, { bricks: { base: {}, off: {} }, overrides: {} })
    expect(await readFile(join(dir, 'conf.txt'), 'utf8')).toBe('mode=off')
    expect(await readFile(join(dir, 'app.ts'), 'utf8')).toContain("export const mode = 'off'")
  })

  it('emits neither gated contribution when no gating capability is present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-gate-none-'))
    await converge(dir, { bricks: { base: {} }, overrides: {} })
    await expect(access(join(dir, 'conf.txt'))).rejects.toThrow()
    const app = await readFile(join(dir, 'app.ts'), 'utf8')
    expect(app).not.toContain('export const mode')
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run packages/core/tests/when-gate.test.ts`
Expected: FAIL — without gating, both `conf.on.txt` and `conf.off.txt` write to `conf.txt` (last wins) and both injects apply; the "neither" case creates `conf.txt` instead of omitting it. (Type errors on `spec.when` are also expected until Step 4.)

- [ ] **Step 4: Add `when` to the spec types**

In `packages/core/src/types.ts`, replace the three spec interfaces:
```ts
export interface FileSpec { from: string; to: string; when?: string }
export interface FragmentSpec { target: string; from: string; strategy: 'yaml' | 'lines' | 'json'; when?: string }
export interface InjectSpec { point?: string; target?: string; marker?: string; from: string; when?: string }
```

- [ ] **Step 5: Parse `when` in the registry**

In `packages/core/src/registry.ts`, add `when?: string` to the raw shapes in `RawBrickFile`:
```ts
  files?: { from: string; to: string; when?: string }[]
  fragments?: { target: string; from: string; strategy?: string; when?: string }[]
  inject?: { point?: string; target?: string; marker?: string; from: string; when?: string }[]
```
Update `parseFragment`'s signature and return:
```ts
function parseFragment(raw: { target: string; from: string; strategy?: string; when?: string }, brick: string): FragmentSpec {
  const strategy = raw.strategy ?? 'yaml'
  if (strategy !== 'yaml' && strategy !== 'lines' && strategy !== 'json') {
    throw new Error(`brick "${brick}": unknown fragment strategy "${strategy}" (expected "yaml", "lines", or "json")`)
  }
  return { target: raw.target, from: raw.from, strategy, when: raw.when }
}
```
Update `parseInject`'s signature and both returns:
```ts
function parseInject(raw: { point?: string; target?: string; marker?: string; from: string; when?: string }, brick: string): InjectSpec {
  const hasPoint = raw.point != null
  const hasExplicit = raw.target != null && raw.marker != null
  if (hasPoint === hasExplicit) {
    throw new Error(`brick "${brick}": each [[inject]] needs exactly one of "point" or ("target" and "marker")`)
  }
  return hasPoint
    ? { point: raw.point, from: raw.from, when: raw.when }
    : { target: raw.target, marker: raw.marker, from: raw.from, when: raw.when }
}
```
`files: raw.files ?? []` already carries `when` through (the raw shape now includes it and `FileSpec` accepts it) — no change needed there.

- [ ] **Step 6: Create the gate helper**

`packages/core/src/plan/gate.ts`:
```ts
import type { Graph } from '../types.js'

/** Capabilities provided by every brick in the resolved graph. */
export function providedCapabilities(graph: Graph): Set<string> {
  return new Set(graph.bricks.flatMap((b) => b.brick.provides))
}

/** A contribution with no `when` always applies; otherwise its gate must be in the graph. */
export function gatePasses(when: string | undefined, provided: Set<string>): boolean {
  return when === undefined || provided.has(when)
}
```

- [ ] **Step 7: Apply the gate in each tier**

In `packages/core/src/plan/tier-brick.ts`, add the import and gate:
```ts
import { gatePasses, providedCapabilities } from './gate.js'
```
Inside `planBrickFiles`, after `const wanted = new Set<string>()`:
```ts
  const provided = providedCapabilities(graph)
```
As the first line inside `for (const spec of brick.files) {`:
```ts
      if (!gatePasses(spec.when, provided)) continue
```

In `packages/core/src/plan/tier-composed.ts`, add `import { gatePasses, providedCapabilities } from './gate.js'`. After `const byTarget = new Map<...>()`:
```ts
  const provided = providedCapabilities(graph)
```
As the first line inside `for (const spec of brick.fragments) {`:
```ts
      if (!gatePasses(spec.when, provided)) continue
```

In `packages/core/src/plan/tier-inject.ts`, add `import { gatePasses, providedCapabilities } from './gate.js'`. At the top of `planInjections`, after `const byMarker = new Map<...>()`:
```ts
  const provided = providedCapabilities(graph)
```
As the first line inside `for (const spec of brick.inject) {`:
```ts
      if (!gatePasses(spec.when, provided)) continue
```

- [ ] **Step 8: Run the gate test + full suite + typecheck**

Run: `pnpm vitest run packages/core/tests/when-gate.test.ts`
Expected: PASS (3/3).
Run: `pnpm vitest run && pnpm tsc -b`
Expected: PASS — existing bricks have no `when`, so all prior behavior is unchanged.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(core): gate brick contributions on an in-graph capability"
```

---

## Task 2: Slot restructure + postgres/drizzle slot moves

Rename the `db` slot into `db-engine` + `orm` and move the two existing bricks. No behavior change: with Postgres still the only engine, Drizzle resolves and outputs exactly as before (only slot names and graph order change; composed files are order-independent, so goldens are unaffected).

**Files:**
- Modify: `bricks/slots.toml`, `bricks/db/postgres/brick.toml`, `bricks/db/drizzle/brick.toml`
- Test: `packages/core/tests/round-trip.test.ts` (already green; this task must keep it green)

**Interfaces:**
- Produces: slots `db-engine` (single) and `orm` (single); `postgres` provides `["sql-db", "pg-driver"]`; `drizzle` in slot `orm`.

- [ ] **Step 1: Restructure the slots**

Replace the `db` slot block at the end of `bricks/slots.toml` with:
```toml
# Engines are mutually exclusive: at most one database engine per project.
[[slot]]
name = "db-engine"
single = true

# The ORM sits in its own single slot and selects its engine wiring via `when`.
[[slot]]
name = "orm"
single = true
```
(Leave `container`, `build`, `web`, `edge` untouched, in that order, above these.)

- [ ] **Step 2: Move postgres to `db-engine` and add its driver capability**

In `bricks/db/postgres/brick.toml`: change `slot = "db"` → `slot = "db-engine"`, and change the provides line to:
```toml
[provides]
capabilities = ["sql-db", "pg-driver"]
```
(Everything else — `requires.container-runtime`, the compose/env/package.json fragments, the `server-init` inject — is unchanged.)

- [ ] **Step 3: Move drizzle to `orm`**

In `bricks/db/drizzle/brick.toml`: change `slot = "db"` → `slot = "orm"`. No other change in this task.

- [ ] **Step 4: Run the full suite + typecheck**

Run: `pnpm vitest run && pnpm tsc -b`
Expected: PASS. The census still reads `['caddy','drizzle','postgres']` (filter is `slot !== 'web'`; `orm`/`db-engine`/`edge` all pass). Composed goldens are order-independent (yaml `sortMapEntries`, json sorted keys), so the drizzle/postgres graph-order change does not alter their bytes.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(bricks): split db slot into db-engine and orm"
```

---

## Task 3: SQLite engine + Drizzle gated variants

Add the `sqlite` engine and refactor `drizzle` into per-engine gated variants. These land together: a second engine makes Drizzle's hardcoded Postgres wiring wrong and makes `add drizzle` alone ambiguous, so the round-trip loop is adapted in the same task to stay green. New S-DB *proofs* are Task 4.

**Files:**
- Create: `bricks/db/sqlite/brick.toml`, `bricks/db/sqlite/fragments/{env,package.json,server-init.ts}`, `bricks/db/sqlite/files/.gitkeep`
- Modify: `bricks/db/drizzle/brick.toml`
- Create: `bricks/db/drizzle/files/{schema.pg.ts,schema.sqlite.ts,drizzle.config.pg.ts,drizzle.config.sqlite.ts}`, `bricks/db/drizzle/fragments/{server-init.pg.ts,server-init.sqlite.ts}`
- Delete: `bricks/db/drizzle/files/schema.ts`, `bricks/db/drizzle/files/drizzle.config.ts`, `bricks/db/drizzle/fragments/server-init.ts`
- Modify: `packages/core/tests/round-trip.test.ts`

**Interfaces:**
- Produces: `sqlite` (slot `db-engine`, provides `["sql-db","sqlite-driver"]`, no `requires`); `drizzle` gated on `pg-driver`/`sqlite-driver`.

- [ ] **Step 1: Create the sqlite brick**

`bricks/db/sqlite/brick.toml`:
```toml
[brick]
name    = "sqlite"
slot    = "db-engine"
summary = "SQLite (better-sqlite3) — an embedded, service-less database engine"

[provides]
capabilities = ["sql-db", "sqlite-driver"]

[[fragments]]
target   = "config/.env.example"
from     = "fragments/env"
strategy = "lines"

[[fragments]]
target   = "app/package.json"
from     = "fragments/package.json"
strategy = "json"

[[files]]
from = "files/.gitkeep"
to   = "data/.gitkeep"

[[inject]]
point = "server-init"
from  = "fragments/server-init.ts"
```

`bricks/db/sqlite/fragments/env` (exactly one line):
```
DATABASE_URL=./data/app.db
```
`bricks/db/sqlite/fragments/package.json`:
```json
{
  "dependencies": {
    "better-sqlite3": "^13.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0"
  }
}
```
`bricks/db/sqlite/fragments/server-init.ts` (raw client, exported as `sqlite`):
```ts
import Database from 'better-sqlite3'

export const sqlite = new Database(process.env.DATABASE_URL!)
```
`bricks/db/sqlite/files/.gitkeep`: empty file.

- [ ] **Step 2: Replace drizzle's single files with gated variants**

Rewrite `bricks/db/drizzle/brick.toml` to:
```toml
[brick]
name    = "drizzle"
slot    = "orm"
summary = "Drizzle ORM — schema, config, and a typed client"

[requires]
sql-db = "*"

[provides]
capabilities = ["orm"]

[[files]]
from = "files/schema.pg.ts"
to   = "db/schema.ts"
when = "pg-driver"
[[files]]
from = "files/schema.sqlite.ts"
to   = "db/schema.ts"
when = "sqlite-driver"

[[files]]
from = "files/drizzle.config.pg.ts"
to   = "app/drizzle.config.ts"
when = "pg-driver"
[[files]]
from = "files/drizzle.config.sqlite.ts"
to   = "app/drizzle.config.ts"
when = "sqlite-driver"

[[fragments]]
target   = "app/package.json"
from     = "fragments/package.json"
strategy = "json"

[[inject]]
point = "server-init"
from  = "fragments/server-init.pg.ts"
when  = "pg-driver"
[[inject]]
point = "server-init"
from  = "fragments/server-init.sqlite.ts"
when  = "sqlite-driver"
```

Create the variant files. `files/schema.pg.ts` (identical to the deleted `schema.ts`):
```ts
import { pgTable, serial, timestamp } from 'drizzle-orm/pg-core'

export const health = pgTable('health', {
  id: serial('id').primaryKey(),
  checkedAt: timestamp('checked_at').notNull().defaultNow(),
})
```
`files/schema.sqlite.ts`:
```ts
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const health = sqliteTable('health', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  checkedAt: text('checked_at').notNull(),
})
```
`files/drizzle.config.pg.ts` (identical to the deleted `drizzle.config.ts`):
```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: '../db/schema.ts',
  out: '../db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```
`files/drizzle.config.sqlite.ts` (only `dialect` differs):
```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: '../db/schema.ts',
  out: '../db/migrations',
  dialect: 'sqlite',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```
`fragments/server-init.pg.ts` (identical to the deleted `server-init.ts`):
```ts
import { drizzle } from 'drizzle-orm/node-postgres'

export const db = drizzle(process.env.DATABASE_URL!)
```
`fragments/server-init.sqlite.ts` (connection-string form — no `better-sqlite3` import):
```ts
import { drizzle } from 'drizzle-orm/better-sqlite3'

export const db = drizzle(process.env.DATABASE_URL!)
```
Then delete the old single files:
```bash
git rm bricks/db/drizzle/files/schema.ts bricks/db/drizzle/files/drizzle.config.ts bricks/db/drizzle/fragments/server-init.ts
```

> Verify while implementing (spec Open Question #1): `drizzle-orm/better-sqlite3`'s `drizzle()` accepts a file-path string. If the pinned version does not, fall back to `export const db = drizzle(sqlite)` (referencing the engine's `sqlite` export — safe because `db-engine` sorts before `orm`, so `sqlite` is defined first in the aggregated region). Note the choice in your report.

- [ ] **Step 3: Adapt the round-trip removable loop (keep it green)**

In `packages/core/tests/round-trip.test.ts`, replace the `it(\`[${fw}] every removable brick round-trips byte for byte\`, ...)` body with:
```ts
    it(`[${fw}] every removable brick round-trips byte for byte`, async () => {
      const registry = await loadRegistry(bricksDir)
      const removable = [...registry.bricks.values()]
        .filter((b) => !FOUNDATION.has(b.name) && b.slot !== 'web')
        .map((b) => b.name)
        .sort()
      expect(removable).toEqual(['caddy', 'drizzle', 'postgres', 'sqlite'])

      for (const brick of removable) {
        // A brick that needs a database engine can't be added alone (two engines => ambiguous),
        // so give it a fixed engine in its foundation.
        const needsEngine = registry.bricks.get(brick)!.requires['sql-db'] != null
        const brickBase = needsEngine ? { ...base.bricks, postgres: {} } : { ...base.bricks }

        const dir = await mkdtemp(join(tmpdir(), `stacky-rt-${fw}-${brick}-`))
        await converge(dir, { bricks: structuredClone(brickBase), overrides: {} })
        const before = await snapshotTree(dir)

        await converge(dir, { bricks: { ...brickBase, [brick]: {} }, overrides: {} })
        const during = await snapshotTree(dir)
        expect(Object.keys(during).length).toBeGreaterThan(Object.keys(before).length)

        await converge(dir, { bricks: structuredClone(brickBase), overrides: {} })
        expect(await snapshotTree(dir)).toEqual(before)
      }
    })
```

- [ ] **Step 4: Run the full suite + typecheck**

Run: `pnpm vitest run && pnpm tsc -b`
Expected: PASS. Census now `['caddy','drizzle','postgres','sqlite']`; drizzle round-trips against a `+postgres` base; postgres/sqlite/caddy round-trip standalone. The existing "removing drizzle leaves postgres server-init intact", idempotency, orphan, and golden tests still pass (Postgres-stack bytes are unchanged — the `pg-driver` variants are byte-identical to the former hardcoded files).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(bricks): add sqlite engine and make drizzle engine-aware"
```

---

## Task 4: S-DB acceptance proofs

Additive coverage: the engine-swap byte-identity capstone, the ambiguity assertion, per-engine sqlite goldens, and sqlite artifact validation.

**Files:**
- Modify: `packages/core/tests/round-trip.test.ts`, `packages/core/tests/artifacts.test.ts`
- Create goldens (generated): `packages/core/tests/golden/sqlite.drizzle.config.ts`, `sqlite.hooks.server.ts`, `sqlite.schema.ts`

**Interfaces:**
- Consumes: the full registry (`vite, compose, sveltekit, tanstack-start, caddy, postgres, sqlite, drizzle`).

- [ ] **Step 1: Add the engine-swap + ambiguity tests**

In `packages/core/tests/round-trip.test.ts`, inside `describe('round trip — both framework stacks', ...)`, add (after the removable-brick `for (const fw ...)` block, alongside the other `it`s):
```ts
  for (const fw of FRAMEWORKS) {
    it(`[${fw}] swapping the db engine round-trips byte for byte`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `stacky-swap-${fw}-`))
      const pgStack: Manifest = { bricks: { vite: {}, [fw]: {}, postgres: {}, drizzle: {} }, overrides: {} }
      const sqliteStack: Manifest = { bricks: { vite: {}, [fw]: {}, sqlite: {}, drizzle: {} }, overrides: {} }

      await converge(dir, structuredClone(pgStack))
      const pgSnap = await snapshotTree(dir)

      await converge(dir, structuredClone(sqliteStack))
      const initFile = fw === 'sveltekit' ? 'app/src/hooks.server.ts' : 'app/src/server.ts'
      const init = await readFile(join(dir, initFile), 'utf8')
      expect(init).toContain('drizzle-orm/better-sqlite3')
      expect(init).not.toContain('node-postgres')
      expect(await readFile(join(dir, 'app/drizzle.config.ts'), 'utf8')).toContain("dialect: 'sqlite'")
      expect(await readFile(join(dir, 'ops/compose.yml'), 'utf8')).not.toContain('postgres')

      await converge(dir, structuredClone(pgStack))
      expect(await snapshotTree(dir)).toEqual(pgSnap)
    })
  }

  it('adding drizzle with two engines and none chosen is ambiguous', async () => {
    const registry = await loadRegistry(bricksDir)
    const r = resolve({ bricks: { vite: {}, sveltekit: {}, drizzle: {} }, overrides: {} }, registry)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected an ambiguous resolution')
    const ambiguous = r.errors.find((e) => e.kind === 'ambiguous')
    expect(ambiguous).toMatchObject({ kind: 'ambiguous', capability: 'sql-db', candidates: ['postgres', 'sqlite'] })
  })
```

- [ ] **Step 2: Add the sqlite golden**

In `packages/core/tests/round-trip.test.ts`, inside `describe('golden files — per framework', ...)` (after the framework loop), add:
```ts
  it('[sveltekit] sqlite stack matches the committed goldens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-golden-sqlite-'))
    await converge(dir, { bricks: { vite: {}, sveltekit: {}, sqlite: {}, drizzle: {} }, overrides: {} })
    await expect(await readFile(join(dir, 'app/drizzle.config.ts'), 'utf8'))
      .toMatchFileSnapshot('./golden/sqlite.drizzle.config.ts')
    await expect(await readFile(join(dir, 'app/src/hooks.server.ts'), 'utf8'))
      .toMatchFileSnapshot('./golden/sqlite.hooks.server.ts')
    await expect(await readFile(join(dir, 'db/schema.ts'), 'utf8'))
      .toMatchFileSnapshot('./golden/sqlite.schema.ts')
  })
```

- [ ] **Step 3: Generate goldens and run**

Run: `pnpm vitest run packages/core/tests/round-trip.test.ts -u`
Expected: PASS; three new goldens written under `packages/core/tests/golden/`.

- [ ] **Step 4: Inspect the sqlite goldens (load-bearing)**

Confirm by eye:
- `sqlite.drizzle.config.ts` has `dialect: 'sqlite'`.
- `sqlite.hooks.server.ts` — the `stacky:server-init` region contains BOTH `import Database from 'better-sqlite3'` / `export const sqlite = new Database(...)` (engine, first — `db-engine` sorts before `orm`) AND `import { drizzle } from 'drizzle-orm/better-sqlite3'` / `export const db = drizzle(process.env.DATABASE_URL!)` (drizzle), with no duplicate `Database` import and no `node-postgres`.
- `sqlite.schema.ts` uses `sqliteTable` from `drizzle-orm/sqlite-core`.

- [ ] **Step 5: Add sqlite artifact validation**

In `packages/core/tests/artifacts.test.ts`, parameterize `buildStack` on the engine (default `postgres`, so existing calls are unchanged):
```ts
async function buildStack(fw: 'sveltekit' | 'tanstack-start', engine: 'postgres' | 'sqlite' = 'postgres'): Promise<string> {
  const reg = await loadRegistry(bricksDir)
  const r = resolve({ bricks: { vite: {}, [fw]: {}, caddy: {}, [engine]: {}, drizzle: {} }, overrides: {} }, reg)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  const dir = await mkdtemp(join(tmpdir(), 'stacky-artifact-'))
  await apply(await plan(r.graph, { projectDir: dir, lock: emptyLock(), overrides: {} }), dir, r.graph)
  return dir
}
```
Then add inside `describe('generated artifacts are valid', ...)`:
```ts
  it('[sqlite] compose has no database service and still validates', async ({ skip }) => {
    if (!(await has('docker'))) skip()
    const dir = await buildStack('sveltekit', 'sqlite')
    expect(await readFile(join(dir, 'ops/compose.yml'), 'utf8')).not.toContain('postgres')
    const { stdout } = await run('docker', ['compose', '-f', join(dir, 'ops/compose.yml'), 'config'])
    expect(stdout).toContain('web')
  })
```
(If `readFile` is not already imported in this file, add it to the `node:fs/promises` import.)

- [ ] **Step 6: Full suite + typecheck**

Run: `pnpm vitest run && pnpm tsc -b`
Expected: PASS. The gate now proves: each engine round-trips; Drizzle selects its engine variant; swapping Postgres↔SQLite is byte-identical after swapping back; `add drizzle` with two engines is ambiguous; the SQLite stack has no database service.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test(core): prove engine swap, ambiguity, and sqlite artifacts"
```

---

## Self-Review

**Spec coverage:**
- Slot split `db` → `db-engine` + `orm` → Task 2. ✅
- `pg-driver`/`sqlite-driver` driver capabilities → Task 2 (postgres), Task 3 (sqlite). ✅
- `when`-gated variant mechanism (files + inject + fragments, uniform) → Task 1. ✅
- sqlite brick (service-less, `DATABASE_URL` file path, raw `sqlite` export, `data/.gitkeep`) → Task 3. ✅
- Drizzle gated variants (schema, config, server-init; connection-string form) → Task 3. ✅
- Engine exclusivity + ambiguity-as-data → enforced by the single-occupancy `db-engine` slot (Task 2) + resolver; asserted in Task 4. ✅
- Census updated, round-trip both frameworks, engine-swap capstone, sqlite goldens, artifact validation → Tasks 3–4. ✅
- No new error kind (safe by construction) → Task 1 invariant. ✅

**Placeholder scan:** every code step carries complete content; the one runtime uncertainty (better-sqlite3 string form) has an explicit documented fallback, not a TODO.

**Type consistency:** `when?: string` is added identically to `FileSpec`/`FragmentSpec`/`InjectSpec` (Task 1) and consumed via `gatePasses(spec.when, provided)` in all three tiers. `providedCapabilities(graph)` reads `brick.provides` (a `string[]`, matching `types.ts`). Driver capability names `pg-driver`/`sqlite-driver` are declared in the engines' `[provides]` (Tasks 2–3) and referenced verbatim in drizzle's `when` gates (Task 3). Slot names `db-engine`/`orm` are declared in `slots.toml` (Task 2) and used as brick `slot` values (Tasks 2–3).

**Ordering:** core primitive (1) precedes the registry changes that use it (3); the slot rename (2) is an isolated green step; sqlite + drizzle variants (3) keep the suite green by adapting the round-trip loop; new proofs (4) are purely additive. Every task ends green with a commit.
