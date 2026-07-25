import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier/flat'

const configs = [js.configs.recommended, ...tseslint.configs.recommended]
// >>> stacky:eslint-config
import svelte from 'eslint-plugin-svelte'
configs.push(...svelte.configs.recommended)
// <<< stacky:eslint-config
configs.push(prettier)

export default configs
