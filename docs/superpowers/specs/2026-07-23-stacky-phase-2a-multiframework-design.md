# Stacky Phase 2a — the composer isn't framework-locked

**Date:** 2026-07-23
**Status:** Approved design, ready for implementation planning
**Builds on:** `2026-07-22-stacky-composable-stack-cli-design.md` (phase 1, merged)

## Problem

Phase 1 proved the three-tier ownership model end to end, but it baked SvelteKit
into the foundation. The `sveltekit` brick owns the Dockerfile, contributes the
Compose web service, and owns the build scripts; the `postgres` brick injects into
a hardcoded `app/src/hooks.server.ts`. Swapping SvelteKit for another framework
would mean rewriting the db bricks. That's the opposite of composable.

The gap: a build/runtime foundation that is shared across frameworks, and an
injection mechanism where a db brick targets a *named seam* ("server init") rather
than a framework-specific file path — so the same db brick works whether the web
layer is SvelteKit or TanStack Start.

## Goal

Restructure the registry so the composer is not locked to Svelte:

1. **Concern taxonomy** — a *concern* is one axis unifying slot, registry group, and
   output-folder root.
2. **Vite barebone base** — extract build + Docker + Compose-web-service into a
   `build/vite` brick that both frameworks layer onto.
3. **Capability-named injection points** — a publish/consume mechanism that lets a
   brick inject into a *named seam* resolved to whatever brick publishes it, instead
   of a hardcoded path.
4. **A second framework** — `web/tanstack-start` as a peer to SvelteKit, proving the
   portability claim.
5. **Extended acceptance gate** — the round-trip property, run against both framework
   stacks, with the db bricks identical across both.

## Non-goals (deferred, not cancelled)

- `auth` concern / `caddy-auth` brick — needs a `session-store` capability that only
  redis (or postgres-sessions) provides; redis is out of scope for 2a.
- `redis`, `gh-actions`, `tanstack-query` bricks.
- `stacky graph`, generated `AGENTS.md` in target projects, brick versioning /
  `stacky upgrade`, the web node editor.
- Phase-1 carry-over findings P2-A (apply writes lock once at end vs per-op
  checkpointing) and P2-B (`.stacky-new` + `--force` unreachable via CLI) — unless
  the injection-point work forces touching `apply.ts`, in which case fix opportunistically.

## Key decisions

| Decision | Chosen | Why |
|---|---|---|
| Registry organization | Concern = slot = registry group = output root | Delivers the "dispatched into folders" vision; gives `brick new` a taxonomy |
| Build foundation | A `build/vite` brick both frameworks require | One place owns Docker/Compose-web/scripts; frameworks stay thin |
| Injection mechanism | Capability-named injection points (publish/consume) | Db bricks target a seam, not a path — the core portability enabler |
| Injection-point resolution | Reuse the capability resolver, don't build a parallel system | "publishes point N" ≡ "provides `inject:N`"; "consumes N" ≡ "requires `inject:N`" |
| Framework→build coupling | Framework `requires build`; injects into `vite-plugins` | Explicit dependency + contribution, both resolving to the sole Vite provider |
| Portability proof | Same db bricks round-trip against both framework stacks | Portability = db bricks identical across runs, not a stack with both frameworks |

## Concern taxonomy

A *concern* unifies three things phase 1 kept separate:

```
concern     slot        registry            output root       bricks
─────────   ─────────   ─────────────────   ───────────────   ───────────────────────────
container   container   bricks/container/   ops/              compose
build       build       bricks/build/       app/              vite            (new)
web         web         bricks/web/         app/              sveltekit, tanstack-start (tanstack new)
edge        edge        bricks/edge/        ops/caddy/        caddy
db          db          bricks/db/          db/               postgres, drizzle (drizzle new)
```

- **`bricks/slots.toml`** is reordered to `container, build, web, edge, db`. Slot
  declaration order is still the fragment-merge tiebreaker, so this ordering is
  load-bearing for byte-stability — changing it later rewrites diffs.
- **Registry folders**: bricks move into `bricks/<concern>/<name>/`. `loadRegistry`'s
  glob changes from `bricks/*/brick.toml` to `bricks/*/*/brick.toml`. The brick's
  declared `slot` still governs resolution; the folder is organizational, not
  authoritative.
- **Output roots are convention, not enforced.** Bricks keep declaring explicit `to =`
  paths. `build` and `web` bricks both write under `app/` (Vite → `app/vite.config.ts`,
  SvelteKit → `app/src/`), so concern does not map one-to-one to an exclusive output
  directory. The lockfile remains the authoritative ownership record (phase 1); adding
  a validated concern→root rule would prevent no failure the lockfile doesn't already
  catch (YAGNI).

