# S4 — Auth slice design (better-auth, email/password, Svelte↔React parity)

**Goal:** Add a removable `better-auth` brick in a new single-occupancy `auth` slot that gives a SvelteKit stack and a TanStack-Start stack an equivalent email/password authentication surface — framework-correct client + route mount, DB-backed via the existing engine bricks — with no wrong-framework dependency leaking. Continues the S1–S3 parity thesis.

## Why better-auth, and why the built-in adapter

`better-auth` is the modern, framework-agnostic, TypeScript-first auth library (the actively-maintained successor to Lucia). Its optional peers already list stacky's exact stack (`@sveltejs/kit`, `@tanstack/react-start`, `svelte`, `react`, `pg`, `better-sqlite3`). It fits the parity thesis: a framework-agnostic server instance + thin per-framework client and route.

**Decisive decision: use better-auth's built-in database adapter, not the drizzle adapter.** The built-in adapter accepts a raw `new Pool({ connectionString })` (Postgres) or `new Database(url)` (SQLite) directly and manages its own tables via `npx @better-auth/cli migrate` — "no additional configuration for schema generation or migration." This **fully decouples auth from the drizzle brick**: no auth schema file, no change to `drizzle.config.ts`, no `app/`↔`db/` cross-boundary import. The drizzle-adapter path would force better-auth's tables into drizzle's single-file `schema: '../db/schema.ts'` config and cross the project boundary — real coupling for no v1 benefit. (Trade-off: auth uses better-auth's internal Kysely layer rather than sharing drizzle. Deliberate for v1; a future refinement could unify on drizzle.)

## Scope (YAGNI)

- **Email/password only.** No OAuth/social providers in v1 (they add per-provider secrets + callback config — a large surface). Email/password is the minimal real auth.
- **Route-based mount, not the SvelteKit hooks handle.** Both frameworks mount auth via a catch-all API route calling the framework-agnostic `auth.handler(request)`. This avoids refactoring the sveltekit brick's `hooks.server.ts` (whose `handle` is a fixed body) into a `sequence`-based composition, and keeps the two framework mounts symmetric. (Trade-off: no automatic `event.locals.session` in SvelteKit — a user can add the hooks handle later. Noted as a follow-up.)

## Slot and brick

- New slot `auth`, `single = true`, at the END of the chain (after `orm`). Slot order: `… db-engine → orm → auth`.
- Brick `better-auth` in slot `auth`.
- `[requires] sql-db = "*"` — auth needs a database engine (postgres/sqlite provides `sql-db`). The round-trip harness already gives `sql-db`-requiring bricks a `postgres` foundation, so this composes in tests exactly like the drizzle brick.

## Composition — engine-gated server + framework-gated edges

The brick owns `app/src/lib/auth.ts`, gated by the engine driver capability (the same `pg-driver`/`sqlite-driver` gating the drizzle brick uses), carrying a `stacky:auth-plugins` `.push()` seam:

```ts
// files/auth.pg.ts  (when = "pg-driver")
import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { Pool } from 'pg'

const plugins: BetterAuthPlugin[] = []
// >>> stacky:auth-plugins
// <<< stacky:auth-plugins

export const auth = betterAuth({
  database: new Pool({ connectionString: process.env.DATABASE_URL }),
  emailAndPassword: { enabled: true },
  plugins,
})
```

The SQLite variant is identical but `import Database from 'better-sqlite3'` + `database: new Database(process.env.DATABASE_URL!)`. Only one engine variant is ever emitted (single-occupancy `db-engine` slot), so exactly one `auth.ts` publishes the seam.

The React framework injects the TanStack cookie plugin into the seam; SvelteKit injects nothing:

```ts
// fragments/plugin.react.ts  (inject → auth-plugins, when = "react")
import { tanstackStartCookies } from 'better-auth/tanstack-start'
plugins.push(tanstackStartCookies())
```

## Three-tier ownership (parity via gates)

| Contribution | Agnostic | engine `pg-driver` / `sqlite-driver` | `when="svelte"` | `when="react"` |
|---|---|---|---|---|
| Owned server | — | `app/src/lib/auth.ts` (Pool / Database + seam) | — | — |
| Owned client | — | — | `auth-client.ts` (`better-auth/svelte`) | `auth-client.ts` (`better-auth/react`) |
| Owned route | — | — | `src/routes/api/auth/[...all]/+server.ts` | `src/routes/api/auth/$.ts` |
| Inject into `stacky:auth-plugins` | — | — | — | `plugins.push(tanstackStartCookies())` |
| package.json | `better-auth`, `@better-auth/cli` (dev), `auth:migrate` script | — | — | — |
| `config/.env.example` (lines) | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | — | — | — |

