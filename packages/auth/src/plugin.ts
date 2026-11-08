import {
  definePlugin,
  internalError,
  unauthorizedError,
  type DotpressRequest,
  type Middleware,
  type RouteGroup,
} from '@dotpress/core'
import { AuthError, type Auth } from './auth.js'
import { requireAuth } from './middlewares.js'
import type {
  IssuedTokens,
  LoginFailedEvent,
  ResolvedCookieSettings,
  TokenPair,
} from './types.js'
import './context.js'

export interface AuthPluginOptions {
  /** Prefix of the authentication routes. Defaults to `/auth`. */
  prefix?: string
  /** Registers the authentication routes. Defaults to `true`. */
  routes?: boolean
}

/** Security schemes of the plugin, for documentation generators. */
export const AUTH_SECURITY_SCHEMES = {
  bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
} as const

const LOCAL_IPS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '::ffff',
  '::ffff:127.0.0.1',
])

/** Client IP address for login events (empty for local requests). */
const clientIp = (req: DotpressRequest) =>
  req.ip && !LOCAL_IPS.has(req.ip) ? req.ip : ''

const bodyField = (body: unknown, key: string): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Access token of a request: `Authorization: Bearer` header, then cookie
 * (when enabled), then `accessToken` body field.
 */
export const extractAccessToken = (
  req: DotpressRequest,
  cookies: ResolvedCookieSettings
): string | undefined => {
  const header = req.header('authorization')
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length)

  if (cookies.enabled && cookies.accessTokenInCookie) {
    const cookie = req.cookies[cookies.accessTokenName]
    if (cookie) return cookie
  }

  return bodyField(req.body, 'accessToken')
}

/**
 * Token pair sent to the refresh route: refresh token cookie first, then
 * body fields.
 */
const extractTokens = (
  req: DotpressRequest,
  body: unknown,
  cookies: ResolvedCookieSettings
): (TokenPair & { mode: 'cookie' | 'body' }) | undefined => {
  const cookieRefreshToken = req.cookies[cookies.refreshTokenName]

  if (cookieRefreshToken) {
    const accessToken = cookies.accessTokenInCookie
      ? req.cookies[cookies.accessTokenName]
      : bodyField(body, 'accessToken')
    return accessToken
      ? { accessToken, refreshToken: cookieRefreshToken, mode: 'cookie' }
      : undefined
  }

  const accessToken = bodyField(body, 'accessToken')
  const refreshToken = bodyField(body, 'refreshToken')
  return accessToken && refreshToken
    ? { accessToken, refreshToken, mode: 'body' }
    : undefined
}

const refreshErrorResponse = (error: unknown, fallback: string) => {
  if (error instanceof AuthError) {
    if (error.code === 'EXPIRED_REFRESH_TOKEN') {
      return unauthorizedError('EXPIRED_REFRESH_TOKEN')
    }
    return unauthorizedError('INVALID_REFRESH_TOKEN')
  }
  return internalError(fallback)
}

