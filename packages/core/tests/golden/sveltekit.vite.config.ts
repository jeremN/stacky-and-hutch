import { defineConfig } from 'vite'

// >>> stacky:vite-plugins
import { sveltekit } from '@sveltejs/kit/vite'
const stackyPlugins = [sveltekit()]
// <<< stacky:vite-plugins

export default defineConfig({
  plugins: stackyPlugins,
})
