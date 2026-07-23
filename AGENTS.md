# Working in this repo

`stacky` composes project stacks from bricks. Read
`docs/superpowers/specs/2026-07-22-stacky-composable-stack-cli-design.md` for the full design.

## Authoring a brick

A brick is a folder under `bricks/` containing `brick.toml` plus its payload. The folder name
must equal `[brick].name`, and `[brick].slot` must be declared in `bricks/slots.toml`. The four
slots today are `container`, `web`, `edge`, `db` — all `single = true`, so at most one brick per
slot can be selected at once.

A brick declares what it needs and offers via `[requires]` / `[provides]`: `requires` maps a
capability name to a version constraint (currently always `"*"`), `provides.capabilities` lists
the capability strings this brick satisfies. `resolve()` walks required capabilities to a fixed
point, auto-selecting the (unique) brick that provides an unmet one; if zero or more than one
brick provides it, resolution fails with a structured error rather than guessing.

Every file a brick writes falls into exactly one of three tiers:

| Tier | Section | Ownership | Removal |
|---|---|---|---|
| Brick-owned | `[[files]]` | the brick | file is deleted |
| Composed | `[[fragments]]` | stacky, merged from all bricks | contribution disappears on regenerate |
| Injected | `[[inject]]` | the user; brick owns one marker region in a host file it does not own | region is emptied |

Files ending `.eta` are rendered with the brick's `params` exposed as `it`
(e.g. `<%= it.port %>`). Everything else is copied byte-for-byte.

### Composed fragments and merge strategy

Each `[[fragments]]` entry declares `strategy = "yaml"` or `strategy = "lines"`:

- `yaml` — fragments are parsed and deep-merged in slot/brick order (objects merge key-by-key,
  scalars and arrays are overwritten by the later brick), then re-serialised with sorted keys for
  byte-stability. Used by every fragment targeting `ops/compose.yml`.
- `lines` — fragments are split into lines, deduplicated, and each brick's surviving lines are
  grouped under a `# <brick-name>` comment block. Used by every fragment targeting
  `config/.env.example`.

**All bricks targeting the same composed file must agree on strategy.** `planComposedFiles`
(`packages/core/src/plan/tier-composed.ts`) throws if two fragments aimed at the same `target`
declare different strategies — there is no silent fallback. When adding a fragment to an existing
composed file, match the strategy every other brick already uses for that target.

### Injection depends on the host's owner

A brick that injects into a marker does not create the host file itself — some other brick's
`[[files]]` entry owns it and declares the marker region (`>>> marker` / `<<< marker` comments) in
its source. Applying an injection whose marker isn't present in the host throws
(`applyMarker` in `packages/core/src/plan/tier-inject.ts`), so **the injecting brick must
`require` a capability that guarantees the host-owning brick is present**.

Concrete example: `postgres` injects into the `stacky:server-init` marker inside
`app/src/hooks.server.ts`, which `sveltekit` owns (via `[[files]]`) and writes the marker into.
`postgres/brick.toml` therefore declares `requires.ssr = "*"`, and `sveltekit` is the sole
provider of `ssr` — so resolving `postgres` always pulls in `sveltekit` first, guaranteeing the
host exists before the injection is planned.

## Rules

- `packages/core` never imports from `packages/cli`.
- `resolve()` and `plan()` are pure. Only `apply()` writes to disk.
- `resolve()` never prompts. Ambiguity is returned as data, not resolved.
- Composed output must be byte-stable for an unchanged manifest.
- Every new brick must pass the round-trip test in
  `packages/core/tests/round-trip.test.ts` — add it to the brick list there.

## Commands

```bash
pnpm test              # full suite
pnpm test:artifacts    # docker compose config / caddy validate against generated output
pnpm typecheck         # tsc -b
node packages/cli/src/index.ts list
node packages/cli/src/index.ts add postgres --cwd /path/to/project
```