## Capability-named injection points

### The mechanism

Phase 1's inject named a hardcoded path. Phase 2a splits that into a publish/consume pair.

**A provider brick publishes a named point.** It still owns the host file via `[[files]]`;
this block just announces where the marker lives:

```toml
# bricks/web/sveltekit/brick.toml
[[injection_points]]
name   = "server-init"
target = "app/src/hooks.server.ts"
marker = "stacky:server-init"

# bricks/web/tanstack-start/brick.toml
[[injection_points]]
name   = "server-init"
target = "app/src/server.ts"          # different file, same point name
marker = "stacky:server-init"

# bricks/build/vite/brick.toml
[[injection_points]]
name   = "vite-plugins"
target = "app/vite.config.ts"
marker = "stacky:vite-plugins"
```

**A consumer injects into the point, never a path:**

```toml
# bricks/db/postgres/brick.toml
[[inject]]
point = "server-init"                  # resolved to whoever publishes it
from  = "fragments/server-init.ts"

# bricks/web/sveltekit/brick.toml
[[inject]]
point = "vite-plugins"
from  = "fragments/plugin.ts"
```

The phase-1 explicit form (`[[inject]]` with literal `target` + `marker`) remains
valid, for a brick injecting into its own file. Phase 2a introduces no such case, but
the parser accepts both. Exactly one of `point` or (`target` + `marker`) must be present
on an `[[inject]]` entry.

### Resolution — reuse the capability graph

An injection point is a capability with extra metadata:

- Registry: each `[[injection_points]]` entry `{name = N, target, marker}` on brick B is
  recorded as B **providing capability `inject:N`**, carrying metadata `{brick: B, target, marker}`.
- Consumer: an `[[inject]] point = N` on brick C is recorded as C **requiring capability `inject:N`**.
- `resolve()` runs its existing fixed-point capability iteration unchanged:
  - the publisher is already in the graph (pulled by another capability) → satisfied;
  - exactly one publisher in the registry, not yet in the graph → auto-add it;
  - ≥2 publishers, none in the graph → `ambiguous-injection-point`;
  - zero publishers → `unsatisfiable-injection-point`.
- After resolution, for each consumer `[[inject]] point = N`, the planner looks up the
  selected provider of `inject:N` in the graph, reads its `{target, marker}`, and hands
  `{target, marker, from}` to the **unchanged phase-1 inject tier**.

This is why `postgres requires ssr` is deleted: postgres consuming `server-init` already
requires *some* publisher of it. With two frameworks in the registry and none selected,
that surfaces as `ambiguous-injection-point` — "pick a web framework" — which is more
precise than the phase-1 `requires ssr` and drops out of the same machinery.

### Multi-contributor injection

`server-init` gets two contributors: `postgres` (pg pool) and `drizzle` (ORM client
wrapping the pool). Phase 1's inject tier already merges multiple bricks under one
marker region with per-brick comments, but only ever ran with a single contributor.
Wiring drizzle behind postgres exercises the multi-contributor path deliberately; the
round-trip gate then proves `remove drizzle` leaves postgres's pool line byte-intact.

## Brick roster

Legend: **owns** = `[[files]]` · **composes** = `[[fragments]]` · **publishes** =
`[[injection_points]]` · **injects** = `[[inject]] point` · **req/prov** = capabilities.

### `container/compose` — unchanged but relocated to `bricks/container/`
- composes: `ops/compose.yml` base, `config/.env.example` base
- provides: `container-runtime`

### `build/vite` — new; the barebone base everything layers on
- owns: `app/vite.config.ts` (skeleton with `stacky:vite-plugins` marker),
  `app/Dockerfile` (multi-stage node build → runtime), `app/.dockerignore`
- composes: `app/package.json` (base — `dev`/`build`/`preview` scripts, `type: module`,
  `vite` devDep; `json` strategy), `ops/compose.yml` (the `web` service — build context,
  `${PORT}` mapping, `depends_on`)
- publishes: `vite-plugins` → `app/vite.config.ts` @ `stacky:vite-plugins`
- params: `port` (string, default `"5173"`)
- requires: `container-runtime` · provides: `build`

### `web/sveltekit` — refactored: slimmed to layer onto Vite
- owns: `app/src/` (routes, `app.html`, `hooks.server.ts` with `stacky:server-init` marker).
  **No longer owns** the Dockerfile, and **no longer composes** the Compose web service —
  those moved to Vite.
