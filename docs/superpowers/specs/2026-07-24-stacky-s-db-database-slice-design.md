# Stacky S-DB — Database Slice Design

**Goal:** Add SQLite as a second, swappable database engine alongside Postgres, and make Drizzle engine-aware, proving the registry can host two providers of one capability that a consumer selects between.

**Architecture:** Split the multi-occupancy `db` slot into two single-occupancy slots (`db-engine`, `orm`) so engines are mutually exclusive; add a capability-gated variant mechanism (`when`) so a brick emits the contribution matching whichever peer capability is in the resolved graph. No production framework code changes — this is registry + one small core primitive + tests.

**Tech Stack:** `@stacky/core` (TypeScript strict, ESM, Node ≥22), the brick registry (TOML + fragments), Drizzle ORM, `pg`, `better-sqlite3`.

## Context

This is the **first slice of catalog expansion** (the "next phase" after phase-2a multi-framework). Phase 2a shipped `postgres` (engine) + `drizzle` (ORM) coexisting in one multi-occupancy `db` slot. This slice adds `sqlite` as a peer engine and generalizes `drizzle` to work with either. It is deliberately **framework-neutral** (the db bricks already proved identical across SvelteKit and TanStack Start in phase 2a), so it hardens the resolver's engine-exclusivity story on familiar ground before later slices (styling, auth) introduce the Svelte↔React parity split.

It also pays down two items the phase-2a final review flagged and deferred:
- **Latent gap #2** — two engines could both satisfy `sql-db` in the multi-occupancy `db` slot with no error. The slot split closes this.
- The `db` slot comment overstating the exclusivity guarantee. Removed by the restructure.

## Non-goals (deferred, not cancelled)

- **A second ORM** (Prisma, Kysely) — the general engine↔ORM payload mechanism is not built. The `when`-gated approach is chosen precisely because a third *engine* is additive; a second *ORM* is the trigger to revisit, not now.
- **More engines** — MySQL, libsql/Turso. Only `postgres` (exists) + `sqlite` (new) are in scope, per the catalog's backend group.
- **SQLite production persistence** — no volume mount on the `web` service for the db file. SQLite here is the "zero-infra" engine; deploy-time persistence is out of scope.
- **The pnpm `catalog:` / exact-pin version-policy layer (F1)** — bricks keep inline `^` ranges as in phase 2a. F1 is its own later slice.

## Key decisions

| Decision | Chosen | Why |
|---|---|---|
| Brick granularity | Per-capability (an engine, an ORM) | Established for catalog expansion; a brick is a unit of composition, not a version group. |
| Engine coexistence | Mutually exclusive via single-occupancy `db-engine` slot | You never run two engines; a `db` multi-slot can't express that. |
| Slot shape | `db` → `db-engine` (single) + `orm` (single) | Engine and ORM are separate single choices. |
| Engine selection by ORM | Capability-gated variants (`when`), option A | Keeps `add drizzle` generic and engine-neutral; a third engine is additive; the new primitive is small and reusable. |
| `drizzle` connection form | Connection-string form for **both** engines (`drizzle(process.env.DATABASE_URL!)`) | Symmetric, self-contained, avoids duplicating the engine's driver import in the aggregated `server-init` region. |
| SQLite env | Reuse single `DATABASE_URL` as a file path | One variable; `better-sqlite3` and drizzle-kit both take the path via `url`. |
| SQLite infra | No compose service, no `container-runtime` | It's an embedded file DB; swapping to it visibly shrinks `compose.yml`. |

---

## §1 — Slot restructure & brick map

`bricks/slots.toml` becomes (order is the composed-file merge order — unchanged for existing slots, `db` replaced by the two new slots at the same position):

```toml
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
# Engines are mutually exclusive: at most one database engine per project.
[[slot]]
name = "db-engine"
single = true
# The ORM sits in its own single slot and selects its engine wiring via `when`.
[[slot]]
name = "orm"
single = true
```

Brick responsibilities:

| Brick | Slot | Provides | Requires | Notes |
|---|---|---|---|---|
| `postgres` | `db-engine` | `sql-db`, **`pg-driver`** | `container-runtime` | Compose service unchanged; injects raw `pg` `Pool` (`export const pool`). |
| `sqlite` *(new)* | `db-engine` | `sql-db`, **`sqlite-driver`** | *(none)* | No compose service; injects raw `better-sqlite3` handle (`export const sqlite`). |
| `drizzle` | `orm` | `orm` | `sql-db` | `server-init`, `drizzle.config.ts`, and `db/schema.ts` become `when`-gated variants (`pg-driver` / `sqlite-driver`). |

