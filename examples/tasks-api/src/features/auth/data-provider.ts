import type { DataProvider, RefreshTokenData } from '@dotpress/auth'
import { get, run, type Database } from '../../db/database.ts'
import type { UserRepository } from '../users/repository.ts'

interface RefreshTokenRow {
  user_id: string
  jwt_id: string
  family_id: string
  expires_at: string
  used_at: string | null
  revoked_at: string | null
}

/** What @dotpress/auth reads and writes: users and refresh tokens. */
export const createDataProvider = (
  db: Database,
  users: UserRepository
): DataProvider => ({
  storeRefreshToken: async ({
    tokenHash,
    userId,
    jwtId,
    familyId,
    expiresAt,
  }) => {
    run(
      db,
      'INSERT INTO refresh_tokens (token_hash, user_id, jwt_id, family_id, expires_at) VALUES (?, ?, ?, ?, ?)',
      tokenHash,
      userId,
      jwtId,
      familyId,
      expiresAt.toISOString()
    )
  },

  findRefreshToken: async (
    tokenHash
  ): Promise<RefreshTokenData | undefined> => {
    const row = get<RefreshTokenRow>(
      db,
      'SELECT * FROM refresh_tokens WHERE token_hash = ?',
      tokenHash
    )
    return (
      row && {
        userId: row.user_id,
        jwtId: row.jwt_id,
        familyId: row.family_id,
        expiresAt: new Date(row.expires_at),
        isUsed: row.used_at !== null,
        usedAt: row.used_at === null ? null : new Date(row.used_at),
        revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
      }
    )
  },

  markRefreshTokenAsUsed: async (tokenHash, usedAt) => {
    run(
      db,
      'UPDATE refresh_tokens SET used_at = ? WHERE token_hash = ?',
      usedAt.toISOString(),
      tokenHash
    )
  },

  revokeTokens: async (userId) => {
    run(
      db,
      'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      new Date().toISOString(),
      userId
    )
  },

  revokeTokenFamily: async (familyId) => {
    run(
      db,
      'UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL',
      new Date().toISOString(),
      familyId
    )
  },

  // A logout stops the access tokens of the session at once.
  isSessionRevoked: async (sessionId) =>
    get(
      db,
      'SELECT 1 FROM refresh_tokens WHERE family_id = ? AND revoked_at IS NOT NULL LIMIT 1',
      sessionId
    ) !== undefined,

  // On every authenticated request: becomes ctx.user.
  findUserById: (userId) => users.findById(userId),

  // At login: the username is the email address.
  findUserIdentifiers: (username) => users.findCredentials(username),

  updatePasswordHash: (userId, passwordHash) =>
    users.setPasswordHash(userId, passwordHash),
})
