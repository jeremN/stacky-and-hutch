import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** True if `dir` is a git repo with uncommitted changes. A non-repo is never "dirty". */
export async function isDirty(dir: string): Promise<boolean> {
  try {
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: dir })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}
