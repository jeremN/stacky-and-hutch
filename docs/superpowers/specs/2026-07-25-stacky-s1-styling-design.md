# S1 — Styling Slice (Tailwind + Iconify) Design

**Date:** 2026-07-25
**Status:** Approved (brainstorm)
**Predecessors:** phase-1 (headless engine), phase-2a (multi-framework), S-DB (swappable database engine)

## Goal

Add the first **styling** slice to the catalog: a framework-agnostic `tailwind`
brick and a framework-specific `iconify` brick. In doing so, prove the
**Svelte↔React parity split** — the same brick produces the correct
framework-specific output on either stack — reusing S-DB's `when` gate primitive
against a new axis (framework *family* rather than database *engine*).

This is the slice that turns the frameworks from "server-barebone" into
"renderable app shells," because styling has no meaning without a client entry
to style.

## Context

Before S1, both web bricks are server-only: `sveltekit` owns just
`app/src/hooks.server.ts`; `tanstack-start` owns just `app/src/server.ts`.
Neither has a client entry, a root layout, or a route. There is nowhere for a
CSS import or an icon to land. S1 grows the minimal client shell that later
catalog slices (components, auth UI, etc.) hang on.

S1 also reuses, without modifying, the phase-2a injection-point mechanism and
the S-DB `when` gate. The only *new* engine work is a targeted fix to the
`vite-plugins` seam (Component 2), which today silently assumes a single
contributor.

## Scope

**In scope**
- Minimal app shell per framework (root layout + home route + family capability).
- Two new injection points published by each framework layout: `app-head`, `app-shell`.
- `vite-plugins` seam upgraded from single-contributor to multi-contributor (the `.push()` design).
- `tailwind` brick (framework-agnostic, slot `css`).
- `iconify` brick (`when`-gated Svelte/React variants, slot `icons`).
- New `styling` concern folder and two single-occupancy slots (`css`, `icons`).
- Acceptance gate: round-trip, per-framework goldens, the parity capstone, multi-contributor survival, Tailwind byte-agnosticism.

**Out of scope (deferred, explicit)**
- Component libraries (bits-ui / shadcn-style) — a later slice.
- Offline/bundled icon sets (`@iconify-json/*`) — S1 uses on-demand icons so the parity delta is exactly one import line.
- Runtime-render validation (a real `vite build` / `npm install` in CI). The current harness validates *structure* (`docker compose config`, `caddy validate`), not framework builds. S1 proves the generated wiring is byte-correct, not that a browser renders it. A future "build-smoke" capability can add this if wanted.
- A registry-load lint for capability-name references and injection-point publisher uniqueness — already recorded as deferred follow-up; S1 stays inside its safe envelope and does not widen the gap.

## Architecture Overview

The parity mechanism has three moving parts, all reusing existing primitives:

1. **Family capability.** Each framework `provides` a family name — `sveltekit`
   → `svelte`, `tanstack-start` → `react` — exactly as a database engine
   provides a driver capability in S-DB. Single-occupancy `web` slot ⇒ at most
   one family in any graph.

2. **Two consolidated injection points, both in the root layout:**
   - **`app-head`** — the import region (SvelteKit `<script>`, TanStack
     top-of-file). Style and component imports land here.
   - **`app-shell`** — a markup region (a `<header>` above the rendered
     children). Rendered widgets (an icon) land here.

3. **`when`-gated variants.** A brick whose emitted *bytes* differ by framework
   gates each variant on the family capability. A brick whose bytes are
   identical across frameworks needs no gate.

That third rule draws the whole design:

- **Tailwind** emits byte-identical contributions on both stacks (a Vite plugin
  registration and `import '../app.css'` — the relative path is identical from
  both layout files), so it is a **single, ungated** brick.
- **Iconify** emits a different import per framework
  (`import Icon from '@iconify/svelte'` vs `import { Icon } from '@iconify/react'`),
  so it ships two **`when`-gated** variant sets.

The parity proof, stated precisely: **among everything the two styling bricks
emit, the only framework-specific bytes are Iconify's single import line.**
Tailwind's contributions and Iconify's render markup are byte-identical across
stacks; the framework shell files themselves are framework-owned, not styling
output.

## Component 1 — Framework App-Shell Expansion

