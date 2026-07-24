import { defineConfig, type PluginOption } from 'vite'

const stackyPlugins: PluginOption[] = []
// >>> stacky:vite-plugins
import { sveltekit } from '@sveltejs/kit/vite'
stackyPlugins.push(sveltekit())
// <<< stacky:vite-plugins

export default defineConfig({
  plugins: stackyPlugins,
})