Route bodies (framework-agnostic handler, per framework's convention):

```ts
// SvelteKit — src/routes/api/auth/[...all]/+server.ts  (when = "svelte")
import { auth } from '$lib/auth'
import type { RequestHandler } from './$types'
export const GET: RequestHandler = ({ request }) => auth.handler(request)
export const POST: RequestHandler = ({ request }) => auth.handler(request)
```

```ts
// TanStack Start — src/routes/api/auth/$.ts  (when = "react")
// relative import — stacky's tanstack tsconfig defines no '@/*' alias
import { auth } from '../../../lib/auth'
import { createFileRoute } from '@tanstack/react-router'
export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => auth.handler(request),
      POST: ({ request }: { request: Request }) => auth.handler(request),
    },
  },
})
```

Clients:

```ts
// svelte — better-auth/svelte ;  react — better-auth/react
import { createAuthClient } from 'better-auth/svelte' // or better-auth/react
export const authClient = createAuthClient()
```

## Version pins (verified against the npm registry)

- `better-auth ^1.6.0` (dependency), `@better-auth/cli ^1.4.0` (devDependency).
- `pg`/`better-sqlite3` + their `@types/*` are already supplied by the engine bricks (auth requires an engine), so auth does not re-declare them.

## Testing / verification

- Round-trip **removable census** `+= better-auth` (sorts FIRST); **full brick enumeration** `+= better-auth` (also first). Both strict `toEqual`.
- **Engine test:** `{ postgres, better-auth }` → `auth.ts` imports `Pool` + `new Pool`; `{ sqlite, better-auth }` → imports `better-sqlite3` + `new Database`. `emailAndPassword: { enabled: true }` and the `stacky:auth-plugins` seam present in both.
- **Parity capstone** (both stacks, fixed `postgres` engine): each gets `better-auth` dep, an `auth-client.ts` with the right framework import (`better-auth/svelte` vs `better-auth/react`), and its framework's auth route; React's composed `auth.ts` has the `tanstackStartCookies()` push, SvelteKit's seam is empty; `BETTER_AUTH_SECRET` present on both.
- **Goldens:** composed `auth.ts` for `{postgres+sveltekit}` (empty seam) and `{postgres+tanstack}` (cookies push). Owned client/route files are byte-identical to source and need no golden.
- Round-trip byte-identity preserved (not weakened); the brick removes cleanly (gated files fall into wanted-based orphan removal, per the S-DB safe-by-construction analysis).
- **Runtime smoke (best-effort, security-sensitive slice):** generate a `{ vite, sveltekit, postgres, better-auth }` (and sqlite) stack; confirm it type-checks / the auth instance constructs. Full sign-up/sign-in requires a live DB + `better-auth migrate`; document the manual step. Not a merge gate — the byte/golden/census gate is.

## Global constraints (inherited)

- **Git:** one short conventional-commit subject line per commit; never a `Co-Authored-By` trailer; run hooks normally.
- **Direct-dep discipline:** every package a composed/owned file imports is a direct dependency in `app/package.json` — `better-auth` (agnostic), `pg`/`better-sqlite3` (via the engine brick). No wrong-framework client import leaks.
- **Byte-stability/determinism:** composed `package.json` recursive-sorted; markers at column 0; `const plugins: BetterAuthPlugin[]` is typed to avoid the empty-array `TS7034` trap.

## Known follow-ups (non-blocking)

- OAuth/social providers (per-provider secrets + callback config) as a follow-up or param surface.
- SvelteKit `hooks.server.ts` `svelteKitHandler` for `event.locals.session` (needs the sequence-based handle refactor).
- Unifying auth on the drizzle adapter (shared `db`) instead of the built-in Kysely adapter.
- A generated `.env` (not just `.env.example`) and secret generation for `BETTER_AUTH_SECRET`.
- Codex review was unavailable this session (tool-side timeouts); this slice is verified in the main loop + best-effort runtime smoke.
