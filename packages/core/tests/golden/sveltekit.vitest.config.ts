import type { PluginOption } from 'vite'
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

const testPlugins: PluginOption[] = []
// >>> stacky:vitest-plugins
import { svelteTesting } from '@testing-library/svelte/vite'
testPlugins.push(svelteTesting())
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