- composes: `app/package.json` (`@sveltejs/kit` + `svelte` deps, `check` script; `json` strategy)
- injects: `vite-plugins` ← `@sveltejs/kit/vite` plugin line
- publishes: `server-init` → `app/src/hooks.server.ts` @ `stacky:server-init`
- requires: `build` · provides: `http-origin`

### `web/tanstack-start` — new; the portability proof (React peer)
- owns: `app/src/` (React entry, router, `server.ts` with `stacky:server-init` marker)
- composes: `app/package.json` (`@tanstack/react-start` + `react`/`react-dom` deps; `json` strategy)
- injects: `vite-plugins` ← TanStack Start Vite plugin line
- publishes: `server-init` → `app/src/server.ts` @ `stacky:server-init`
- requires: `build` · provides: `http-origin`

### `edge/caddy` — unchanged but relocated to `bricks/edge/`
- owns: `ops/caddy/Caddyfile` · composes: `ops/compose.yml`, `config/.env.example`
- requires: `http-origin`, `container-runtime` · provides: `http-edge`

### `db/postgres` — refactored: `requires ssr` deleted, now point-driven
- composes: `ops/compose.yml` (postgres service), `config/.env.example` (DB vars);
  owns `db/migrations/0001_init.sql` (unchanged)
- injects: `server-init` ← pg pool init (was a hardcoded `target`; now `point`)
- requires: `container-runtime` · provides: `sql-db`

### `db/drizzle` — new; second `server-init` contributor
- owns: `db/schema.ts`, `app/drizzle.config.ts`
- composes: `app/package.json` (`db:generate`/`db:migrate` scripts + `drizzle-orm`/`drizzle-kit`
  deps; `json` strategy)
- injects: `server-init` ← Drizzle client wrapping the pg pool
- requires: `sql-db` · provides: `orm`

### Capability chain (whole registry)

```
compose ──provides──▶ container-runtime
vite ──requires──▶ container-runtime ; ──provides──▶ build ; ──publishes──▶ vite-plugins
sveltekit / tanstack-start ──requires──▶ build ; ──provides──▶ http-origin ;
    ──publishes──▶ server-init ; ──injects──▶ vite-plugins
caddy ──requires──▶ http-origin, container-runtime ; ──provides──▶ http-edge
postgres ──requires──▶ container-runtime ; ──provides──▶ sql-db ; ──injects──▶ server-init
drizzle ──requires──▶ sql-db ; ──provides──▶ orm ; ──injects──▶ server-init
```

The `ssr` capability from phase 1 is dropped: nothing requires it once postgres is
point-driven. Frameworks provide `http-origin` (caddy's requirement) only.

## CLI build step (infra, not a brick)

Phase 1's final review flagged `bin: stacky` as unrunnable without compilation. Phase 2a
adds a real build step to `packages/cli`: a `tsup` (or `tsc` emit) that produces runnable
JS, plus `package.json` `bin`/`files`/`prepublishOnly` wiring so a globally installed or
`npx`'d `stacky` runs under plain `node`. One plan task; no behavior change to the CLI's
commands.

## Core API changes

The four-function API (`loadRegistry` → `resolve` → `plan` → `apply`) is unchanged in
shape. The changes are internal and additive:

- **registry** — parse `[[injection_points]]`; emit each as an `inject:<name>` capability
  provider carrying `{target, marker}`. Glob `bricks/*/*/brick.toml`. Accept `json` as a
  fragment `strategy` (alongside `yaml`/`lines`).
- **types** — `Brick` gains `injectionPoints: { name, target, marker }[]`. The `[[inject]]`
  entry type becomes `{ point?: string } | { target: string, marker: string }` plus `from`.
- **merge** — new `json` fragment strategy: deep-merge contributed JSON objects (reusing the
  existing `deepMerge`), serialize with recursively-sorted keys and a trailing newline (the
  same byte-stability guarantee `sortMapEntries` gives yaml), and carry the generated-file
  banner as a `"//"` key, since JSON forbids comments and npm tolerates a `"//"` key.
- **resolve** — no new algorithm; injection points ride the existing capability iteration.
  Two new `ResolutionError` kinds (below) wrap the capability errors so messages name the point.
- **plan (inject tier only)** — resolve each consumer's `point` to the publisher's
  `{target, marker}` before handing to the existing inject machinery. `apply` untouched.

### `app/package.json` is composed, and user edits use the phase-1 conflict path

`package.json` is the one file users edit constantly (`npm install <x>` rewrites it). Because
it's a composed file, an out-of-band edit makes its on-disk hash diverge from the lockfile,
so the next `plan` emits a `conflict` op and writes `app/package.json.stacky-new` beside the
user's file — never a silent clobber (exactly the phase-1 behavior for an edited composed
file). The user reconciles once; persistent deviations live in a `stack.toml` override block.
Phase 2a deliberately does **not** introduce a fourth "merge-into-existing" ownership tier —
that stays a phase-1-consistent conflict, keeping 2a's scope on portability. This is the one
UX rough edge of the design and is called out here as a known limitation.