Each web brick (`sveltekit`, `tanstack-start`) gains three things.

### 1a. Family capability

```toml
# bricks/web/sveltekit/brick.toml
[provides]
capabilities = ["http-origin", "svelte"]
```
```toml
# bricks/web/tanstack-start/brick.toml
[provides]
capabilities = ["http-origin", "react"]
```

### 1b. Minimal client shell (brick-owned files)

- `sveltekit`: `app/src/routes/+layout.svelte` (root layout) + `app/src/routes/+page.svelte` (trivial home).
- `tanstack-start`: `app/src/routes/__root.tsx` (root route) + `app/src/routes/index.tsx` (trivial home).

The layout is the only file carrying seams; the home route just renders a
heading so the scaffold is visibly runnable. Exact framework boilerplate (Svelte
5 `{@render children()}`; TanStack `createRootRoute`/`Outlet`) is pinned in the
implementation plan, verified against current framework conventions. The design
contract for the layout is:

```svelte
<!-- app/src/routes/+layout.svelte (shape, not final bytes) -->
<script>
  let { children } = $props()
  // >>> stacky:app-head
  // <<< stacky:app-head
</script>

<header>
  <!-- >>> stacky:app-shell -->
  <!-- <<< stacky:app-shell -->
</header>

{@render children()}
```

The React layout carries the *same two markers* — `stacky:app-head` at the top
of file (JS comment), `stacky:app-shell` inside JSX (`{/* … */}` comment).

### 1c. Injection points published by the layout

```toml
# sveltekit
[[injection_points]]
name   = "app-head"
target = "app/src/routes/+layout.svelte"
marker = "stacky:app-head"

[[injection_points]]
name   = "app-shell"
target = "app/src/routes/+layout.svelte"
marker = "stacky:app-shell"
```

TanStack publishes the same two point *names* against `app/src/routes/__root.tsx`.
Both frameworks publishing `app-head`/`app-shell` makes them **multi-publisher**
points — safe today only because the two publishers share the single-occupancy
`web` slot and can never co-reside (identical to today's `server-init`). This is
the exact latent gap already recorded for the future registry-load lint; S1 does
not widen it.

## Component 2 — `vite-plugins`: Single → Multi-Contributor

**The problem.** The `vite-plugins` seam was built for exactly one contributor
(the framework). Its composed region redeclares the whole array:

```ts
// >>> stacky:vite-plugins
import { sveltekit } from '@sveltejs/kit/vite'
const stackyPlugins = [sveltekit()]
// <<< stacky:vite-plugins
```

The inject aggregator joins contributor bodies verbatim in graph order
(`parts.join('\n')`). A second contributor (Tailwind) would therefore produce
two `const stackyPlugins = [...]` statements in one region — a duplicate-`const`
**SyntaxError**. This is the styling-slice analogue of the db-slot exclusivity
gap S-DB flushed out: a latent single-occupancy assumption surfacing the moment
the catalog grows.

**The fix (chosen: the `.push()` design).** Pre-declare the array *outside* the
seam; every contributor pushes onto it:

```ts
// app/vite.config.ts (build/vite brick, after fix)
import { defineConfig } from 'vite'
const stackyPlugins = []
// >>> stacky:vite-plugins
// <<< stacky:vite-plugins
export default defineConfig({ plugins: stackyPlugins })
```

Each framework's `fragments/plugin.ts` changes from redeclaring the array to
pushing onto it:

```ts
// bricks/web/sveltekit/fragments/plugin.ts
import { sveltekit } from '@sveltejs/kit/vite'
stackyPlugins.push(sveltekit())
```

Tailwind's fragment is the parallel `import tailwindcss from '@tailwindcss/vite'; stackyPlugins.push(tailwindcss())`.
Aggregated, they coexist cleanly. A zero-contributor region is now valid too
(`stackyPlugins` stays `[]`), which the old design would have broken.

**Why this design over a two-seam array literal** (decision, recorded for the
plan): the `vite-plugins` seam is the second of many "collect contributions into
one place" code seams (server-init exists; middleware chains, provider wrappers,
router registration will follow). `.push()` keeps a *single* additive-seam
convention across the catalog, matching how `server-init` already aggregates
(imports + statements inside the region, joined verbatim). It runs with the
grain of the line-oriented text engine, which cannot validate an
expression-list protocol. A two-seam array literal (`plugins: [sveltekit(), tailwindcss()]`)
reads prettier but reintroduces a latent multi-contributor footgun — a fragment
that forgets its trailing comma yields a SyntaxError that appears *only when a
second contributor lands* — which is precisely the class of bug this fix exists
to remove. The one honest wart (imports sit mid-file, which ESM hoists but
`import/first` would flag) already exists in `server-init`; if a future lint
slice forces top-of-file imports, all seams migrate to a two-region convention
together, as one coherent change rather than a per-seam divergence now.

