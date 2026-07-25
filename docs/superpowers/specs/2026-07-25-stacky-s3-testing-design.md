# S3 — Testing slice design (Vitest + jsdom, Svelte↔React parity)

**Goal:** Add a removable `vitest` brick in a new single-occupancy `test` slot (after `typecheck`) that gives both a SvelteKit stack and a TanStack-Start stack an equivalent test surface — framework-correct component testing with no wrong-framework dependency leaking — continuing the S1/S2 parity thesis.

## Toolchain: chosen vs rejected

**Vitest 4 + jsdom + `@testing-library`.**

- **Vitest over Jest.** Every stack is Vite-based; Vitest shares the Vite transform pipeline, so the framework's Vite plugin (already injected into `app/vite.config.ts`) compiles `.svelte`/`.tsx` under test for free. Jest would need a parallel transform/babel config and cannot reuse Vite plugins. The stacky repo already dogfoods Vitest 4.
- **jsdom + `@testing-library` over Vitest browser mode.** A scaffold's `pnpm test` must run in CI **without downloading browser binaries**. jsdom is zero-binary, fast, and universal across both frameworks. `@testing-library/svelte@5` officially supports Svelte 5 (peer `svelte: "^3 || ^4 || ^5"`); `@testing-library/react@16` supports React 18/19.
- **No e2e / browser mode in this slice (YAGNI).** Real-browser and end-to-end testing (Playwright) is a distinct concern with its own binary/CI weight; it belongs in a separate future brick, not bundled into the unit/component testing slice.

## Slot and brick

- New slot `test`, `single = true`, inserted after `typecheck` (before `edge`). Slot order is merge/graph order: `… lint → format → typecheck → test → edge …`.
- Brick `vitest` in slot `test` (tool-name-as-brick-name, matching `eslint`/`prettier`).
- `[requires] build = "*"` — `vitest.config.ts` imports `./vite.config`, so the brick genuinely depends on the build brick's owned file. `vite` is the sole `build` provider and always present, so the resolver auto-satisfies this.

## Composition — the load-bearing decision

The brick owns `app/vitest.config.ts` which **merges the app's Vite config** rather than re-declaring plugins or coupling test config into `vite.config.ts`:

```ts
import { mergeConfig, defineConfig, type PluginOption } from 'vitest/config'
import viteConfig from './vite.config'

const testPlugins: PluginOption[] = []
// >>> stacky:vitest-plugins
// <<< stacky:vitest-plugins

export default mergeConfig(
  viteConfig,
  defineConfig({
    plugins: testPlugins,
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./vitest-setup.ts'],
    },
  }),
)
```

Rationale:

- **`mergeConfig(viteConfig, …)` inherits the framework compile plugin.** Vitest, when a `vitest.config.ts` exists, uses it *instead of* `vite.config.ts` (no implicit merge), so the explicit `mergeConfig` is required to keep `sveltekit()` / the TanStack React plugin available for compiling components under test.
- **The `testPlugins` `.push()` seam** reuses the exact additive-seam convention established by the vite brick's `stackyPlugins`. The Svelte variant injects `svelteTesting()`; React injects nothing. This keeps the base config framework-agnostic while allowing a gated, framework-specific plugin — the same mechanism as the eslint config seam.
- **`svelteTesting()` from `@testing-library/svelte/vite`** is the officially-documented Svelte-5 test setup: it sets the browser resolve condition (so components resolve to their client build under jsdom) and registers auto-cleanup. It is Svelte-specific, hence gated.
- **Decoupled removal.** Removing the `vitest` brick deletes `vitest.config.ts`/`vitest-setup.ts`/tests only; `vite.config.ts` is untouched.
- **`globals: true`** enables `@testing-library` auto-cleanup between tests (both svelte@5 via `svelteTesting()` and react@16 via the global `afterEach`).
- **`vitest-setup.ts`** = `import '@testing-library/jest-dom/vitest'` — registers `toBeInTheDocument()`-style matchers for both frameworks (agnostic).

## Three-tier ownership (parity via `when` gates)