## Error handling

New resolution errors — both wrap the capability machinery so the message names the point:

| kind | Trigger | CLI | Agent |
|---|---|---|---|
| `unsatisfiable-injection-point` | a brick injects into a point no brick publishes | error; name the point + the injecting brick | exit 1 |
| `ambiguous-injection-point` | a consumed point has ≥2 publishers, none in the graph | prompt to pick a publisher | exit 2 + candidate list |

`ambiguous-injection-point` reuses the existing `ambiguous`-capability picker. Selecting
two web bricks together remains the phase-1 `slot-conflict` (single-occupancy web slot) —
no new error. All other phase-1 error kinds and the `0`/`1`/`2` exit-code contract are
unchanged.

## Testing — the acceptance gate

The round-trip property test is the load-bearing gate, extended two ways:

1. **Derive the brick list from the registry**, not a hardcoded array (phase-1 finding:
   new bricks must not silently escape coverage). Every brick `loadRegistry` returns gets
   a round-trip case automatically.
2. **Run the round-trip against both framework stacks.** Two base manifests:
   - `vite + sveltekit + compose + caddy + postgres + drizzle`
   - `vite + tanstack-start + compose + caddy + postgres + drizzle`

   For each stack and each brick X: snapshot the tree, `add X`, `remove X`, assert the
   tree is byte-identical. The portability assertion is that the **same `postgres` and
   `drizzle` bricks inject into both frameworks' `server-init` with zero brick-side
   changes** — different target file (`hooks.server.ts` vs `server.ts`), identical brick.
   Both stacks green ⇒ framework portability holds.

The matrix is **per-framework sequential, not a cross-product**: the two frameworks can't
coexist in the single-occupancy `web` slot, so there is no "both at once" stack. Cost stays
linear (2 stacks × N bricks).

**Other test layers (extended from phase 1):**

- **Resolver units** — fixtures for `unsatisfiable-injection-point` and
  `ambiguous-injection-point`; auto-add of a sole point publisher; the postgres→ambiguous
  case when no web brick is selected.
- **Planner units** — the multi-contributor `server-init` merge (postgres + drizzle under
  one marker), and `point`-to-`{target, marker}` resolution against each framework.
- **Golden files** — a full-stack tree per framework, pinning `ops/compose.yml`,
  `config/.env.example`, `app/package.json` (proving the `json` deep-merge is byte-stable
  across contributors), and each framework's `app/vite.config.ts` (proving the
  `vite-plugins` injection is byte-stable).
- **Artifact validation** — `tsc --noEmit` on each generated `app/` (SvelteKit and TanStack
  Start each with their real toolchain) and `docker compose config` on each composed
  `ops/compose.yml`. All skip-if-tool-absent, like phase 1's caddy test, so a bare CI
  degrades to green-skips rather than failures.
- **CLI contract** — unchanged: snapshot `--json`, assert no-TTY termination.

## Done criteria

- Bricks live under `bricks/<concern>/<name>/`; `loadRegistry` reads the two-level glob.
- `build/vite` owns the build/Docker/Compose-web foundation; both frameworks are thin
  layers that require `build` and inject into `vite-plugins`.
- Injection points resolve through the capability graph; `postgres requires ssr` is gone.
- `web/tanstack-start` and `db/drizzle` exist and are registry-complete.
- The round-trip gate is registry-derived and green for both framework stacks, including
  the multi-contributor `server-init` case.
- `stacky` runs under plain `node` after the CLI build step.

## Open questions

Deferred; none blocks phase 2a.

- Whether `build` should ever host a second provider (e.g. a non-Vite base), which would
  make `vite-plugins` consumption non-portable and force framework bricks onto an abstract
  build seam. Not needed while Vite is the sole base.
- Whether `db/drizzle`'s `app/drizzle.config.ts` belongs under `app/` or a `db/` root —
  left as `app/` for tooling-discovery convenience; revisit if it causes ownership churn.
