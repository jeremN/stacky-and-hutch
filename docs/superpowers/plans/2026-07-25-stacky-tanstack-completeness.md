# TanStack Start completeness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the `tanstack-start` brick to the canonical TanStack Start v1 structure so a generated `{ vite, tanstack-start }` app boots (`pnpm dev`/`build`) and self-type-checks after a build, and give the brick ownership of its React types.

**Architecture:** Add the missing `src/router.tsx`, rewrite `__root.tsx` to a real document shell, and rewrite `server.ts` to a real `createServerEntry` — each preserving its existing marker seams (`app-head`, `app-shell`, `server-init`) so tailwind/iconify/postgres/sqlite/drizzle injects land unchanged. Move `@types/react`/`@types/react-dom` ownership from the vitest brick (workaround) to the tanstack brick (correct owner).

**Tech Stack:** TanStack Start v1 (`@tanstack/react-router`, `@tanstack/react-start`), React 19, TypeScript, Vitest (stacky's composition test suite).

## Global Constraints

- **Git:** one short conventional-commit subject line per commit; **never** a `Co-Authored-By` trailer; run hooks normally (no `--no-verify`).
- **Merge gate is byte/golden/census** (`pnpm vitest run` green); the runtime smoke is best-effort, not a gate.
- **Preserve every seam marker** (`stacky:app-head`, `stacky:app-shell`, `stacky:server-init`) at column 0 and at its current semantic position.
- **Direct-dep discipline:** every imported package is a direct dep of `app/package.json`.
- **Byte-stability/determinism:** composed `package.json` recursive-sorted; regenerate goldens with the update flag and **inspect each diff** — never blindly accept.
- **No census/enumeration change:** no brick is added or removed; do not touch `round-trip.test.ts`'s removable census or `bricks.test.ts:13`'s full enumeration.

---

### Task 1: Canonical bootable tanstack shell + React-types ownership

**Files:**
- Create: `bricks/web/tanstack-start/files/router.tsx`
- Modify: `bricks/web/tanstack-start/brick.toml` (register the new `[[files]]`)
- Modify: `bricks/web/tanstack-start/files/__root.tsx` (rewrite)
- Modify: `bricks/web/tanstack-start/files/server.ts` (rewrite)
- Modify: `bricks/web/tanstack-start/fragments/package.json` (add `@types/react`, `@types/react-dom`)
- Test: `packages/core/tests/bricks.test.ts` (extend the tanstack-start `describe`)
- Regenerate goldens: `packages/core/tests/golden/tanstack.root.tsx`, `tanstack.styled.root.tsx`, `tanstack.package.json`, `tanstack.styled.package.json`

**Interfaces:**
- Consumes: existing seams — `stacky:app-head` (import/setup region, receives hoisting imports), `stacky:app-shell` (inside `<header>`, receives JSX), `stacky:server-init` (module scope, receives `import { Pool } … export const pool = new Pool(…)`).
- Produces: `app/src/router.tsx` exporting `getRouter()` (the router-level integration point S5 will use); a bootable `__root.tsx` document shell; a real `server.ts` custom entry.

- [ ] **Step 1: Add failing assertions to `bricks.test.ts`**

In the `describe('tanstack-start stack', …)` block, extend the existing test (after the current `server.ts` assertions) so it also requires the real entry and the router file. Add, inside that `it(...)` after line reading `expect(server).toContain('>>> stacky:server-init')`:

```ts
    expect(server).toContain('createServerEntry')

    const router = await readFile(join(dir, 'app/src/router.tsx'), 'utf8')
    expect(router).toContain('createRouter')
    expect(router).toContain('./routeTree.gen')
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/tests/bricks.test.ts`
Expected: FAIL — `server.ts` has no `createServerEntry`; `app/src/router.tsx` does not exist (readFile rejects).

- [ ] **Step 3: Create `files/router.tsx`**

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

- [ ] **Step 4: Register the new file in `brick.toml`**

Add, immediately after the `files/index.tsx` `[[files]]` block:

```toml
[[files]]
from = "files/router.tsx"
to   = "app/src/router.tsx"
```

- [ ] **Step 5: Rewrite `files/__root.tsx`**

Replace the entire file with:

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

Keep the `stacky:app-head` markers as the first two lines (before imports) and the `stacky:app-shell` markers at column 0 inside `<header>` — this is exactly where the existing goldens place them, so tailwind's `import '../app.css'` / iconify's `import { Icon }` and iconify's `<Icon />` continue to land correctly.

- [ ] **Step 6: Rewrite `files/server.ts`**

Replace the entire file with:

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

- [ ] **Step 7: Add React types to `fragments/package.json`**

The brick's own JSX + `ReactNode` require them. Result:

```json
{
  "dependencies": {
    "@tanstack/react-router": "^1.0.0",
    "@tanstack/react-start": "^1.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0"
  }
}
```

- [ ] **Step 8: Regenerate the four affected goldens and inspect**

Run: `pnpm vitest run packages/core/tests/round-trip.test.ts -u`
Then: `git diff --stat packages/core/tests/golden/` and read each changed golden.
Expected changed goldens: `tanstack.root.tsx`, `tanstack.styled.root.tsx` (new document shell; `app-head`/`app-shell` seams intact; in the styled one, `import '../app.css'` + `import { Icon }` inside `app-head` and `<Icon icon="ph:heart" />` inside `<header>`'s `app-shell`), plus `tanstack.package.json` and `tanstack.styled.package.json` (now include `@types/react`/`@types/react-dom`, recursive-sorted).
**Inspect:** confirm `<html>/<head>/<body>`, `<HeadContent />`, `<Scripts />`, both seams present, and no unexpected golden drifted. If any *other* golden changed, stop and investigate before continuing.

- [ ] **Step 9: Run the full suite green**

Run: `pnpm vitest run` then `pnpm tsc -b` then `git diff --check`
Expected: all tests pass; typecheck clean; no whitespace errors.

- [ ] **Step 10: Commit**

```bash
git add bricks/web/tanstack-start packages/core/tests/bricks.test.ts packages/core/tests/golden
git commit -m "feat(web): make tanstack-start scaffold a bootable app (router, root document, server entry)"
```

- [ ] **Step 11: Best-effort runtime smoke (report, do not gate)**

In a scratch dir outside the repo, scaffold `{ vite, tanstack-start }` with the built stacky CLI, then `pnpm install`, `pnpm build`, `pnpm typecheck`. Report: does `pnpm build` succeed and write `src/routeTree.gen.ts`? Does `pnpm typecheck` pass after the build? If the environment cannot install/build (network/time), say so explicitly — this is best-effort, not a merge gate. Do **not** commit the scratch scaffold.

- [ ] **Step 12: Document the typecheck-follows-build behaviour**

Add a brief note to the brick (a top-of-file comment in `files/router.tsx`, or a one-line summary addition) stating that `routeTree.gen.ts` is generated by the vite plugin on `dev`/`build`, so `pnpm typecheck` requires a prior `pnpm build`/`dev` — analogous to sveltekit's `svelte-kit sync`. Keep it short. Commit with `docs(web): note tanstack routeTree generation is build-time`.

---

### Task 2: Drop the now-redundant React types from the vitest brick

**Files:**
- Modify: `bricks/quality/vitest/fragments/package.react.json` (remove `@types/react`, `@types/react-dom`)
- Verify goldens: any composed `package.json` golden for a stack containing both tanstack-start and vitest must stay byte-identical (types now come from tanstack instead of vitest — net-neutral).

**Interfaces:**
- Consumes: tanstack-start now owns `@types/react`/`@types/react-dom` (Task 1). React component tests are `when="react"`, so tanstack is always present when they are — the types are always supplied.
- Produces: single-owner React types; no duplicate declaration across bricks.

- [ ] **Step 1: Capture the baseline composed package.json for a `{ tanstack, vitest }` stack**

Read the current relevant vitest golden(s) so you can diff after the change. Run `git diff --stat` should show no `package.json`-golden change for stacks that include both bricks.

- [ ] **Step 2: Remove the two `@types` from `fragments/package.react.json`**

Delete the `@types/react` and `@types/react-dom` entries from `devDependencies`, leaving `@testing-library/react` and `@testing-library/dom`:

```json
{
  "devDependencies": {
    "@testing-library/dom": "^10.0.0",
    "@testing-library/react": "^16.0.0"
  }
}
```

(Preserve any other keys/scripts already in that fragment exactly; only the two `@types` lines are removed.)

- [ ] **Step 3: Regenerate/verify goldens**

Run: `pnpm vitest run -u` then `git diff packages/core/tests/golden/`
Expected: **no** change to any composed `package.json` golden that includes both tanstack-start and vitest (the types moved source-brick but the merged result is identical). If a `{ tanstack, vitest }` merged `package.json` golden changed, the ownership assumption is wrong — stop and investigate.

- [ ] **Step 4: Run the full suite green**

Run: `pnpm vitest run` then `pnpm tsc -b`
Expected: all pass, including the vitest react parity capstone (right testing-lib present, wrong absent).

- [ ] **Step 5: Commit**

```bash
git add bricks/quality/vitest/fragments/package.react.json packages/core/tests/golden
git commit -m "refactor(test): let tanstack-start own react types instead of the vitest brick"
```

---

## Self-Review

- **Spec coverage:** router.tsx (T1 S3–4), __root.tsx document shell (T1 S5), server.ts real entry (T1 S6), React-types ownership (T1 S7 add / T2 remove), seam preservation (T1 S5–6, verified in S8), typecheck-timing doc (T1 S12), runtime smoke (T1 S11), goldens (T1 S8, T2 S3). All covered.
- **No placeholders:** every code step shows the full file/assertion content.
- **Type consistency:** `getRouter`, `createServerEntry`, `RootDocument`, seam marker strings, and the `@types` versions (`^19.0.0`) are consistent across tasks and match the spec.
- **Ordering:** Task 1 makes tanstack own the types (idempotent with vitest still having them — the tier-composed guard only errors on *disagreeing* values, and both use `^19.0.0`); Task 2 then removes the redundant copy. Safe either-side-of ordering, but T1→T2 is the intended sequence.
