import { emptyManifest, writeManifest } from '@stacky/core'

export async function init(cwd: string): Promise<number> {
  await writeManifest(cwd, emptyManifest())
  console.log(`Initialised stack.toml in ${cwd}. Add a brick with \`stacky add <name>\`.`)
  return 0
}