const registerRoutes = (group: RouteGroup, auth: Auth) => {
  const { settings } = auth
  const { dataProvider, cookies } = settings

  /**
   * Expiration fields of the responses: access token, and session when an
   * absolute timeout applies.
   */
  const expiration = (accessTokenExpiresAt: Date, sessionExpiresAt?: Date) => ({
    expiresIn: Math.max(
      0,
      Math.ceil((accessTokenExpiresAt.getTime() - Date.now()) / 1000)
    ),
    expiresAt: accessTokenExpiresAt.toISOString(),
    ...(sessionExpiresAt && {
      sessionExpiresAt: sessionExpiresAt.toISOString(),
    }),
  })
  const issuedExpiration = (tokens: IssuedTokens) =>
    expiration(tokens.accessTokenExpiresAt, tokens.sessionExpiresAt)

  /**
   * Tokens returned in the response body. Tokens set as cookies are never
   * returned, so that the JavaScript of the page cannot read them: the
   * refresh token always is a cookie in cookie mode, the access token only
   * with `accessTokenInCookie`.
   */
  const bodyTokens = (
    tokens: TokenPair,
    inCookies: boolean
  ): Partial<TokenPair> => {
    if (!inCookies) {
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      }
    }
    return cookies.accessTokenInCookie
      ? {}
      : { accessToken: tokens.accessToken }
  }

  const { clients } = settings

  const loginFailed = async (event: LoginFailedEvent) => {
    await settings.onLoginFailed?.(event)
    return unauthorizedError('INVALID_LOGIN')
  }

  const meta = { tags: ['auth'] }
  const securedMeta = { ...meta, security: ['bearerAuth'] }

  group.defineRoute({
    method: 'post',
    path: '/login',
    meta: { ...meta, summary: 'Log in with a username and a password' },
    schema: (z) => ({
      body: z.object({
        username: z.string(),
        password: z.string(),
        // One of the allowed clients when the clients setting is defined,
        // otherwise any string, only reported in the login events.
        clientId: !clients
          ? z.string().optional()
          : clients.required
            ? z.enum(clients.allowed as [string, ...string[]])
            : z.enum(clients.allowed as [string, ...string[]]).optional(),
        mode: z.enum(['body', 'cookie']).optional(),
      }),
      response: z.object({
        userId: z.string(),
        accessToken: z.string().optional(),
        refreshToken: z.string().optional(),
        expiresIn: z.number(),
        expiresAt: z.string(),
        sessionExpiresAt: z.string().optional(),
      }),
    }),
    handler: async ({ req, res }) => {
      const { username, password, clientId, mode } = req.body
      const event = {
        username,
        clientId: clientId ?? '',
        ipAddress: clientIp(req),
      }

      const user = await dataProvider.findUserIdentifiers(username)
      // The password is checked even for unknown users, against a dummy
      // hash: both failures take the same time.
      const passwordValid = await auth.verifyPassword(
        password,
        user?.passwordHash
      )
      if (!user) {
        return loginFailed({ ...event, errorType: 'invalid_username' })
      }

      if (!passwordValid) {
        return loginFailed({ ...event, errorType: 'invalid_password' })
      }

      if (
        clientId !== undefined &&
        clients?.isUserRoleAllowed &&
        !clients.isUserRoleAllowed(user.role ?? '', clientId)
      ) {
        return loginFailed({ ...event, errorType: 'invalid_role' })
      }

      const tokens = await auth.generateTokensForUser({
        userId: user.userId,
        username,
        // Without clients setting, the clientId is only reported in the
        // login events: an unchecked value is not written in the token.
        clientId: clients ? clientId : undefined,
      })

      await settings.onLoginSuccess?.({ ...event, userId: user.userId })

      const inCookies = mode === 'cookie' && cookies.enabled
      if (inCookies) auth.setAuthCookies(res, tokens)

      return {
        userId: user.userId,
        ...bodyTokens(tokens, inCookies),
        ...issuedExpiration(tokens),
      }
    },
  })

  group.defineRoute({
    method: 'post',
    path: '/refresh',
    meta: { ...meta, summary: 'Rotate a token pair' },
    schema: (z) => ({
      body: z
        .object({
          accessToken: z.string().optional(),
          refreshToken: z.string().optional(),
        })
        .optional(),
      response: z.object({
        userId: z.string(),
        accessToken: z.string().optional(),
        refreshToken: z.string().optional(),
        expiresIn: z.number(),
        expiresAt: z.string(),
        sessionExpiresAt: z.string().optional(),
      }),
    }),
    handler: async ({ req, res }) => {
      const extracted = extractTokens(req, req.body, cookies)
      if (!extracted) return unauthorizedError('NO_TOKENS_PROVIDED')

      try {
        const { userId, ...tokens } = await auth.refreshTokens(extracted)
        const inCookies = extracted.mode === 'cookie' && cookies.enabled
        if (inCookies) auth.setAuthCookies(res, tokens)
        return {
          userId,
          ...bodyTokens(tokens, inCookies),
          ...issuedExpiration(tokens),
        }
      } catch (error) {
        return refreshErrorResponse(error, 'Can not refresh tokens.')
      }
    },
  })

  group.defineRoute({
    path: '/me',
    meta: { ...securedMeta, summary: 'Authenticated user' },
    middlewares: [requireAuth],
    handler: ({ user }) => user,
  })

  group.defineRoute({
    method: 'post',
    path: '/restore',
    meta: { ...meta, summary: 'Restore a session from the auth cookies' },
    schema: (z) => ({
      response: z.object({
        userId: z.string(),
        accessToken: z.string().optional(),
        refreshToken: z.string().optional(),
        expiresIn: z.number(),
        expiresAt: z.string(),
        sessionExpiresAt: z.string().optional(),
        user: z.unknown(),
      }),
    }),
    handler: async ({ req, res }) => {
      if (!cookies.enabled) return unauthorizedError('COOKIES_NOT_ENABLED')
      if (!cookies.accessTokenInCookie) {
        return unauthorizedError('ACCESS_TOKEN_NOT_IN_COOKIE')
      }

      const refreshToken = req.cookies[cookies.refreshTokenName]
      const accessToken = req.cookies[cookies.accessTokenName]
      if (!refreshToken) return unauthorizedError('NO_REFRESH_TOKEN')
      if (!accessToken) return unauthorizedError('NO_ACCESS_TOKEN')

      // A valid access token restores the session as is.
      try {
        const session = await auth.verifyAccessToken(accessToken)
        const { userId } = session
        const user = await dataProvider.findUserById(userId)
        // The tokens stay in their cookies.
        if (user) {
          return {
            userId,
            ...expiration(
              new Date(Number(session.claims.exp) * 1000),
              auth.getSessionExpiresAt(session)
            ),
            user,
          }
        }
      } catch {
        // Expired or invalid: try the refresh token.
      }

      try {
        const { userId, ...tokens } = await auth.refreshTokens({
          accessToken,
          refreshToken,
        })
        auth.setAuthCookies(res, tokens)

        const user = await dataProvider.findUserById(userId)
        if (!user) return unauthorizedError('USER_NOT_FOUND')

        return { userId, ...issuedExpiration(tokens), user }
      } catch (error) {
        return refreshErrorResponse(error, 'Cannot restore session.')
      }
    },
  })

  group.defineRoute({
    method: 'post',
    path: '/logout',
    meta: { ...securedMeta, summary: 'Revoke the refresh tokens of the user' },
    middlewares: [requireAuth],
    handler: async ({ auth: session, res }) => {
      await dataProvider.revokeTokens(session.userId)
      auth.clearAuthCookies(res)
      return { success: true }
    },
  })
}

