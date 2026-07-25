# SvelteKit completeness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `sveltekit` brick the standard SvelteKit project files (`svelte.config.js`, `src/app.html`, `src/app.d.ts`) + an adapter so a generated `{ vite, sveltekit }` app builds and type-checks.

**Architecture:** Three new owned files + one adapter devDependency + brick.toml registration. Mirror of the shipped `tanstack-completeness` fix. `hooks.server.ts` and its `server-init` seam are untouched.

**Tech Stack:** SvelteKit v2, Svelte 5, `@sveltejs/adapter-auto`, `@sveltejs/vite-plugin-svelte` (already present), TypeScript.

## Global Constraints

- **Git:** one short conventional-commit subject line per commit; **never** a `Co-Authored-By` trailer; run hooks normally (no `--no-verify`).
- **Merge gate is byte/golden/census** (`pnpm vitest run` green); the runtime smoke is best-effort.
- **Do NOT touch** `hooks.server.ts`, the `server-init`/`app-head`/`app-shell` seams, the removable census, or the brick enumeration (no brick added/removed).
- **Byte-stability/determinism:** composed `package.json` recursive-sorted; regenerate goldens with the update flag and **inspect each diff**.

---

### Task 1: Add SvelteKit project files so the app builds and type-checks

**Files:**
- Create: `bricks/web/sveltekit/files/svelte.config.js`
- Create: `bricks/web/sveltekit/files/app.html`
- Create: `bricks/web/sveltekit/files/app.d.ts`
- Modify: `bricks/web/sveltekit/brick.toml` (register the three `[[files]]`)
- Modify: `bricks/web/sveltekit/fragments/package.json` (add `@sveltejs/adapter-auto`)
- Test: `packages/core/tests/bricks.test.ts` (extend/add a sveltekit assertion)
- Regenerate goldens: `packages/core/tests/golden/sveltekit.package.json`, `sveltekit.styled.package.json`

**Interfaces:**
- Consumes: the brick's existing `sveltekit()` vite plugin (already injected) and `@sveltejs/vite-plugin-svelte` devDep (already present, exports `vitePreprocess`).
- Produces: a buildable SvelteKit scaffold — `svelte.config.js` (adapter + preprocess), `src/app.html` (template), `src/app.d.ts` (App namespace).

- [ ] **Step 1: Add a failing assertion to `bricks.test.ts`**

Find the sveltekit-related `describe`/`it` (there is a `{ vite, sveltekit, postgres }` test around the `hooks.server.ts` server-init assertions). Add a focused new test in the sveltekit area:

```ts
  it('resolves vite + sveltekit and emits the buildable project files', async () => {
    const reg = await loadRegistry(bricksDir)
    const r = resolve({ bricks: { vite: {}, sveltekit: {} }, overrides: {} }, reg)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const dir = await mkdtemp(join(tmpdir(), 'stacky-svktcomplete-'))
    await apply(await plan(r.graph, { projectDir: dir, lock: emptyLock(), overrides: {} }), dir, r.graph)

    const cfg = await readFile(join(dir, 'app/svelte.config.js'), 'utf8')
    expect(cfg).toContain('@sveltejs/adapter-auto')
    expect(cfg).toContain('vitePreprocess')

    const html = await readFile(join(dir, 'app/src/app.html'), 'utf8')
    expect(html).toContain('%sveltekit.body%')
    expect(html).toContain('%sveltekit.head%')

    const pkg = JSON.parse(await readFile(join(dir, 'app/package.json'), 'utf8'))
    expect(pkg.devDependencies).toHaveProperty('@sveltejs/adapter-auto')
  })
```

(Match the exact import names/helpers already used at the top of `bricks.test.ts` — `loadRegistry`, `resolve`, `plan`, `apply`, `emptyLock`, `mkdtemp`, `join`, `tmpdir`, `readFile`, `bricksDir`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/tests/bricks.test.ts`
Expected: FAIL — `app/svelte.config.js` and `app/src/app.html` do not exist (readFile rejects); `@sveltejs/adapter-auto` not in devDependencies.

- [ ] **Step 3: Create `files/svelte.config.js`**

```js
import adapter from '@sveltejs/adapter-auto'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
  },
}

