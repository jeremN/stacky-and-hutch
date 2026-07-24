import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const health = sqliteTable('health', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  checkedAt: text('checked_at').notNull(),
})
