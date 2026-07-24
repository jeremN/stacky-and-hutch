import { defineConfig } from 'vite'

// >>> stacky:vite-plugins
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
const stackyPlugins = [tanstackStart()]
// <<< stacky:vite-plugins

export default defineConfig({
  plugins: stackyPlugins,
})