export default config
```

- [ ] **Step 4: Create `files/app.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    %sveltekit.head%
  </head>
  <body data-sveltekit-preload-data="hover">
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>
```

- [ ] **Step 5: Create `files/app.d.ts`**

```ts
// See https://svelte.dev/docs/kit/types#app.d.ts for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {}
```

- [ ] **Step 6: Register the three files in `brick.toml`**

Add these `[[files]]` blocks (alongside the existing ones; `to` paths are the app-relative targets — note `svelte.config.js` sits at `app/`, the two `app.*` files at `app/src/`):

```toml
[[files]]
from = "files/svelte.config.js"
to   = "app/svelte.config.js"

[[files]]
from = "files/app.html"
to   = "app/src/app.html"

[[files]]
from = "files/app.d.ts"
to   = "app/src/app.d.ts"
```

- [ ] **Step 7: Add the adapter to `fragments/package.json`**

Add `@sveltejs/adapter-auto` to `devDependencies` (result — keep existing keys, add the new one; the composer will recursive-sort):

```json
{
  "devDependencies": {
    "@sveltejs/adapter-auto": "^7.0.0",
    "@sveltejs/kit": "^2.0.0",
    "@sveltejs/vite-plugin-svelte": "^5.0.0",
    "svelte": "^5.0.0"
  }
}
```

- [ ] **Step 8: Regenerate the two affected goldens and inspect**

Run: `pnpm vitest run packages/core/tests/round-trip.test.ts -u`
Then: `git diff packages/core/tests/golden/` and read each changed golden.
Expected changed goldens: **only** `sveltekit.package.json` and `sveltekit.styled.package.json`, each gaining a single `@sveltejs/adapter-auto` line in recursive-sorted `devDependencies`. If any other golden changed, stop and investigate before continuing.

- [ ] **Step 9: Run the full suite green**

Run: `pnpm vitest run` then `pnpm tsc -b` then `git diff --check`
Expected: all tests pass; typecheck clean; no whitespace errors.

- [ ] **Step 10: Commit**

```bash
git add bricks/web/sveltekit packages/core/tests/bricks.test.ts packages/core/tests/golden
git commit -m "feat(web): add sveltekit project files so the app builds (svelte.config, app.html, app.d.ts)"
```

- [ ] **Step 11: Best-effort runtime smoke + prettier conformance (report, do not gate)**

In a scratch dir outside the repo, scaffold `{ vite, sveltekit }` with the built stacky CLI, then `pnpm install`, `pnpm build`, `pnpm typecheck`. Report: does `pnpm build` succeed (the `app.html does not exist` error gone)? Does `pnpm typecheck` (`svelte-kit sync && svelte-check`) pass? Also run `pnpm exec prettier --check svelte.config.js src/app.html src/app.d.ts` (or `pnpm format`) in the scaffold; if prettier would rewrite any of the three files, update the brick source in the repo to the prettier-formatted bytes and amend/append a commit `style(web): prettier-format sveltekit project files`. If the environment cannot install/build, say so explicitly. Do **not** commit the scratch scaffold.

---

## Self-Review

- **Spec coverage:** svelte.config.js (Step 3), app.html (Step 4), app.d.ts (Step 5), adapter dep (Step 7), brick.toml registration (Step 6), goldens (Step 8), assertions (Step 1), runtime smoke + prettier (Step 11). All covered.
- **No placeholders:** every code step shows full file/assertion content.
- **Type/name consistency:** `@sveltejs/adapter-auto`, `vitePreprocess`, `%sveltekit.body%`/`%sveltekit.head%` consistent between the assertion, the files, and the spec.
- **No census/enum/seam changes:** confirmed — only additive owned files + one devDep.
