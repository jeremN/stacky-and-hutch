import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import Database from 'better-sqlite3'

const plugins: BetterAuthPlugin[] = []
// >>> stacky:auth-plugins
// <<< stacky:auth-plugins

export const auth = betterAuth({
  database: new Database(process.env.DATABASE_URL!),
  emailAndPassword: { enabled: true },
  plugins,
})
