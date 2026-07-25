# tanstack-completeness — make the TanStack Start brick produce a bootable app

**Goal:** Bring the `tanstack-start` web brick up to the canonical TanStack Start v1 file structure so a generated `{ vite, tanstack-start }` app actually boots (`pnpm dev` / `pnpm build`) and type-checks after a build — closing the framework-completeness gap surfaced by the S3 and S4 runtime smokes. This is a prerequisite fix inserted before S5 (TanStack Query), whose clean React integration wraps the router created here.

## Why this slice, now

The S3 and S4 runtime smokes both tripped on the same root cause: the tanstack-start brick scaffolds `__root.tsx` / `index.tsx` / `server.ts` but is missing the pieces a TanStack Start app needs to boot. Concretely, against the real v1 API (confirmed via the TanStack Start docs):

1. **No `src/router.tsx`.** TanStack Start requires a `createRouter({ routeTree })` instance wired to the generated route tree. Without it there is no router to mount.
2. **`server.ts` is a hand-rolled `fetch()` stub** returning `'ok'`. Because a project-level `src/server.ts` is a *custom server-entry override*, this stub hijacks every request and returns `'ok'` instead of rendering routes — the app is actively broken, not merely incomplete.
3. **`__root.tsx` has no document shell.** A real root route renders the HTML document (`<html>/<head>/<body>` with `<HeadContent />` and `<Scripts />`). The current file renders a bare fragment, so there is no document for the client to hydrate.

Fixing the React framework brick is also the moment its **own React types come due**: once `__root.tsx` uses `import type { ReactNode }` and JSX, the brick's files require `@types/react` / `@types/react-dom`, which the brick does not currently own (the vitest brick added them as a workaround — the S3 spec flagged this to "revisit when the react framework brick is next touched").

## Scope (YAGNI)

- **Bootability + self-typecheck only.** Add the router, fix the server entry, fix the root document, and give the brick ownership of its React types. No new features, no data layer (that's S5), no client-entry customization (the vite plugin's default client entry is sufficient — we only override `server.ts` because the `server-init` seam already lives there).
- **Preserve every existing seam and cross-brick contract.** `app-head`, `app-shell`, and `server-init` keep their exact markers and semantic positions so tailwind / iconify / postgres / sqlite / drizzle injects land unchanged.
- **The route tree stays generated, not committed.** `routeTree.gen.ts` is produced by the `tanstackStart()` vite plugin on `dev`/`build` (TanStack's own model — there is no first-class standalone "sync" command like SvelteKit's `svelte-kit sync`). This slice does not commit or hand-author it. See "Typecheck timing" below.

## The three canonical files

### `src/router.tsx` (new, owned)

```tsx
import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
  })

  return router
}
```

Owned byte-identical file (`[[files]]` from `files/router.tsx` → `app/src/router.tsx`), so it needs no golden. The `./routeTree.gen` import is unresolved only under standalone `tsc` (see below); stacky's composition tests never run `tsc`, so the suite is unaffected.

### `src/routes/__root.tsx` (rewrite, composed — has goldens)

Canonical document shell, with the two existing seams kept at their current semantic positions — `app-head` at the top (import/setup region, where tailwind's `import '../app.css'` and iconify's `import { Icon }` hoist in) and `app-shell` inside `<header>` (where iconify's `<Icon />` JSX lands):

```tsx
// >>> stacky:app-head
// <<< stacky:app-head
import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'stacky' },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html>
      <head>
        <HeadContent />
      </head>
      <body>
        <header>
{/* >>> stacky:app-shell */}
{/* <<< stacky:app-shell */}
        </header>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
```

> Note the two distinct "head" concepts: the `app-head` *marker seam* is stacky's module setup/import region (unchanged in meaning); the route's `head:` option is TanStack's document-`<head>` metadata config (new). They are unrelated despite the similar names. The `<Outlet />` now sits inside `RootDocument`'s body — this is the natural wrap point S5's React QueryClient integration will use at the router level (`routerWithQueryClient` in `router.tsx`), so no JSX-wrapping seam is needed.

### `src/server.ts` (rewrite, composed — inline-asserted, no golden)

Real custom server entry that delegates to the default handler, preserving the `server-init` seam where postgres/sqlite/drizzle inject:

```ts
import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
// >>> stacky:server-init
// <<< stacky:server-init

export default createServerEntry({
  fetch(request) {
    return handler.fetch(request)
  },
})
```

`server-init` injects (e.g. postgres) `import { Pool } from 'pg'` + `export const pool = new Pool(...)`; the import hoists and the `export const` sits at module scope, exactly as today. This mirrors the sveltekit brick, which hosts `server-init` in `hooks.server.ts` — the cross-framework contract (`bricks.test.ts`, `round-trip.test.ts:148`) is unchanged.

## React types ownership

The tanstack-start brick's `fragments/package.json` gains `@types/react ^19.0.0` and `@types/react-dom ^19.0.0` as devDependencies (its own JSX + `ReactNode` require them; the `@types` majors match the brick's `react ^19`). Correspondingly, the vitest brick's `fragments/package.react.json` **drops** those two `@types` (it added them only because the framework brick didn't own them). Net effect:

