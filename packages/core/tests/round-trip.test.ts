import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, loadRegistry, plan, readLock, readManifest, resolve, writeManifest } from '../src/index.js'
import { snapshotTree } from './helpers/tree.js'
import type { Manifest } from '../src/types.js'

const bricksDir = fileURLToPath(new URL('../../../bricks', import.meta.url))

async function converge(dir: string, manifest: Manifest) {
  const registry = await loadRegistry(bricksDir)
  await writeManifest(dir, manifest)
  const r = resolve(manifest, registry)
  if (!r.ok) throw new Error(`resolve failed: ${JSON.stringify(r.errors)}`)
  const lock = await readLock(dir)
  const ops = await plan(r.graph, { projectDir: dir, lock, overrides: manifest.overrides })
  await apply(ops, dir, r.graph)
}

const FRAMEWORKS = ['sveltekit', 'tanstack-start'] as const
// The foundation is fixed per stack and never round-tripped.
const FOUNDATION = new Set<string>(['vite', 'compose', ...FRAMEWORKS])

describe('round trip — both framework stacks', () => {
  for (const fw of FRAMEWORKS) {
    const base: Manifest = { bricks: { vite: {}, [fw]: {} }, overrides: {} }

    // Derive removable bricks from the registry: everything not in the foundation.
    it(`[${fw}] every removable brick round-trips byte for byte`, async () => {
      const registry = await loadRegistry(bricksDir)
      const removable = [...registry.bricks.values()]
        .filter((b) => !FOUNDATION.has(b.name) && b.slot !== 'web')
        .map((b) => b.name)
        .sort()
      expect(removable).toEqual(['caddy', 'drizzle', 'eslint', 'iconify', 'postgres', 'prettier', 'sqlite', 'tailwind', 'typecheck'])

      for (const brick of removable) {
        // A brick that needs a database engine can't be added alone (two engines => ambiguous),
        // so give it a fixed engine in its foundation.
        const needsEngine = registry.bricks.get(brick)!.requires['sql-db'] != null
        const brickBase = needsEngine ? { ...base.bricks, postgres: {} } : { ...base.bricks }

        const dir = await mkdtemp(join(tmpdir(), `stacky-rt-${fw}-${brick}-`))
        await converge(dir, { bricks: structuredClone(brickBase), overrides: {} })
        const before = await snapshotTree(dir)

        await converge(dir, { bricks: { ...brickBase, [brick]: {} }, overrides: {} })
        const during = await snapshotTree(dir)
        // Adding the brick must change GENERATED output — a new file (most bricks) or
        // modified content in an existing one (injection/fragment-only bricks like iconify).
        // Exclude the manifest/lock, which converge() always rewrites, so a silent no-op
        // brick can't pass on bookkeeping changes alone.
        const generated = (t: Record<string, string>) =>
          Object.fromEntries(Object.entries(t).filter(([p]) => p !== 'stack.toml' && p !== 'stack.lock'))
        expect(generated(during)).not.toEqual(generated(before))

        await converge(dir, { bricks: structuredClone(brickBase), overrides: {} })
        expect(await snapshotTree(dir)).toEqual(before)
      }
    })
  }

  for (const fw of FRAMEWORKS) {
    it(`[${fw}] swapping the db engine round-trips byte for byte`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `stacky-swap-${fw}-`))
      const pgStack: Manifest = { bricks: { vite: {}, [fw]: {}, postgres: {}, drizzle: {} }, overrides: {} }
      const sqliteStack: Manifest = { bricks: { vite: {}, [fw]: {}, sqlite: {}, drizzle: {} }, overrides: {} }

      await converge(dir, structuredClone(pgStack))
      const pgSnap = await snapshotTree(dir)

      await converge(dir, structuredClone(sqliteStack))
      const initFile = fw === 'sveltekit' ? 'app/src/hooks.server.ts' : 'app/src/server.ts'
      const init = await readFile(join(dir, initFile), 'utf8')
      expect(init).toContain('drizzle-orm/better-sqlite3')
      expect(init).not.toContain('node-postgres')
      expect(await readFile(join(dir, 'app/drizzle.config.ts'), 'utf8')).toContain("dialect: 'sqlite'")
      expect(await readFile(join(dir, 'ops/compose.yml'), 'utf8')).not.toContain('postgres')

      await converge(dir, structuredClone(pgStack))
      expect(await snapshotTree(dir)).toEqual(pgSnap)
    })
  }

  it('adding drizzle with two engines and none chosen is ambiguous', async () => {
    const registry = await loadRegistry(bricksDir)
    const r = resolve({ bricks: { vite: {}, sveltekit: {}, drizzle: {} }, overrides: {} }, registry)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected an ambiguous resolution')
    const ambiguous = r.errors.find((e) => e.kind === 'ambiguous')
    expect(ambiguous).toMatchObject({ kind: 'ambiguous', capability: 'sql-db', candidates: ['postgres', 'sqlite'] })
  })

  it('[sveltekit] removing drizzle leaves postgres server-init intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-rt-multi-'))
    const withPg: Manifest = { bricks: { vite: {}, sveltekit: {}, postgres: {} }, overrides: {} }
    await converge(dir, structuredClone(withPg))
    const before = await snapshotTree(dir)

    await converge(dir, { bricks: { ...withPg.bricks, drizzle: {} }, overrides: {} })
    const hooks = await readFile(join(dir, 'app/src/hooks.server.ts'), 'utf8')
    expect(hooks).toContain('new Pool')
    expect(hooks).toContain('drizzle(')

    await converge(dir, structuredClone(withPg))
    expect(await snapshotTree(dir)).toEqual(before)
    const after = await readFile(join(dir, 'app/src/hooks.server.ts'), 'utf8')
    expect(after).toContain('new Pool')
    expect(after).not.toContain('drizzle(')
  })

  it('applying the same manifest twice changes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-rt-idem-'))
    const full: Manifest = { bricks: { vite: {}, sveltekit: {}, caddy: {}, postgres: {}, drizzle: {} }, overrides: {} }
    await converge(dir, structuredClone(full))
    const first = await snapshotTree(dir)
    await converge(dir, structuredClone(full))
    expect(await snapshotTree(dir)).toEqual(first)
  })

  it('a removed brick leaves no orphan files behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-rt-orphan-'))
    await converge(dir, { bricks: { vite: {}, sveltekit: {}, postgres: {} }, overrides: {} })
    await converge(dir, { bricks: { vite: {}, sveltekit: {} }, overrides: {} })
    const paths = Object.keys(await snapshotTree(dir))
    expect(paths.filter((p) => p.startsWith('db/'))).toEqual([])
    const manifest = await readManifest(dir)
    expect(manifest.bricks).not.toHaveProperty('postgres')
  })

  it('tailwind wires the vite plugin, css import, and app.css (both stacks, byte-identical css)', async () => {
    async function bits(fw: 'sveltekit' | 'tanstack-start') {
      const dir = await mkdtemp(join(tmpdir(), `stacky-tw-${fw}-`))
      await converge(dir, { bricks: { vite: {}, [fw]: {}, tailwind: {} }, overrides: {} })
      const css = await readFile(join(dir, 'app/src/app.css'), 'utf8')
      const viteCfg = await readFile(join(dir, 'app/vite.config.ts'), 'utf8')
      const layoutPath = fw === 'sveltekit' ? 'app/src/routes/+layout.svelte' : 'app/src/routes/__root.tsx'
      const layout = await readFile(join(dir, layoutPath), 'utf8')
      return { css, viteCfg, importsCss: layout.includes("import '../app.css'") }
    }
    const sv = await bits('sveltekit')
    const rx = await bits('tanstack-start')
    expect(sv.css).toContain('@import "tailwindcss"')
    expect(sv.viteCfg).toContain('stackyPlugins.push(tailwindcss())')
    expect(rx.viteCfg).toContain('stackyPlugins.push(tailwindcss())')
    expect(sv.importsCss && rx.importsCss).toBe(true)
    expect(sv.css).toEqual(rx.css) // Tailwind contributes byte-identical css on both stacks
  })

  it('iconify emits framework-native bytes on each stack (parity capstone)', async () => {
    async function styled(fw: 'sveltekit' | 'tanstack-start') {
      const dir = await mkdtemp(join(tmpdir(), `stacky-parity-${fw}-`))
      await converge(dir, { bricks: { vite: {}, [fw]: {}, tailwind: {}, iconify: {} }, overrides: {} })
      return dir
    }
    const svDir = await styled('sveltekit')
    const rxDir = await styled('tanstack-start')
    const svLayout = await readFile(join(svDir, 'app/src/routes/+layout.svelte'), 'utf8')
    const rxRoot = await readFile(join(rxDir, 'app/src/routes/__root.tsx'), 'utf8')
    const svPkg = await readFile(join(svDir, 'app/package.json'), 'utf8')
    const rxPkg = await readFile(join(rxDir, 'app/package.json'), 'utf8')

    expect(svLayout).toContain("import Icon from '@iconify/svelte'")
    expect(rxRoot).toContain("import { Icon } from '@iconify/react'")
    expect(svPkg).toContain('@iconify/svelte')
    expect(rxPkg).toContain('@iconify/react')
    expect(svPkg).not.toContain('@iconify/react')   // wrong-framework dep never leaks
    expect(rxPkg).not.toContain('@iconify/svelte')

    const render = '<Icon icon="ph:heart" />'       // render markup is byte-identical
    expect(svLayout).toContain(render)
    expect(rxRoot).toContain(render)

    await expect(svLayout).toMatchFileSnapshot('./golden/sveltekit.styled.layout.svelte')
    await expect(rxRoot).toMatchFileSnapshot('./golden/tanstack.styled.root.tsx')
    await expect(svPkg).toMatchFileSnapshot('./golden/sveltekit.styled.package.json')
    await expect(rxPkg).toMatchFileSnapshot('./golden/tanstack.styled.package.json')
  })

  it('[sveltekit] removing iconify leaves the tailwind css import intact (aggregation survival)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-agg-'))
    await converge(dir, { bricks: { vite: {}, sveltekit: {}, tailwind: {}, iconify: {} }, overrides: {} })
    const both = await readFile(join(dir, 'app/src/routes/+layout.svelte'), 'utf8')
    expect(both).toContain("import '../app.css'")
    expect(both).toContain("import Icon from '@iconify/svelte'")

    await converge(dir, { bricks: { vite: {}, sveltekit: {}, tailwind: {} }, overrides: {} })
    const twOnly = await readFile(join(dir, 'app/src/routes/+layout.svelte'), 'utf8')
    expect(twOnly).toContain("import '../app.css'")
    expect(twOnly).not.toContain('@iconify/svelte')
    expect(twOnly).not.toContain('ph:heart')
  })

  it('eslint composes framework-native flat config per stack (parity)', async () => {
    async function styled(fw: 'sveltekit' | 'tanstack-start') {
      const dir = await mkdtemp(join(tmpdir(), `stacky-eslint-${fw}-`))
      await converge(dir, { bricks: { vite: {}, [fw]: {}, eslint: {} }, overrides: {} })
      return dir
    }
    const svDir = await styled('sveltekit')
    const rxDir = await styled('tanstack-start')
    const svCfg = await readFile(join(svDir, 'app/eslint.config.mjs'), 'utf8')
    const rxCfg = await readFile(join(rxDir, 'app/eslint.config.mjs'), 'utf8')
    const svPkg = await readFile(join(svDir, 'app/package.json'), 'utf8')
    const rxPkg = await readFile(join(rxDir, 'app/package.json'), 'utf8')

    expect(svCfg).toContain('eslint-plugin-svelte')
    expect(rxCfg).toContain('eslint-plugin-react')
    expect(svCfg).not.toContain('eslint-plugin-react')
    expect(rxCfg).not.toContain('eslint-plugin-svelte')
    // eslint-config-prettier is applied LAST — pushed AFTER the seam's close marker, on BOTH stacks
    for (const cfg of [svCfg, rxCfg]) {
      expect(cfg.indexOf('configs.push(prettier)')).toBeGreaterThan(cfg.lastIndexOf('<<< stacky:eslint-config'))
    }
    expect(svPkg).toContain('eslint-plugin-svelte')
    expect(svPkg).not.toContain('eslint-plugin-react')
    expect(rxPkg).toContain('eslint-plugin-react')
    expect(rxPkg).not.toContain('eslint-plugin-svelte')

    await expect(svCfg).toMatchFileSnapshot('./golden/sveltekit.eslint.config.mjs')
    await expect(rxCfg).toMatchFileSnapshot('./golden/tanstack.eslint.config.mjs')
  })

  it('prettier is agnostic + gates only the svelte plugin', async () => {
    async function bits(fw: 'sveltekit' | 'tanstack-start') {
      const dir = await mkdtemp(join(tmpdir(), `stacky-prettier-${fw}-`))
      await converge(dir, { bricks: { vite: {}, [fw]: {}, prettier: {} }, overrides: {} })
      const cfg = await readFile(join(dir, 'app/prettier.config.mjs'), 'utf8')
      const pkg = await readFile(join(dir, 'app/package.json'), 'utf8')
      return { cfg, pkg }
    }
    const sv = await bits('sveltekit')
    const rx = await bits('tanstack-start')
    expect(sv.cfg).toContain("config.plugins.push('prettier-plugin-svelte')")
    expect(rx.cfg).not.toContain('prettier-plugin-svelte')     // react needs no plugin
    expect(sv.pkg).toContain('prettier-plugin-svelte')
    expect(rx.pkg).not.toContain('prettier-plugin-svelte')
    expect(sv.pkg).toContain('"format"')
    expect(rx.pkg).toContain('"format"')
    await expect(sv.cfg).toMatchFileSnapshot('./golden/sveltekit.prettier.config.mjs')
    await expect(rx.cfg).toMatchFileSnapshot('./golden/tanstack.prettier.config.mjs')
  })

  it('typecheck gates the checker per framework; check no longer leaks from the web brick', async () => {
    async function full(fw: 'sveltekit' | 'tanstack-start') {
      const dir = await mkdtemp(join(tmpdir(), `stacky-tc-${fw}-`))
      await converge(dir, { bricks: { vite: {}, [fw]: {}, eslint: {}, prettier: {}, typecheck: {} }, overrides: {} })
      return JSON.parse(await readFile(join(dir, 'app/package.json'), 'utf8')) as { scripts: Record<string, string> }
    }
    const sv = await full('sveltekit')
    const rx = await full('tanstack-start')
    expect(sv.scripts.typecheck).toContain('svelte-check')
    expect(rx.scripts.typecheck).toBe('tsc --noEmit')
    expect(sv.scripts).not.toHaveProperty('check')   // removed from the web brick
    // same quality surface on both stacks
    for (const s of ['lint', 'format', 'typecheck']) {
      expect(sv.scripts).toHaveProperty(s)
      expect(rx.scripts).toHaveProperty(s)
    }
  })

  // a bare sveltekit stack (no typecheck brick) has no `check` script anymore
  it('[sveltekit] bare framework no longer ships a check script', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-nocheck-'))
    await converge(dir, { bricks: { vite: {}, sveltekit: {} }, overrides: {} })
    const pkg = JSON.parse(await readFile(join(dir, 'app/package.json'), 'utf8')) as { scripts?: Record<string, string> }
    expect(pkg.scripts?.check).toBeUndefined()
  })

  it('adding a styling brick with no framework is ambiguous (pick a framework)', async () => {
    const registry = await loadRegistry(bricksDir)
    const r = resolve({ bricks: { compose: {}, vite: {}, tailwind: {} }, overrides: {} }, registry)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected an ambiguous injection point')
    const err = r.errors.find((e) => e.kind === 'ambiguous-injection-point')
    expect(err).toMatchObject({
      kind: 'ambiguous-injection-point',
      point: 'app-head',
      candidates: ['sveltekit', 'tanstack-start'],
    })
  })
})

