import { randomUUID } from 'node:crypto'
import type { DataProvider, RefreshTokenData } from '@dotpress/auth'

export type Role = 'user' | 'admin'

export interface User {
  id: string
  username: string
  role: Role
  /** bcrypt hash: never returned by the API. */
  passwordHash: string
  createdAt: string
}

/** Usernames are compared without letter case and surrounding spaces. */
const normalize = (username: string) => username.trim().toLowerCase()

/**
 * In-memory storage of the users and of the refresh tokens, to replace
 * with your database: each method of `dataProvider` maps to one query.
 */
export const createStore = () => {
  const users = new Map<string, User>()
  // Refresh tokens by hash: the tokens themselves are never stored.
  const refreshTokens = new Map<string, RefreshTokenData>()

  const findByUsername = (username: string) =>
    [...users.values()].find((user) => user.username === normalize(username))

  const revokeWhere = (matches: (token: RefreshTokenData) => boolean) => {
    for (const token of refreshTokens.values()) {
      if (matches(token) && !token.revokedAt) token.revokedAt = new Date()
    }
  }

  /** What `@dotpress/auth` reads and writes. */
  const dataProvider: DataProvider = {
    storeRefreshToken: async ({
      tokenHash,
      userId,
      accessTokenId,
      sessionId,
      expiresAt,
    }) => {
      refreshTokens.set(tokenHash, {
        userId,
        accessTokenId,
        sessionId,
        expiresAt,
        isUsed: false,
        usedAt: null,
        revokedAt: null,
      })
    },
    findRefreshToken: async (tokenHash) => refreshTokens.get(tokenHash),
    markRefreshTokenAsUsed: async (tokenHash, usedAt) => {
      const token = refreshTokens.get(tokenHash)
      if (token) Object.assign(token, { isUsed: true, usedAt })
    },
    // Every session of a user (logout of every device, password change).
    revokeUserTokens: async (userId) =>
      revokeWhere((token) => token.userId === userId),
    // One session: the refresh tokens rotated from the same login.
    revokeSessionTokens: async (sessionId) =>
      revokeWhere((token) => token.sessionId === sessionId),
    // Optional: the access tokens of a revoked session stop working at
    // once, instead of at their expiry (15 minutes). A revoked session has
    // revoked refresh tokens: no other storage needed.
    isSessionRevoked: async (sessionId) =>
      [...refreshTokens.values()].some(
        (token) => token.sessionId === sessionId && token.revokedAt
      ),
    // Called on every authenticated request: the public profile, becoming
    // ctx.user. Return undefined for a deleted or disabled account.
    findUserById: async (userId) => {
      const user = users.get(userId)
      return (
        user && { id: user.id, username: user.username, roles: [user.role] }
      )
    },
    // Called at login.
    findUserIdentifiers: async (username) => {
      const user = findByUsername(username)
      return (
        user && {
          userId: user.id,
          passwordHash: user.passwordHash,
          role: user.role,
        }
      )
    },
    // Optional: upgrades the hashes at login after a change of
    // passwordHashRounds.
    updatePasswordHash: async (userId, passwordHash) => {
      const user = users.get(userId)
      if (user) user.passwordHash = passwordHash
    },
  }

  return {
    dataProvider,
    users: {
      create: async (input: {
        username: string
        passwordHash: string
        role?: Role
      }): Promise<User> => {
        const user: User = {
          id: randomUUID(),
          username: normalize(input.username),
          role: input.role ?? 'user',
          passwordHash: input.passwordHash,
          createdAt: new Date().toISOString(),
        }
        users.set(user.id, user)
        return user
      },
      get: async (id: string) => users.get(id),
      findByUsername: async (username: string) => findByUsername(username),
      list: async () => [...users.values()],
      setPasswordHash: async (id: string, passwordHash: string) => {
        const user = users.get(id)
        if (user) user.passwordHash = passwordHash
      },
    },
  }
}

export type Store = ReturnType<typeof createStore>
