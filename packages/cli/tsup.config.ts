import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // Bundle the workspace core (its package main is a .ts source); keep real deps external.
  noExternal: ['@stacky/core'],
  external: ['cac', 'smol-toml', 'yaml', 'eta'],
  banner: { js: '#!/usr/bin/env node' },
})
