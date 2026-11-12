import { randomUUID } from 'node:crypto'
import { all, get, placeholders, run, type Database } from '../db/database.ts'

export type Locale = 'en' | 'fr'
export const LOCALES: readonly Locale[] = ['en', 'fr']

export interface User {
  id: string
  email: string
  name: string
  locale: Locale
  createdAt: string
}

interface UserRow {
  id: string
  email: string
  name: string
  password_hash: string
  locale: Locale
  created_at: string
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  locale: row.locale,
  createdAt: row.created_at,
})

/** Email addresses are compared without letter case. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase()

/**
 * Access to the users. Asynchronous like any database client: replacing
 * SQLite with Postgres changes the queries of the repositories, not their
 * callers.
 */
export const createUserRepository = (db: Database) => ({
  create: async (input: {
    email: string
    name: string
    passwordHash: string
    locale: Locale
  }): Promise<User> => {
    const row: UserRow = {
      id: randomUUID(),
      email: normalizeEmail(input.email),
      name: input.name,
      password_hash: input.passwordHash,
      locale: input.locale,
      created_at: new Date().toISOString(),
    }
    run(
      db,
      'INSERT INTO users (id, email, name, password_hash, locale, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      row.id,
      row.email,
      row.name,
      row.password_hash,
      row.locale,
      row.created_at
    )
    return toUser(row)
  },

  findById: async (id: string) => {
    const row = get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id)
    return row && toUser(row)
  },

  findByEmail: async (email: string) => {
    const row = get<UserRow>(
      db,
      'SELECT * FROM users WHERE email = ?',
      normalizeEmail(email)
    )
    return row && toUser(row)
  },

  /** Users by id, for batched loads: one query for many ids. */
  findManyById: async (ids: readonly string[]) =>
    all<UserRow>(
      db,
      `SELECT * FROM users WHERE id IN (${placeholders(ids)})`,
      ...ids
    ).map(toUser),

  /** Credentials, for the login only. */
  findCredentials: async (email: string) => {
    const row = get<UserRow>(
      db,
      'SELECT * FROM users WHERE email = ?',
      normalizeEmail(email)
    )
    return row && { userId: row.id, passwordHash: row.password_hash }
  },

  setPasswordHash: async (id: string, passwordHash: string) => {
    run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, id)
  },
})

export type UserRepository = ReturnType<typeof createUserRepository>
