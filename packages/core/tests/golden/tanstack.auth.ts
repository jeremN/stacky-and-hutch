import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { Pool } from 'pg'

const plugins: BetterAuthPlugin[] = []
// >>> stacky:auth-plugins
import { tanstackStartCookies } from 'better-auth/tanstack-start'
plugins.push(tanstackStartCookies())
// <<< stacky:auth-plugins

export const auth = betterAuth({
  database: new Pool({ connectionString: process.env.DATABASE_URL }),
  emailAndPassword: { enabled: true },
  plugins,
})