**Blast radius:** `build/vite` template (`files/vite.config.ts`), both framework
`fragments/plugin.ts`, and the two committed `*.vite.config.ts` goldens. All
mechanical.

## Component 3 — The `tailwind` Brick (framework-agnostic)

`bricks/styling/tailwind/`, slot **`css`** (single-occupancy).

```toml
[brick]
name    = "tailwind"
slot    = "css"
summary = "Tailwind CSS v4 via the Vite plugin"

# No [requires]: its point-based injects (below) synthesize the framework
# requirement transitively.

[[files]]
from = "files/app.css"
to   = "app/src/app.css"

[[fragments]]
target   = "app/package.json"
from     = "fragments/package.json"
strategy = "json"

[[inject]]
point = "vite-plugins"
from  = "fragments/plugin.ts"

[[inject]]
point = "app-head"
from  = "fragments/head.ts"
```

- **`files/app.css`** — one line, `@import "tailwindcss";`. Tailwind v4 is
  CSS-first: no `tailwind.config.js`, no `postcss.config.js`; the
  `@tailwindcss/vite` plugin auto-detects content. Brick-owned ⇒ deleted cleanly
  on `remove tailwind`.
- **`fragments/plugin.ts`** — `import tailwindcss from '@tailwindcss/vite'; stackyPlugins.push(tailwindcss())` (rides the Component-2 seam).
- **`fragments/head.ts`** — `import '../app.css'`. Ungated: the relative path is
  identical from both `+layout.svelte` and `__root.tsx`.
- **`fragments/package.json`** — adds `tailwindcss` + `@tailwindcss/vite` to
  `devDependencies`.

Tailwind contributes **zero** framework-specific bytes. It does not `provide` a
capability in S1 (YAGNI); the `css` slot already encodes its identity, and the
first consumer that needs to require Tailwind (a future component library) will
introduce the capability then.

## Component 4 — The `iconify` Brick (`when`-gated parity)

`bricks/styling/iconify/`, slot **`icons`** (single-occupancy).

```toml
[brick]
name    = "iconify"
slot    = "icons"
summary = "Iconify icon component (framework-native)"

[[fragments]]
target   = "app/package.json"
from     = "fragments/package.svelte.json"
strategy = "json"
when     = "svelte"
[[fragments]]
target   = "app/package.json"
from     = "fragments/package.react.json"
strategy = "json"
when     = "react"

[[inject]]
point = "app-head"
from  = "fragments/head.svelte.ts"
when  = "svelte"
[[inject]]
point = "app-head"
from  = "fragments/head.react.ts"
when  = "react"

[[inject]]
point = "app-shell"
from  = "fragments/render.svelte.html"
when  = "svelte"
[[inject]]
point = "app-shell"
from  = "fragments/render.react.tsx"
when  = "react"
```

| Contribution | `when = "svelte"` | `when = "react"` |
|---|---|---|
| `package.json` dep | `@iconify/svelte` | `@iconify/react` |
| inject → `app-head` | `import Icon from '@iconify/svelte'` | `import { Icon } from '@iconify/react'` |
| inject → `app-shell` | `<Icon icon="ph:heart" />` | `<Icon icon="ph:heart" />` |

**On-demand icons:** the render uses `<Icon icon="ph:heart" />`, which loads the
icon by name at runtime (Iconify API). No icon-set dependency, no config — so the
parity delta is isolated to the single import line.

**Variant cohesion (design decision, mirrors S-DB whole-file variants):** the
`app-shell` render line is character-identical across variants, yet it is kept
*inside* each gated variant rather than hoisted to one ungated injection. The
reason is failure-mode asymmetry — if a future third framework provides neither
`svelte` nor `react`, cohesive variants emit **nothing** (clean no-op), whereas a
hoisted ungated render would emit a `<Icon>` referencing an *unimported*
component (**broken** output). "Emit a complete widget or emit nothing" beats
deduplication here.

