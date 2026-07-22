import type { ResolutionError } from './types.js'

export function formatError(e: ResolutionError): string {
  switch (e.kind) {
    case 'ambiguous':
      return `"${e.requiredBy}" needs a "${e.capability}" — candidates: ${e.candidates.join(', ')}. Pick one and add it to stack.toml.`
    case 'unsatisfiable':
      return `"${e.requiredBy}" needs a "${e.capability}" but no brick provides it. Run \`stacky brick new\` to author one.`
    case 'slot-conflict':
      return `Slot "${e.slot}" holds one brick, but got: ${e.bricks.join(', ')}.`
    case 'cycle':
      return `Circular requires: ${e.path.join(' -> ')}.`
    case 'unknown-brick':
      return `Unknown brick "${e.name}".${e.suggestions.length ? ` Did you mean ${e.suggestions.join(' or ')}?` : ''}`
    case 'missing-param':
      return `Brick "${e.brick}" needs param "${e.param}" (${e.schema.type}). Set it with --set ${e.param}=<value>.`
    case 'invalid-param':
      return `Brick "${e.brick}" param "${e.param}": ${e.reason} (got ${JSON.stringify(e.value)}).`
  }
}

/** Exit 2 means "I need input from you"; exit 1 means "this is broken". */
export function exitCodeFor(errors: ResolutionError[]): 1 | 2 {
  const needsInput = errors.every((e) => e.kind === 'ambiguous' || e.kind === 'missing-param')
  return errors.length > 0 && needsInput ? 2 : 1
}
