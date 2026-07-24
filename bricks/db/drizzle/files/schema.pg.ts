import { pgTable, serial, timestamp } from 'drizzle-orm/pg-core'

export const health = pgTable('health', {
  id: serial('id').primaryKey(),
  checkedAt: timestamp('checked_at').notNull().defaultNow(),
})
