import { defineConfig, type PluginOption } from 'vite'

const stackyPlugins: PluginOption[] = []
// >>> stacky:vite-plugins
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
stackyPlugins.push(tanstackStart())
// <<< stacky:vite-plugins

export default defineConfig({
  plugins: stackyPlugins,
})
