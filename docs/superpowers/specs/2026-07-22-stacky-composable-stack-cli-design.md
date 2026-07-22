# Stacky — composable stack CLI

**Date:** 2026-07-22
**Status:** Approved design, ready for implementation planning

## Problem

Starting a new project means re-assembling the same stack by hand: SvelteKit, TanStack,
Docker Compose, Caddy with an auth plugin, Postgres, migrations, CI. Copying a previous
project drags along its accidents; a one-shot generator gets you to day one and then
abandons you the moment you want to add Redis in month three.

The gap is a tool that can add *and remove* stack pieces at any point in a project's life,
and that both a human and an LLM can drive.

## Goal

An external CLI, `stacky`, that materializes selected "bricks" into a target repo and can
keep composing that repo over time. The repo it produces is a plain repo with no dependency
on stacky.

## Non-goals

- Not a framework. Application code is never owned by stacky.
- Not a package manager. Bricks are scaffolding, not runtime dependencies.
- Not multi-ecosystem. The registry targets one stack (SvelteKit / TanStack / Caddy /
  Postgres / Docker). The brick *format* is open, so widening later is additive.
- Not a deploy tool. Stacky writes ops config; it does not run it.

## Key decisions

| Decision | Chosen | Why |
|---|---|---|
| Composition model | Living, re-composable repo driven by a manifest | `add` and `remove` must work months later, not just at init |
| Tool location | External CLI (global / `npx`); registry lives in this repo | Target repos carry zero framework tax — critical for LLM comprehension |
| Interface | Headless core + CLI + web node editor + JSON | Three surfaces over one resolver; no duplicated logic |
| Registry breadth | Personal stack, documented open brick format | Adding a brick is dropping a folder, not editing core |
| File ownership | Three tiers: brick-owned, composed, marker-injected | Only model where `remove` is trustworthy |

## Architecture

### This repo

```
stacky-and-hutch/
  packages/
    core/           # headless: registry · resolver · planner · applier · lockfile
    cli/            # thin adapter: prompts, colored diff, --json
  apps/
    web/            # node editor (phase 3)
  bricks/           # the registry — one folder per brick
    sveltekit/ caddy/ caddy-auth/ postgres/ drizzle/ tanstack-query/ compose/ …
  docs/
  AGENTS.md         # brick-authoring contract
```

pnpm workspace. `core` has no dependency on `cli` or `web`; the arrow only points inward.

### A project stacky builds

```
myapp/
  stack.toml        # what you chose             ← hand-editable
  stack.lock        # what stacky wrote + hashes ← generated, never edit
  app/              # SvelteKit, TanStack, client code
  config/           # env schema, auth config, app config
  ops/              # compose, caddy, CI, deploy
  db/               # schema, migrations, seeds
  AGENTS.md         # generated: describes this stack to an LLM
```

Bricks declare a slot; slots map to folder roots. A brick may write to several roots, but
every path it owns is recorded in the lockfile. Because a brick's private files sit under a
predictable root, removal is largely a directory delete plus a recompose of shared files.

## File ownership — three tiers

Every path has exactly one owner, declared in `brick.toml`.

1. **Brick-owned** (`[[files]]`) — copied into the brick's folder. `ops/caddy/auth.conf`.
   Removal deletes them.
2. **Composed** (`[[fragments]]`) — stacky fully regenerates the file from all contributing
   bricks on every apply, with a banner header. `ops/compose.yml`, `config/.env.example`.
   Not hand-editable. The escape hatch is an override block in `stack.toml`, applied as a
   deep merge after all fragments, keyed by target path:

   ```toml
   [overrides."ops/compose.yml"]
   services.postgres.ports = ["5433:5432"]
   ```

   Overrides live in the manifest rather than the generated file, so they survive regeneration
   and stay visible as an explicit deviation.
3. **Marker-injected** (`[[inject]]`) — a delimited region inside a file the user also owns.
   `app/src/hooks.server.ts`, `package.json` scripts. Removal deletes the region only.

Composed files are merged in a **stable order — `(slot declaration order, brick name)`** — so
regenerating produces byte-identical output for an unchanged manifest. Without this, every
`stacky add` yields a large meaningless diff.

## Brick format

```toml
[brick]
name    = "caddy-auth"
slot    = "auth"
summary = "Forward-auth at the edge via caddy-security"

[requires]
http-edge     = "*"     # capability, not a specific brick
session-store = "*"

[provides]
capabilities = ["auth"]

[params]
provider = { type = "enum", values = ["github", "google", "oidc"], default = "github" }
domain   = { type = "string", prompt = "Auth domain" }

[[files]]
from = "files/auth.conf.eta"
to   = "ops/caddy/auth.conf"

[[fragments]]
target = "ops/compose.yml"
from   = "fragments/compose.yaml"

[[inject]]
target = "app/src/hooks.server.ts"
marker = "stacky:auth"
from   = "fragments/hooks.ts"
```

Files ending `.eta` are rendered with `params`; all others are copied byte-for-byte.

**Slots vs capabilities.** A *slot* answers "where does this go, and what does it exclude?"
(single-occupancy: a second `auth` brick is a conflict). A *capability* answers "what abstract
need does this satisfy?" Both exist so a brick can require *some* session store without naming
one, which is what makes swapping possible.

Params reach a brick three equivalent ways: interactive prompt, `--set k=v`, or pre-written
into `stack.toml`. The last is the agent's happy path.

## Core API

```ts
loadRegistry(dir)             → Registry
resolve(manifest, registry)   → Graph | ResolutionError
plan(graph, projectDir, lock) → FileOp[]
apply(ops, projectDir)        → Lockfile
```

Only `apply` touches disk. `resolve` and `plan` are pure, which makes both testable without a
filesystem and makes `plan` a genuine dry run.

