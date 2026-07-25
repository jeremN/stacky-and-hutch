import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier/flat'

const configs = [js.configs.recommended, ...tseslint.configs.recommended]
// >>> stacky:eslint-config
// <<< stacky:eslint-config
configs.push(prettier)

export default configs
