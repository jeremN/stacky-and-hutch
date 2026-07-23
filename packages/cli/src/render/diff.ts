import type { FileOp } from '@stacky/core'

const SIGIL: Record<FileOp['kind'], string> = {
  create: '+', overwrite: '~', compose: '~', inject: '>', delete: '-', conflict: '!',
}

export function renderPlan(ops: FileOp[]): string {
  if (ops.length === 0) return 'Nothing to do — the project already matches stack.toml.'
  return ops
    .map((op) => {
      const detail =
        op.kind === 'compose' ? ` (from ${op.contributors.join(', ')})`
        : op.kind === 'inject' ? ` [${op.marker}]`
        : op.kind === 'conflict' ? '  <- you edited this; stacky will not touch it'
        : ''
      return `  ${SIGIL[op.kind]} ${op.path}${detail}`
    })
    .join('\n')
}