## Registry / Slot Changes

New concern folder `bricks/styling/` hosting two single-occupancy slots. Slot
declaration order is merge/graph order, so `css` and `icons` are placed **after
`web`** (frontend concerns; framework plugin pushes before Tailwind's) and before
the backend slots:

```toml
# bricks/slots.toml (after)
container → build → web → css → icons → edge → db-engine → orm
```

Inserting `css`/`icons` does not perturb existing goldens: composed `package.json`
(recursive key sort) and `compose.yml` (`sortMapEntries`) are order-independent,
and no current-registry brick occupies the new slots, so unstyled stacks are
byte-unchanged apart from the Component-2 `push` refactor (which regenerates the
two `vite.config.ts` goldens regardless).

## Injection & Resolution Semantics

- **Iconify has no explicit `[requires]`.** Its point-based injects synthesize
  `requires inject:app-head` + `requires inject:app-shell`, both published only
  by a web framework — so iconify **transitively requires a framework**. Adding
  iconify with no framework → `unsatisfiable-injection-point` (exit 1). Free,
  from the phase-2a mechanism.
- **Exactly one variant fires.** Single-occupancy `web` slot ⇒ exactly one of
  `svelte`/`react` provided ⇒ exactly one `when` branch of each iconify
  contribution passes. Safe by construction, the same guarantee that makes
  S-DB's engine gating sound.
- **`app-head` aggregates two contributors** (Tailwind's CSS import + Iconify's
  component import) in graph order via the standard multi-contributor path — the
  same shape as `server-init` aggregating postgres + drizzle.

## Acceptance Gate

Reuses `packages/core/tests/round-trip.test.ts` and the golden harness; no new
test infrastructure. Six checks:

1. **Round-trip byte-identity (registry-derived).** `tailwind` and `iconify`
   are non-`web`, non-foundation bricks, so the removable-brick loop picks them
   up automatically. The census assertion updates to
   `['caddy', 'drizzle', 'iconify', 'postgres', 'sqlite', 'tailwind']`. Each
   round-trips on its `{vite, <fw>}` base (neither needs a db engine).

2. **Per-framework styling goldens.** New goldens for a `{vite, <fw>, tailwind, iconify}`
   stack on each framework: the root layout (both seams populated), `app/src/app.css`,
   the 2-contributor `vite.config.ts`, and `app/package.json`.

3. **Parity capstone (the headline).** One focused test asserts:
   - Svelte stack → `app-head` region contains `import Icon from '@iconify/svelte'` and `package.json` has `@iconify/svelte`;
   - React stack → `app-head` region contains `import { Icon } from '@iconify/react'` and `@iconify/react`;
   - the `app-shell` render line `<Icon icon="ph:heart" />` is **byte-identical** across both stacks.

4. **Multi-contributor survival.** With `{tailwind, iconify}` both present,
   `app-head` holds both imports in graph order; removing `iconify` leaves the
   `import '../app.css'` line alone. Same proof shape as phase-2a's "remove
   drizzle → postgres's server-init line survives."

5. **Tailwind byte-agnosticism.** `app/src/app.css` and the injected
   `import '../app.css'` line are byte-identical across both framework stacks —
   the mirror of phase-2a's byte-identical `compose.yml` proof.

6. **Unsatisfiable safety.** Adding `iconify` (and `tailwind`) with no framework
   resolves to `unsatisfiable-injection-point` (exit 1), asserted as data.

Existing goldens regenerated by this slice: `sveltekit.vite.config.ts`,
`tanstack.vite.config.ts` (Component-2 `push` refactor).

## Deferred / Follow-Ups

- Component libraries (bits-ui) — next styling-adjacent slice.
- Offline icon sets (`@iconify-json/ph`) — trivial additive change when wanted.
- Runtime-render / build-smoke validation.
- Registry-load lint (capability-name references + injection-point publisher
  uniqueness) — unchanged deferred item; S1 stays within the safe envelope.

## Open Questions

None blocking. The one judgment call already resolved: `vite-plugins` uses the
`.push()` single-seam design (Component 2), not a two-seam array literal.