/**
 * Plugs an authentication service into an app:
 *
 * - reads the access token of every request, and sets `ctx.user` and
 *   `ctx.auth` when it is valid;
 * - registers the `POST /auth/login`, `POST /auth/refresh`,
 *   `GET /auth/me`, `POST /auth/restore` and `POST /auth/logout` routes.
 */
export const authPlugin = (auth: Auth, options: AuthPluginOptions = {}) => {
  const prefix = options.prefix ?? '/auth'

  return definePlugin({
    name: 'auth',
    auth,
    securitySchemes: AUTH_SECURITY_SCHEMES,
    async setup(api) {
      // Fails at startup on invalid keys.
      await auth.init()

      api.decorateContext('user', () => undefined)
      api.decorateContext('auth', () => undefined)

      const authenticate: Middleware = async (ctx) => {
        const token = extractAccessToken(ctx.req, auth.settings.cookies)
        if (!token) return

        try {
          const session = await auth.verifyAccessToken(token)
          const user = await auth.settings.dataProvider.findUserById(
            session.userId
          )
          if (!user) return

          ctx.user = user
          ctx.auth = { ...session, roles: auth.getUserRoles(user) }
        } catch (error) {
          ctx.logger.warn(
            error instanceof Error ? error : { error },
            'Invalid access token'
          )
        }
      }

      api.addGlobalMiddleware(authenticate)

      if (options.routes !== false) {
        registerRoutes(api.addRouteGroup(prefix), auth)
      }
    },
  })
}