| Contribution | Agnostic | `when="svelte"` | `when="react"` |
|---|---|---|---|
| Owned files (`[[files]]`) | `app/vitest.config.ts` (seam), `app/vitest-setup.ts`, `app/src/demo.test.ts` | `app/src/lib/Counter.svelte`, `app/src/lib/Counter.svelte.test.ts` | `app/src/lib/Counter.tsx`, `app/src/lib/Counter.test.tsx` |
| package.json fragment | `test`/`test:watch` scripts + `vitest`, `jsdom`, `@testing-library/jest-dom` | `@testing-library/svelte` | `@testing-library/react`, `@testing-library/dom`, `@types/react`, `@types/react-dom` |
| Inject into `stacky:vitest-plugins` | — | `import { svelteTesting } from '@testing-library/svelte/vite'` + `testPlugins.push(svelteTesting())` | — |

Notes:

- **`[[files]]` supports `when`** (established in S-DB with gated drizzle files); the component test + component are gated the same way.
- **`@testing-library/dom` is a direct React dep** because `@testing-library/react@16` declares it as a *peer* (not bundled). `@testing-library/svelte@5` bundles its own DOM dep, so the Svelte side needs no equivalent.
- **`@types/react`/`@types/react-dom`** are added on the React side: the tanstack-start brick ships `react`/`react-dom` but not their types, and the `.tsx` component + test use React types directly (also satisfies `@testing-library/react`'s `@types/react` peer). This keeps the generated React app's `tsc --noEmit` correct.
- **`demo.test.ts`** is a tiny self-contained unit test (inline pure function) — it demonstrates plain unit testing and guarantees a green `pnpm test` even in a frameworkless+testing stack (no separate demo source file to pollute the app).

## Example components/tests (client component smoke tests)

- Svelte `Counter.svelte` (runes: `let count = $state(0)`, a button that increments); `Counter.svelte.test.ts` renders via `@testing-library/svelte`, asserts initial text and post-click increment.
- React `Counter.tsx` (`useState`); `Counter.test.tsx` renders via `@testing-library/react`, same assertions.

These are self-contained (no framework-runtime coupling like `$app/*`), so they mount cleanly under jsdom with only the framework's compile plugin.

## Version pins (verified against the npm registry)

- `vitest ^4.0.0`, `jsdom ^29.0.0`, `@testing-library/jest-dom ^7.0.0` (agnostic).
- `@testing-library/svelte ^5.0.0` (svelte).
- `@testing-library/react ^16.0.0`, `@testing-library/dom ^10.0.0`, `@types/react ^19.0.0`, `@types/react-dom ^19.0.0` (react — `@types` majors match the tanstack brick's `react ^19`).

## Testing / verification

- Round-trip **removable census** `+= vitest`; **full brick enumeration** (`bricks.test.ts`) `+= vitest` (alphabetical). Both strict `toEqual`.
- **Parity capstone** (both stacks): right testing-lib present / wrong absent — in composed `vitest.config.ts` text *and* composed `app/package.json`; `test` script present on both; `svelteTesting` push present only on Svelte; each `Counter` component/test present per framework and absent cross-framework.
- **Goldens** per framework: composed `vitest.config.ts` (Svelte has the `svelteTesting()` push inside the seam; TanStack has an empty seam) and the composed `app/package.json`. Owned files that are byte-identical to source (setup, components) need no golden.
- Round-trip byte-identity assertions preserved (not weakened); the brick removes cleanly (orphan removal covers gated files, per the S-DB safe-by-construction analysis).

## Global constraints (inherited)

- **Git:** one short conventional-commit subject line per commit; never a `Co-Authored-By` trailer; run hooks normally.
- **Direct-dep discipline:** every package a generated/composed file imports is a direct dependency in the matching (gated) `package.json` fragment for that stack; no wrong-framework leakage.
- **Byte-stability/determinism:** composed `package.json` recursive-sorted; markers at column 0; `vitest.config.ts` is `.ts` (loaded by Vitest/esbuild, unambiguous).

## Known follow-ups (non-blocking)

- The tanstack-start brick arguably should own `@types/react`/`@types/react-dom` itself (framework-brick concern) rather than the testing brick supplying them; revisit when the react framework brick is next touched, or fold into F1.
- A future `e2e` brick (Playwright/browser mode) for real-browser and end-to-end tests.
- The `svelteTesting()` gated-plugin inject is the first inject into a `vitest.config.ts`; the injection-point-uniqueness load-time lint (already tracked) will cover it.
