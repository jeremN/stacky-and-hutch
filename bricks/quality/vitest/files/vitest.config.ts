import type { PluginOption } from 'vite'
import { defineConfig, mergeConfig } from 'vitest/config'
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