**Exclusivity behavior:** `db-engine` single-occupancy makes `postgres` and `sqlite` unable to coexist (slot-conflict if both are added). When `drizzle` auto-pulls an engine and both are candidates with none selected, the resolver returns `ambiguous` with candidates `[postgres, sqlite]` (exit 2, "pick an engine") — the existing data-not-prompt path.

---

## §2 — The `when`-gated variant mechanism (core)

A brick contribution may carry an optional `when = "<capability>"`. The planner emits the contribution only if that capability is provided by some brick in the **resolved** graph.

### Types (`packages/core/src/types.ts`)

Add an optional `when?: string` to the contribution spec types:

```ts
export interface FileSpec {
  from: string
  to: string
  when?: string      // NEW — gating capability
}

export interface InjectSpec {
  point?: string
  target?: string
  marker?: string
  from: string
  when?: string      // NEW
}

export interface FragmentSpec {
  target: string
  from: string
  strategy: 'yaml' | 'lines' | 'json'
  when?: string      // NEW — parsed uniformly; not exercised by S-DB
}
```

### Registry parse (`packages/core/src/registry.ts`)

`parseFile`, `parseInject`, `parseFragment` read the optional `when` string (validate: if present, non-empty string). No other parse change.

### Planner filter

The planner already resolves the full graph. Compute once, in the plan context, the set of capabilities provided by all in-graph bricks:

```ts
const provided = new Set(graph.bricks.flatMap((b) => b.brick.provides.capabilities))
```

Each tier skips a spec whose `when` is set and not in `provided`:
- `tier-brick.ts` (files): skip gated files that don't match before writing brick-owned files.
- `tier-inject.ts` (inject): skip gated inject specs before grouping contributors by `target#marker`.
- `tier-composed.ts` (fragments): skip gated fragments (uniform; unused by S-DB).

`when: undefined` ⇒ always emitted (existing behavior, unchanged).

### Invariants — safe by construction, no new validation

- **At most one variant per group fires.** `db-engine` is single-occupancy ⇒ at most one engine ⇒ at most one of `{pg-driver, sqlite-driver}` in `provided` ⇒ at most one variant in each gated pair. No same-`to` collision to guard.
- **Exactly one fires when `drizzle` is present.** `drizzle` requires `sql-db`; every engine provides `sql-db` **and** a driver capability ⇒ if `drizzle` is in the graph, exactly one driver capability is present ⇒ exactly one variant fires. No "zero variants, broken app" case.

No new error kind, no exhaustiveness checker. The slot design makes the gates mutually exclusive and total.

### Preservation

Gating is a pure function of the resolved graph ⇒ output stays deterministic and byte-stable. Ownership tiers are unchanged: `drizzle.config.ts` and `db/schema.ts` remain brick-owned by `drizzle` (variant-selected), so the add→remove round-trip stays byte-for-byte.

---

## §3 — Brick specs

### `postgres` (migration)

- `brick.toml`: `slot = "db"` → `slot = "db-engine"`; add `pg-driver` to `[provides].capabilities` (now `["sql-db", "pg-driver"]`). Everything else unchanged (requires `container-runtime`; composes compose service, `.env.example` line, `package.json`; injects raw `pool` into `server-init`).

### `sqlite` (new — `bricks/db/sqlite/`)

```toml
# brick.toml
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

- `fragments/env` (lines): `DATABASE_URL=./data/app.db`
- `fragments/package.json` (json): `dependencies: { "better-sqlite3": "^13.0.0" }`, `devDependencies: { "@types/better-sqlite3": "^7.6.0" }` (matches the catalog's `better-sqlite3 ^13`; open question #2 covers reconciling the existing drizzle/postgres ranges).
- `fragments/server-init.ts` (raw client, exported name `sqlite` to avoid colliding with drizzle's `db`):
  ```ts
  import Database from 'better-sqlite3'

  export const sqlite = new Database(process.env.DATABASE_URL!)
  ```
- `files/.gitkeep`: empty, so `data/` exists for the db file.
- No compose service, no `container-runtime` requirement — the defining asymmetry with `postgres`.

### `drizzle` (refactor to gated variants)

- `brick.toml`: `slot = "db"` → `slot = "orm"`. Replace the single `drizzle.config.ts` file, single `schema.ts` file, and single `server-init` inject with **gated pairs**:

```toml
slot = "orm"
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

