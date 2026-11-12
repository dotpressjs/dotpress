import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

/**
 * Opens the SQLite database (`:memory:` in the tests), and applies the
 * schema. The API and the worker open the same file: SQLite handles the
 * concurrent processes (WAL mode).
 */
export const openDatabase = (path: string) => {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  if (path !== ':memory:') {
    // Readers do not block the writer; a writer waits up to 5 seconds for
    // another one, instead of failing at once.
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
  }
  db.exec(readFileSync(new URL('schema.sql', import.meta.url), 'utf8'))
  return db
}

export type Database = DatabaseSync

/** Rows of a query, typed by the caller. */
export const all = <T>(db: Database, sql: string, ...params: SQLInputValue[]) =>
  db.prepare(sql).all(...params) as T[]

/** First row of a query, or undefined. */
export const get = <T>(db: Database, sql: string, ...params: SQLInputValue[]) =>
  db.prepare(sql).get(...params) as T | undefined

/** Runs a statement. */
export const run = (db: Database, sql: string, ...params: SQLInputValue[]) =>
  db.prepare(sql).run(...params)

/** Runs `fn` in a transaction: all its statements, or none. */
export const transaction = <T>(db: Database, fn: () => T): T => {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Placeholders for a list of values: `?, ?, ?`. */
export const placeholders = (values: readonly unknown[]) =>
  values.map(() => '?').join(', ')
