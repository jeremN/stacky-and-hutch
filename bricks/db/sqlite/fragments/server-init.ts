import Database from 'better-sqlite3'

export const sqlite = new Database(process.env.DATABASE_URL!)