describe('golden files — per framework', () => {
  for (const fw of FRAMEWORKS) {
    const short = fw === 'sveltekit' ? 'sveltekit' : 'tanstack'
    it(`[${fw}] full stack matches the committed goldens`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `stacky-golden-${short}-`))
      await converge(dir, { bricks: { vite: {}, [fw]: {}, caddy: {}, postgres: {}, drizzle: {} }, overrides: {} })
      await expect(await readFile(join(dir, 'ops/compose.yml'), 'utf8'))
        .toMatchFileSnapshot(`./golden/${short}.compose.yml`)
      await expect(await readFile(join(dir, 'app/package.json'), 'utf8'))
        .toMatchFileSnapshot(`./golden/${short}.package.json`)
      await expect(await readFile(join(dir, 'app/vite.config.ts'), 'utf8'))
        .toMatchFileSnapshot(`./golden/${short}.vite.config.ts`)
    })
  }

  it('[sveltekit] app shell publishes the styling seams', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-shell-sv-'))
    await converge(dir, { bricks: { vite: {}, sveltekit: {} }, overrides: {} })
    const layout = await readFile(join(dir, 'app/src/routes/+layout.svelte'), 'utf8')
    expect(layout).toContain('>>> stacky:app-head')
    expect(layout).toContain('>>> stacky:app-shell')
    expect(layout).toContain('{@render children()}')
    await expect(layout).toMatchFileSnapshot('./golden/sveltekit.layout.svelte')
  })

  it('[tanstack-start] app shell publishes the styling seams', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-shell-rx-'))
    await converge(dir, { bricks: { vite: {}, 'tanstack-start': {} }, overrides: {} })
    const root = await readFile(join(dir, 'app/src/routes/__root.tsx'), 'utf8')
    expect(root).toContain('>>> stacky:app-head')
    expect(root).toContain('>>> stacky:app-shell')
    expect(root).toContain('<Outlet />')
    await expect(root).toMatchFileSnapshot('./golden/tanstack.root.tsx')
  })

  it('each framework owns a flavored tsconfig', async () => {
    const svDir = await mkdtemp(join(tmpdir(), 'stacky-tsc-sv-'))
    await converge(svDir, { bricks: { vite: {}, sveltekit: {} }, overrides: {} })
    const rxDir = await mkdtemp(join(tmpdir(), 'stacky-tsc-rx-'))
    await converge(rxDir, { bricks: { vite: {}, 'tanstack-start': {} }, overrides: {} })
    const svTs = await readFile(join(svDir, 'app/tsconfig.json'), 'utf8')
    const rxTs = await readFile(join(rxDir, 'app/tsconfig.json'), 'utf8')
    expect(svTs).toContain('.svelte-kit/tsconfig.json')
    expect(rxTs).toContain('react-jsx')
    await expect(svTs).toMatchFileSnapshot('./golden/sveltekit.tsconfig.json')
    await expect(rxTs).toMatchFileSnapshot('./golden/tanstack.tsconfig.json')
  })

  it('[sveltekit] sqlite stack matches the committed goldens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stacky-golden-sqlite-'))
    await converge(dir, { bricks: { vite: {}, sveltekit: {}, sqlite: {}, drizzle: {} }, overrides: {} })
    await expect(await readFile(join(dir, 'app/drizzle.config.ts'), 'utf8'))
      .toMatchFileSnapshot('./golden/sqlite.drizzle.config.ts')
    await expect(await readFile(join(dir, 'app/src/hooks.server.ts'), 'utf8'))
      .toMatchFileSnapshot('./golden/sqlite.hooks.server.ts')
    await expect(await readFile(join(dir, 'db/schema.ts'), 'utf8'))
      .toMatchFileSnapshot('./golden/sqlite.schema.ts')
  })
})