- **Correct single owner** — the brick that owns `react`/`react-dom` owns their types.
- **No app-level dependency drift** — for a `{ tanstack, vitest }` stack the merged `app/package.json` is byte-identical to before (the types simply move source-brick); for a `{ tanstack }` stack without vitest, the types are now correctly present (previously missing).
- **Direct-dep discipline holds** — `@testing-library/react`'s `@types/react` peer is still satisfied because tanstack (always present whenever react testing is, since react component tests are `when="react"`) supplies it.

## Typecheck timing (documented behaviour, not a defect)

TanStack generates `routeTree.gen.ts` on `dev`/`build`; there is no blessed standalone generator command. So on a scaffold that has **never** been built, `pnpm typecheck` (`tsc --noEmit`) fails on the missing `./routeTree.gen` import — inherent to TanStack's codegen model, and directly analogous to the sveltekit side, whose typecheck script must run `svelte-kit sync` first. After a single `pnpm build` (or `pnpm dev`), `routeTree.gen.ts` exists and `pnpm typecheck` passes.

- This slice keeps the react typecheck script as `tsc --noEmit` (no unconfirmed generator CLI baked into a golden) and documents the build-first requirement in the brick.
- **Follow-up (F1 / a later touch):** make the react typecheck script generate-first (`<route-tree generate> && tsc --noEmit`, mirroring `svelte-kit sync && svelte-check`) once the standalone generator command is confirmed empirically, so first-run typecheck is robust.

## Verification

- **Composition suite (merge gate):** full `pnpm vitest run` green. Regenerate the two composed root goldens (`tanstack.root.tsx`, `tanstack.styled.root.tsx`) and the tanstack `package.json` goldens that now gain the `@types` (`tanstack.package.json`, `tanstack.styled.package.json`); inspect each diff to confirm only the intended changes (document shell + seams intact; styling injects still land; `@types/react(-dom)` added). No census or brick-enumeration change (no brick added/removed; tanstack is a `web` brick, excluded from the removable census).
- **Inline assertions:** extend `bricks.test.ts` — `server.ts` now contains `createServerEntry` (and still the `server-init` marker + injected `new Pool`); add that the composed tree contains `app/src/router.tsx` with `createRouter`.
- **Round-trip byte-stability / idempotence** preserved — adding `router.tsx` (an owned file) to the tree keeps the converge-twice snapshot equal.
- **Runtime smoke (best-effort, not a merge gate):** scaffold `{ vite, tanstack-start }`, `pnpm install`, then `pnpm build` (proves the app boots and generates `routeTree.gen.ts`) and `pnpm typecheck` (passes post-build). Report results; the byte/golden/census gate is the merge gate.

## Global constraints (inherited)

- **Git:** one short conventional-commit subject line per commit; never a `Co-Authored-By` trailer; run hooks normally.
- **Direct-dep discipline:** every package a composed/owned file imports is a direct dependency of `app/package.json` — `@tanstack/react-router`, `@tanstack/react-start`, `react`, `react-dom`, and now `@types/react`/`@types/react-dom`.
- **Byte-stability/determinism:** composed `package.json` recursive-sorted; markers at column 0; goldens regenerated deterministically and inspected.

## Known follow-ups (non-blocking)

- Generate-first react typecheck script (above), once the standalone route-tree generator command is confirmed.
- S5 (TanStack Query) wires the QueryClient at the router level via `router.tsx` (`routerWithQueryClient`) — this slice's `router.tsx` is that integration point.
- Codex review was unavailable this session (persistent tool-side timeout); this slice is controller-verified in the main loop plus the best-effort runtime smoke.