- `package.json` fragment: **unchanged and engine-neutral** — `drizzle-orm` + `drizzle-kit` + the `db:generate`/`db:migrate` scripts. The engine driver package (`pg` / `better-sqlite3`) comes from the engine brick.
- `drizzle.config.*.ts` differ only in `dialect` (`'postgresql'` vs `'sqlite'`); `schema`, `out`, and `dbCredentials: { url: process.env.DATABASE_URL! }` are identical.
- `server-init.pg.ts` (unchanged from today):
  ```ts
  import { drizzle } from 'drizzle-orm/node-postgres'

  export const db = drizzle(process.env.DATABASE_URL!)
  ```
- `server-init.sqlite.ts` — **connection-string form, no `better-sqlite3` import** (so it never duplicates the `sqlite` engine's `import Database`; self-contained; exports `db`):
  ```ts
  import { drizzle } from 'drizzle-orm/better-sqlite3'

  export const db = drizzle(process.env.DATABASE_URL!)
  ```
- `schema.pg.ts` — `import { pgTable, serial, text } from 'drizzle-orm/pg-core'` + a minimal example table.
- `schema.sqlite.ts` — `import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'` + the equivalent minimal table.

**Aggregated `server-init` when `sqlite` + `drizzle` are both present** (graph order: `db-engine` before `orm`):
```ts
// engine (sqlite):
import Database from 'better-sqlite3'
export const sqlite = new Database(process.env.DATABASE_URL!)
// orm (drizzle, sqlite variant):
import { drizzle } from 'drizzle-orm/better-sqlite3'
export const db = drizzle(process.env.DATABASE_URL!)
```
No duplicate imports (engine imports `Database`; drizzle imports `drizzle`), no export-name collision (`sqlite` vs `db`) — the phase-2a self-contained, order-independent contributor pattern is preserved.

---

## §4 — Acceptance gate

Extends the registry-derived round-trip gate (`packages/core/tests/round-trip.test.ts`); `sqlite` and the `orm`-slot `drizzle` enter coverage automatically.

- **Census** assertion updates to `['caddy','drizzle','postgres','sqlite']`.
- **Each engine round-trips standalone** against both frameworks (add `postgres`/`sqlite` to `{vite, fw}`, remove, byte-identical).
- **`drizzle` no longer round-trips against a bare `{vite, fw}` base** — with two engines providing `sql-db`, `add drizzle` alone is ambiguous. So the `drizzle` round-trip case carries an explicit engine in its base.
- **New ambiguity assertion:** `add drizzle` with both engines available and none chosen → `ambiguous`, candidates `[postgres, sqlite]`, exit 2 (the db-side mirror of phase-2a's "add postgres alone is ambiguous with two frameworks").
- **Capstone — engine swap is byte-identical:** `{vite, fw, postgres, drizzle}` → `{vite, fw, sqlite, drizzle}` flips `server-init`, `drizzle.config.ts`, and `db/schema.ts` to the sqlite variants and drops the postgres compose service → swap back → byte-for-byte identical to the postgres stack. One test exercising gated variants + engine exclusivity + clean removal together.
- **Per-engine goldens:** `drizzle.config.ts` (postgresql vs sqlite dialect), the `server-init` region, and `compose.yml` (with vs without the postgres service).
- **Artifact validation:** `docker compose config` still passes for the postgres stack; the sqlite stack has no compose service to validate (assert the compose file has no `postgres` service and the app still builds).

---

## Open questions / verify during implementation

1. **`drizzle-orm/better-sqlite3` connection-string form.** The design assumes `drizzle(process.env.DATABASE_URL!)` accepts a file-path string for the better-sqlite3 dialect (mirroring node-postgres). Verify against the pinned `drizzle-orm` version. If the string form is unavailable, fall back to referencing the engine's exported `sqlite` handle (`drizzle(sqlite)`) — safe because `db-engine` sorts before `orm`, so `sqlite` is defined first in the aggregated region — at the cost of self-containment.
2. **Exact dependency ranges.** The catalog names `better-sqlite3 ^13` and `drizzle-orm ^0.45` / `drizzle-kit ^0.31`; the current bricks pin older ranges. Reconcile at plan time (this slice keeps inline ranges; the `catalog:` layer is deferred).
3. **`schema.ts` starter content.** Kept as a minimal engine-appropriate example table so it faithfully exercises `when`-gating on a brick-owned file. If a truly neutral stub is preferred, `schema.ts` could drop out of the gated set — but the example is more useful and a better test.