```ts
type FileOp =
  | { kind: 'create',    path, contents, owner }
  | { kind: 'overwrite', path, contents, owner, prevHash }
  | { kind: 'compose',   path, contents, contributors: BrickId[] }
  | { kind: 'inject',    path, marker, contents, owner }
  | { kind: 'delete',    path, owner }
  | { kind: 'conflict',  path, reason: 'user-modified' }
```

### Resolution

1. Read `stack.toml` → set of `(brick, params)`
2. For each unmet `requires`, find bricks providing that capability
   - exactly one candidate → auto-add, marked as inferred
   - several → **ambiguity, surfaced not resolved**
3. Detect slot conflicts, dependency cycles, unsatisfiable requires, invalid params
4. Stable-sort for deterministic fragment merge

The resolver never prompts. It returns structured ambiguity and stops. The CLI renders that as
a picker, the web UI as an unconnected port, an agent reads it as JSON. This is what guarantees
the automation path can never hang on a TTY.

### Lockfile and drift

`stack.lock` is JSON (machine-written, never hand-edited — unlike the TOML manifest) and records
per file: `{ path, owner, tier, hash }`, alongside the resolved brick set. Every `plan` re-hashes
what is on disk and compares, yielding three states:

- hash matches → safe to rewrite or delete
- hash differs → user edited it; emit `conflict`, write nothing
- not in lock → not ours; ignore entirely

On conflict, stacky writes `<path>.stacky-new` alongside the user's file and reports it. Never a
silent clobber, never a hard block.

## Surfaces

| Surface | Entry | Renders `FileOp[]` as |
|---|---|---|
| CLI | `stacky init/add/remove/plan/apply/list` | colored diff, interactive picks |
| Graph | `stacky graph --format mermaid\|dot` | text diagram of resolved stack |
| Web UI | `stacky ui` → local server | nodes + ports; unmet require = red port |
| LLM | any command + `--json --yes` | JSON; ambiguity = exit 2 + candidates |

The web UI is a **view over `stack.toml`, not a wizard with its own state**. Wiring a node writes
the manifest and re-runs `resolve`. The browser holds no truth of its own, so the UI, an editor,
and an agent-driven CLI can all operate concurrently without a sync protocol.

## Error handling

**Resolution errors** — all carry machine-readable `kind`, human `message`, and affected bricks:

| kind | Meaning | CLI behavior | Agent behavior |
|---|---|---|---|
| `ambiguous` | ≥2 candidates for a capability | prompt to pick | exit 2 + candidate list |
| `unsatisfiable` | no brick provides a require | error, suggest `brick new` | exit 1 |
| `slot-conflict` | two bricks in a single-occupancy slot | error, name both | exit 1 |
| `cycle` | circular requires | error, print the cycle | exit 1 |
| `unknown-brick` | not in registry | error, fuzzy-suggest | exit 1 |
| `missing-param` | required param, no default | prompt for it | exit 2 + param schema |
| `invalid-param` | supplied value fails type/enum check | re-prompt | exit 1 |

**Exit codes:** `0` success · `1` error · `2` needs input (ambiguity or missing required param).
The `2` is distinct so an agent can tell "I must supply something" from "this is broken".

**Apply safety.** `plan` completes fully before any write; a plan containing a `conflict` op
aborts apply unless `--force`. Writes proceed in lockfile order and the lockfile is updated after
each successful op, so an interrupted apply leaves an accurate (partial) lock and a re-run
converges.

Stacky does **not** implement transactional rollback. Instead it checks the git worktree before
applying and warns if dirty (`--allow-dirty` to override). Git is the undo mechanism; reproducing
it inside the tool would be redundant and worse.

## Testing

The core being pure is what makes this cheap.

- **Unit — resolver.** Fixture registries exercising each `ResolutionError` kind, auto-add of
  single candidates, and slot exclusivity. No filesystem.
- **Unit — planner.** Fixture manifest + fixture lock → asserted `FileOp[]`. Covers the three
  ownership tiers, drift detection against all three hash states, and stable fragment ordering.
- **Golden files.** A handful of representative manifests, each with a committed expected file
  tree. Catches accidental output churn — particularly the ordering guarantee, which is
  otherwise invisible until it produces a huge diff.
- **Round-trip property.** For every brick: snapshot the tree, `add X`, `remove X`, assert the
  tree is byte-identical to the snapshot. This is the load-bearing test of the whole design; if
  it passes for every brick, the ownership model holds.
- **Artifact validation.** Applied output is checked with the real tools — `docker compose config`
  on the composed compose file, `caddy validate` on the Caddyfile, `tsc --noEmit` on the app.
  Proves bricks emit *valid* artifacts, not merely expected bytes.
- **CLI contract.** Snapshot `--json` output per command, and assert every command terminates
  without a TTY. Guards the agent path against regression.

## Phasing

1. **Core + CLI + 4 bricks** (`sveltekit`, `compose`, `caddy`, `postgres`) — proves the three
   tiers end to end. Done when `add postgres` → `add caddy` → `remove postgres` leaves a clean
   tree and the round-trip test passes.
2. **Rest of the registry** (`caddy-auth`, `drizzle`, `tanstack-query`, `redis`, `gh-actions`),
   `stacky graph` mermaid output, generated `AGENTS.md`, `stacky brick new` scaffold.
3. **Web node editor.**

## Open questions

Deferred deliberately; none blocks phase 1.

- Brick versioning and `stacky upgrade` — how a brick improvement reaches an existing project.
  Phase 1 pins nothing; revisit once bricks start changing.
- Whether to ship an MCP server as a fourth surface, or leave `--json` as the agent contract.
- Whether `ci` should be a multi-occupancy slot.
