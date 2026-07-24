import type { Handle } from '@sveltejs/kit'

// >>> stacky:server-init
import Database from 'better-sqlite3'

export const sqlite = new Database(process.env.DATABASE_URL!)
import { drizzle } from 'drizzle-orm/better-sqlite3'

export const db = drizzle(process.env.DATABASE_URL!)
// <<< stacky:server-init

export const handle: Handle = async ({ event, resolve }) => {
  return resolve(event)
}
