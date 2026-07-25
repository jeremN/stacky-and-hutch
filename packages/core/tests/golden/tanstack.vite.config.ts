import { defineConfig, type PluginOption } from 'vite'

const stackyPlugins: PluginOption[] = []
// >>> stacky:vite-plugins
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
stackyPlugins.push(tanstackStart())
stackyPlugins.push(react())
// <<< stacky:vite-plugins

export default defineConfig({
  plugins: stackyPlugins,
})
