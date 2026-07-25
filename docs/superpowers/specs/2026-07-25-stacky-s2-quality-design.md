# S2 — Quality Slice (lint · format · typecheck) Design

**Date:** 2026-07-25
**Status:** Approved (brainstorm; design choices dug with Codex per the autonomous-loop directive)
**Predecessors:** phase-1, phase-2a, S-DB, S1 (styling)

## Goal

Add the **quality** concern to the catalog: ESLint (flat config), Prettier, and
type-checking for the generated app — each first-class on **both** framework
families (SvelteKit + TanStack Start). Reuse S1's parity mechanism (`when`-gated
framework variants + a `.push()`-additive config seam) so the same quality
capability yields framework-correct output on either stack, byte-stably.

## Context

The repo's own tooling is TypeScript + Vitest only — no linter/formatter — so
this is a greenfield choice for the generated apps, not a mirror of an existing
setup. S1 established the patterns S2 leans on: family capabilities (`svelte` /
`react`), `when`-gated variants (Iconify), a framework-agnostic brick (Tailwind),
and the additive `.push()`-into-a-pre-declared-array config seam (`vite-plugins`).

## Toolchain decision (dug with Codex)

**ESLint flat config + Prettier + `svelte-check`/`tsc --noEmit`.** Rejected
alternatives for the first cut: **Biome** (single fast tool, but lints only Svelte
`<script>`, not templates — first-class for React, second-class for Svelte, which
breaks stacky's parity thesis), oxlint, dprint, type-aware ESLint, and
`eslint-plugin-prettier`. The deciding factor is that ESLint and Prettier both
have first-class Svelte *and* React plugins, so the same `lint`/`format`
capability produces framework-correct config via `when` — exactly S1's split.

## Scope

**In scope**
- New `quality/` concern folder with three single-occupancy slots: `lint`, `format`, `typecheck`.
- `eslint` brick — owns `app/eslint.config.js`, framework-agnostic base + `when`-gated Svelte/React config blocks self-injected into an `eslint-config` seam.
- `prettier` brick — owns `app/prettier.config.js`, ungated base + `when="svelte"` `prettier-plugin-svelte`.
- `typecheck` brick — fully `when`-gated `typecheck` script (Svelte → `svelte-check`, React → `tsc --noEmit`) + gated deps.
- Framework bricks grow an owned `app/tsconfig.json` (SvelteKit svelte-flavored, TanStack react-flavored) — the framework-completeness prerequisite typecheck needs; and the SvelteKit web brick's `check` script is **removed** (moves to the quality slice).
- Acceptance gate: round-trip, per-framework goldens, a lint-config parity capstone, aggregation ordering (framework config injected then `eslint-config-prettier` last), and the web-brick `check`-removal parity check.

**Out of scope (deferred, explicit)**
- CI wiring, editor settings (`.editorconfig`, `.vscode`), lint-staged/husky.
- Type-aware ESLint (`recommendedTypeChecked`), custom rule presets, `eslint-plugin-prettier`.
- Biome/oxlint as alternates.
- Actually *running* the tools (install + `pnpm lint`/`format`/`typecheck`) in CI — S2 proves the generated config/scripts/deps are byte-correct and internally consistent, same runtime-deferral as S1.
- The registry-load lint (capability-name references + injection-point publisher uniqueness) — unchanged deferred item.

## Architecture Overview

Three bricks, one per slot, each mirroring the S1 gated/ungated discipline:
**gate only what differs by framework.**

- **`eslint`** publishes an `eslint-config` seam in the flat-config array and
  self-injects framework config blocks gated on `svelte`/`react` — the Iconify
  pattern (one brick, gated variants), except the brick injects into its *own*
  published seam, so it needs no framework to exist (base config works
  standalone; framework blocks are gated additions).
- **`prettier`** is mostly framework-agnostic (Tailwind pattern): ungated base +
  one `when="svelte"` plugin, since Prettier formats `.tsx` natively but needs
  `prettier-plugin-svelte` for `.svelte`.
- **`typecheck`** is fully gated: the type-checker differs entirely by framework
  (`svelte-check` vs `tsc --noEmit`), so both variants are `when`-gated and
  exactly one fires.

### Component 1 — `eslint` brick (slot `lint`)

Owns `app/eslint.config.js` (flat config, ESM, `.js` so no strict-TS concern),
publishing an `eslint-config` seam using the established `.push()` convention:

```js
// app/eslint.config.js (shape; exact plugin API verified via context7 at impl time)
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

const configs = [js.configs.recommended, ...tseslint.configs.recommended]
// >>> stacky:eslint-config
// <<< stacky:eslint-config
configs.push(prettier) // last: disables stylistic rules that would fight Prettier

export default configs
```

Self-injected gated blocks (into `eslint-config`):
- `when="svelte"`: `import svelte from 'eslint-plugin-svelte'; configs.push(...svelte.configs['flat/recommended'])`
- `when="react"`: react plugin + hooks config pushed.

Contributions:
- Ungated `package.json`: `lint`/`lint:fix` scripts; devDeps `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-config-prettier`, `globals`.
- `when="svelte"`: devDep `eslint-plugin-svelte` + the svelte config inject.
- `when="react"`: devDeps `eslint-plugin-react`, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y` + the react config inject.

Framework-**optional**: with no framework, the base config still lints generic
TS/JS (no framework block fires). So `eslint` has no framework requirement —
unlike Iconify.

### Component 2 — `prettier` brick (slot `format`)

Owns `app/prettier.config.js` with a `prettier-plugins` seam:

```js
/** @type {import('prettier').Config} */
const config = { plugins: [] }
// >>> stacky:prettier-plugins
// <<< stacky:prettier-plugins
export default config
```

- Ungated `package.json`: `format` (`prettier --write .`) + `format:check` (`prettier --check .`) scripts; devDep `prettier`.
- `when="svelte"`: devDep `prettier-plugin-svelte` + inject `config.plugins.push('prettier-plugin-svelte')` (referenced by name — Prettier resolves it; no import needed).

React needs no Prettier plugin (`.tsx` is native), so there is no react variant —
the Tailwind-style "single brick, gate only the Svelte delta" shape.

### Component 3 — `typecheck` brick (slot `typecheck`)

Fully `when`-gated (the checker differs entirely by framework):
- `when="svelte"`: devDep `svelte-check` + `package.json` script `typecheck: "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json"`.
- `when="react"`: `package.json` script `typecheck: "tsc --noEmit"` (TypeScript is present via the framework/base; the variant declares `typescript` if not already a direct dep).

No ungated default (a single `scripts.typecheck` value can have only one owner;
two ungated+gated contributors would collide in the JSON merge). With no
framework, `typecheck` contributes nothing — a documented no-op, the same
always-gated case the deferred registry-load lint will eventually warn on.

### Component 4 — Framework `tsconfig.json` + `check` removal

typecheck's scripts reference `./tsconfig.json`, which no framework currently
ships. A tsconfig is framework-flavored, so the **framework bricks** own it
(correct concern ownership; removing typecheck must not delete the editor's
tsconfig):
- `sveltekit` owns `app/tsconfig.json` (svelte flavor; `svelte-check` reads it).
- `tanstack-start` owns `app/tsconfig.json` (react flavor; `jsx: react-jsx`, bundler resolution).

And the SvelteKit brick's existing `"check": "svelte-check …"` `package.json`
script is **removed** — it's a quality affordance that leaked into the web brick
and that React lacks. Type-checking is now the `typecheck` brick's job, symmetric
across frameworks. (This changes the `sveltekit.package.json` golden.)

## Registry / Slot Changes

New concern folder `bricks/quality/` with three single-occupancy slots. Placed
**after `icons`** (the S1 styling slots) and before `edge`, so the app/frontend
concerns group together and quality composes after styling:

```toml
# bricks/slots.toml (after)
container → build → web → css → icons → lint → format → typecheck → edge → db-engine → orm
```

Byte-neutral for existing goldens (composed `package.json`/`compose.yml` are
order-independent; the new slots are unoccupied in current stacks — except the
deliberate `sveltekit.package.json` change from the `check` removal and the two
new framework `tsconfig.json` files).

## Injection & Resolution Semantics

- **`eslint` self-injects** its gated framework blocks into its own
  `eslint-config` seam. `resolvePoint` finds the publisher (eslint itself) in the
  graph; single-occupancy `web` ⇒ at most one framework block fires. No framework
  requirement, no ambiguity — eslint stands alone or enhances.
- **`eslint-config-prettier` is pushed after the seam**, so it's always last in
  the flat array regardless of what frameworks inject — the required ordering for
  it to actually disable conflicting stylistic rules.
- **Direct-dep discipline** (the S1 `@tanstack/react-router` lesson): every
  package imported or referenced by a generated config/script must be a direct
  dependency of `app/package.json` — `eslint-plugin-svelte`, `prettier-plugin-svelte`,
  the react plugins, `svelte-check`, etc., each declared in the matching gated
  fragment.

## Acceptance Gate

Reuses `round-trip.test.ts` + the golden harness. Checks:

1. **Round-trip byte-identity (registry-derived).** `eslint`, `prettier`,
   `typecheck` are non-`web`, non-foundation ⇒ auto-added to the removable loop.
   Census becomes `['caddy', 'drizzle', 'eslint', 'iconify', 'postgres', 'prettier', 'sqlite', 'tailwind', 'typecheck']` (brick names, alphabetical, strict `toEqual`).
2. **Per-framework goldens** for a `{vite, <fw>, eslint, prettier, typecheck}` stack: `eslint.config.js` (framework block present + `prettier` last), `prettier.config.js`, `app/package.json` (scripts + gated deps), and `app/tsconfig.json`.
3. **Lint parity capstone.** Same `eslint` brick → Svelte stack's `eslint.config.js` pushes `eslint-plugin-svelte` config and `package.json` has `eslint-plugin-svelte` (and NOT the react plugins); React stack pushes the react config and has the react plugins (and NOT `eslint-plugin-svelte`). Wrong-framework deps never leak.
4. **Aggregation ordering.** In the composed `eslint.config.js`, the framework block appears inside the seam and `configs.push(prettier)` (eslint-config-prettier) appears after it — last wins.
5. **`check`-removal parity.** The composed `sveltekit` `package.json` no longer has a `check` script; both frameworks expose the same quality script surface (`lint`, `format`, `typecheck`) once the quality bricks are added.
6. **Typecheck gating.** Svelte stack's `typecheck` script is `svelte-check`-based; React stack's is `tsc --noEmit`; exactly one present.

**Explicitly out of the gate:** S2 does not run `pnpm lint`/`format`/`typecheck`
(no install/build in CI) — it proves the generated config/scripts/deps are
byte-correct and mutually consistent, same runtime-deferral as S1.

## Deferred / Follow-Ups

- CI wiring, editor settings, lint-staged/husky, type-aware ESLint, rule presets.
- Biome/oxlint alternates.
- Runtime `pnpm lint/format/typecheck` smoke validation.
- Registry-load lint (capability-name references + injection-point publisher uniqueness) — unchanged.

## Open Questions

None blocking. Resolved judgment calls: ESLint-flat+Prettier over Biome
(parity); `tsconfig.json` owned by frameworks, not typecheck (concern ownership);
`typecheck` fully gated with a documented frameworkless no-op; `eslint-config-prettier`
pushed after the seam (ordering).
