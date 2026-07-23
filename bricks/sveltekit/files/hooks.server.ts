import type { Handle } from '@sveltejs/kit'

// >>> stacky:server-init
// <<< stacky:server-init

export const handle: Handle = async ({ event, resolve }) => {
  return resolve(event)
}
