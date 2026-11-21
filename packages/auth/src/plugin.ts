import {
  definePlugin,
  internalError,
  unauthorizedError,
  type DotpressRequest,
  type Middleware,
  type RouteGroup,
} from '@dotpress/core'
import { AuthError, internalsOf, type Auth } from './auth.js'
import { sha256 } from './crypto.js'
import { requireAuth } from './middlewares.js'
import type {
  IssuedTokens,
  LoginFailedEvent,
  ResolvedAuthOptions,
  ResolvedCookieOptions,
  ResolvedLoginThrottleOptions,
  TokenPair,
} from './types.js'
import { authRouteError } from './route-errors.js'
import './context.js'

export interface AuthPluginOptions {
  /** Prefix of the authentication routes. Defaults to `/auth`. */
  prefix?: string
  /** Registers the authentication routes. Defaults to `true`. */
  routes?: boolean
  /**
   * Publishes the public keys at `GET /.well-known/jwks.json`, for other
   * services verifying the tokens. Defaults to `false`.
   */
  jwks?: boolean
}

const PLUGIN_OPTIONS: readonly string[] = [
  'prefix',
  'routes',
  'jwks',
] satisfies (keyof AuthPluginOptions)[]

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

const BEARER = /^bearer +(\S+) *$/i

const bodyField = (body: unknown, key: string): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Access token of a request, and where it was found. The request body is
 * never read: an app route may receive an `accessToken` field of its own
 * (a third-party token, for example), and RFC 6750 discourages it.
 */
const findAccessToken = (
  req: DotpressRequest,
  cookies: ResolvedCookieOptions
): { token: string; source: 'header' | 'cookie' } | undefined => {
  // Authentication schemes are case-insensitive (RFC 7235).
  const bearer = BEARER.exec(req.header('authorization') ?? '')
  if (bearer) return { token: bearer[1]!, source: 'header' }

  if (cookies.enabled && cookies.accessTokenInCookie) {
    const cookie = req.cookies[cookies.accessTokenName]
    if (cookie) return { token: cookie, source: 'cookie' }
  }

  return undefined
}

/**
 * Counters of the login throttle for an attempt. The username is
 * normalized (letter case, spaces), and the keys are hashed: bounded size,
 * and no personal data in the store.
 */
const loginThrottleKeys = async (
  throttle: ResolvedLoginThrottleOptions,
  username: string,
  ipAddress: string
) => {
  const normalized = username.trim().toLowerCase()
  const { usernameAndIp, username: perUsername } = throttle.limits
  return {
    usernameAndIp: usernameAndIp && {
      key: `dotpress:login:username-ip:${await sha256(`${normalized}\n${ipAddress}`)}`,
      limit: usernameAndIp,
    },
    username: perUsername && {
      key: `dotpress:login:username:${await sha256(normalized)}`,
      limit: perUsername,
    },
  }
}

/** Response of the cookie routes to a cross-origin request. */
const crossOriginError = () => authRouteError('CROSS_ORIGIN_REQUEST')

/**
 * Token pair sent to the refresh route: refresh token cookie first, then
 * body fields.
 */
const extractTokens = (
  req: DotpressRequest,
  body: unknown,
  cookies: ResolvedCookieOptions
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
      return authRouteError('EXPIRED_REFRESH_TOKEN')
    }
    return authRouteError('INVALID_REFRESH_TOKEN')
  }
  return internalError(fallback)
}

const registerRoutes = (
  group: RouteGroup,
  auth: Auth,
  settings: ResolvedAuthOptions
) => {
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
    return authRouteError('INVALID_LOGIN')
  }

  const meta = { tags: ['auth'] }
  /** Cookie routes refuse requests from other origins. */
  const crossOrigin =
    'Cross-origin request in cookie mode (`CROSS_ORIGIN_REQUEST`, see cookies.trustedOrigins).'

  group.defineRoute({
    method: 'post',
    path: '/login',
    meta: {
      ...meta,
      summary: 'Log in with a username and a password',
      responses: {
        401: 'Invalid credentials (`INVALID_LOGIN`).',
        429: 'Too many failed attempts (`TOO_MANY_LOGIN_ATTEMPTS`), with a `Retry-After` header.',
      },
    },
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
    handler: async ({ req, res, logger }) => {
      const { username, password, clientId, mode } = req.body
      const event = {
        username,
        clientId: clientId ?? '',
        ipAddress: clientIp(req),
      }

      // Brute force protection, before any password check: the attempt
      // is counted first (atomic increment), so that parallel attempts
      // cannot pass before the counter is updated.
      const throttle = settings.loginThrottle
      const counters =
        throttle &&
        (await loginThrottleKeys(throttle, username, event.ipAddress))
      if (throttle && counters) {
        let retryAfter = 0
        for (const counter of [counters.usernameAndIp, counters.username]) {
          if (!counter) continue
          const state = await throttle.store.increment(
            counter.key,
            counter.limit.window
          )
          if (state.count > counter.limit.max) {
            retryAfter = Math.max(
              retryAfter,
              Math.ceil((state.resetAt.getTime() - Date.now()) / 1000),
              1
            )
          }
        }
        if (retryAfter > 0) {
          await settings.onLoginFailed?.({
            ...event,
            errorType: 'too_many_attempts',
          })
          res.setHeader('retry-after', String(retryAfter))
          return authRouteError('TOO_MANY_LOGIN_ATTEMPTS')
        }
      }

      const rejected = await settings.beforeLogin?.({ ...event, req })
      if (rejected) return rejected

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
        !clients.isUserRoleAllowed({
          userId: user.userId,
          role: user.role,
          clientId,
        })
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

      // A successful login clears the counter of this client only: a
      // distributed attack on the account keeps being counted.
      if (throttle && counters?.usernameAndIp) {
        await throttle.store.reset(counters.usernameAndIp.key)
      }

      await settings.onLoginSuccess?.({ ...event, userId: user.userId })

      // Upgrades a hash with another cost (passwordHashRounds raised).
      if (
        dataProvider.updatePasswordHash &&
        user.passwordHash &&
        auth.passwordNeedsRehash(user.passwordHash)
      ) {
        try {
          await dataProvider.updatePasswordHash(
            user.userId,
            await auth.rehashPassword(password)
          )
        } catch (error) {
          logger.warn(
            error instanceof Error ? error : { error },
            'Cannot update the password hash'
          )
        }
      }

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
    meta: {
      ...meta,
      summary: 'Rotate a token pair',
      responses: {
        401: 'Missing, invalid, expired or reused tokens.',
        403: crossOrigin,
      },
    },
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
      if (!extracted) return authRouteError('NO_TOKENS_PROVIDED')
      if (
        extracted.mode === 'cookie' &&
        !(await auth.isCookieAuthenticationAllowed(req))
      ) {
        return crossOriginError()
      }

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
    meta: { ...meta, summary: 'Authenticated user' },
    middlewares: [requireAuth],
    handler: ({ user }) => user,
  })

  group.defineRoute({
    method: 'post',
    path: '/restore',
    meta: {
      ...meta,
      summary: 'Restore a session from the auth cookies',
      responses: {
        401: 'Missing or invalid auth cookies.',
        403: crossOrigin,
      },
    },
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
      if (!cookies.enabled) return authRouteError('COOKIES_NOT_ENABLED')
      if (!cookies.accessTokenInCookie) {
        return authRouteError('ACCESS_TOKEN_NOT_IN_COOKIE')
      }

      const refreshToken = req.cookies[cookies.refreshTokenName]
      const accessToken = req.cookies[cookies.accessTokenName]
      if (!refreshToken) return authRouteError('NO_REFRESH_TOKEN')
      if (!accessToken) return authRouteError('NO_ACCESS_TOKEN')
      if (!(await auth.isCookieAuthenticationAllowed(req))) {
        return crossOriginError()
      }

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
        const { userId, user, ...tokens } = await auth.refreshTokens({
          accessToken,
          refreshToken,
        })
        auth.setAuthCookies(res, tokens)

        return { userId, ...issuedExpiration(tokens), user }
      } catch (error) {
        return refreshErrorResponse(error, 'Cannot restore session.')
      }
    },
  })

  group.defineRoute({
    method: 'post',
    path: '/logout',
    meta: {
      ...meta,
      summary: 'Revoke the current session, or every session of the user',
      responses: {
        401: '`scope: "all"` without a valid refresh token or access token.',
        403: crossOrigin,
      },
    },
    schema: (z) => ({
      body: z
        .object({
          refreshToken: z.string().optional(),
          scope: z.enum(['current', 'all']).optional(),
        })
        .optional(),
    }),
    // The session is proven by the refresh token (cookie, then body), or
    // by the access token: an expired access token does not prevent a
    // logout.
    handler: async ({ req, res, auth: session }) => {
      const scope = req.body?.scope ?? 'current'
      const cookieRefreshToken = cookies.enabled
        ? req.cookies[cookies.refreshTokenName]
        : undefined
      if (
        cookieRefreshToken &&
        !(await auth.isCookieAuthenticationAllowed(req))
      ) {
        return crossOriginError()
      }

      const refreshToken = cookieRefreshToken || req.body?.refreshToken
      const revoked = refreshToken
        ? await auth.revokeSession(refreshToken, { scope })
        : undefined

      if (!revoked && session) {
        if (scope === 'all') {
          await dataProvider.revokeUserTokens(session.userId)
        } else if (session.sessionId) {
          await dataProvider.revokeSessionTokens(session.sessionId)
        }
      } else if (!revoked && scope === 'all') {
        // Logging out every device requires proving the identity.
        return unauthorizedError()
      }

      // Idempotent (RFC 7009): an unknown or missing token still logs the
      // client out.
      auth.clearAuthCookies(res)
      return { success: true }
    },
  })
}

/** Group prefix as the router stores it: `/auth/` gives `/auth`. */
const normalizePrefix = (prefix: string) =>
  `/${prefix.split('/').filter(Boolean).join('/')}`

/**
 * Plugs an authentication service into an app:
 *
 * - reads the access token of every request, and sets `ctx.user` and
 *   `ctx.auth` when it is valid;
 * - registers the `POST /auth/login`, `POST /auth/refresh`,
 *   `GET /auth/me`, `POST /auth/restore` and `POST /auth/logout` routes.
 */
export const authPlugin = (auth: Auth, options: AuthPluginOptions = {}) => {
  const internal = internalsOf(auth)
  if (!internal) {
    throw new TypeError(
      'authPlugin(): expected an auth service created with createAuth().'
    )
  }
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('authPlugin(): options must be an object.')
  }
  for (const key of Object.keys(options)) {
    if (!PLUGIN_OPTIONS.includes(key)) {
      throw new TypeError(`authPlugin(): unknown option "${key}".`)
    }
  }
  const { settings } = internal
  const prefix = options.prefix ?? '/auth'

  return definePlugin({
    name: 'auth',
    auth,
    securitySchemes: AUTH_SECURITY_SCHEMES,
    async setup(api) {
      // Fails at startup on invalid keys. The refresh token cookie is only
      // sent to the auth routes: its path is their browser path.
      await internal.init({
        ...(options.routes === false
          ? {}
          : { routesPath: api.publicPath(normalizePrefix(prefix)) }),
        ...(api.cors ? { cors: api.cors } : {}),
      })

      api.decorateContext('user', () => undefined)
      api.decorateContext('auth', () => undefined)

      // Requests whose bearer token was rejected (expired, revoked…).
      const rejectedTokens = new WeakSet<object>()

      const authenticate: Middleware = async (ctx) => {
        const found = findAccessToken(ctx.req, settings.cookies)
        if (!found) return
        const { token } = found

        // Cross-site request forgery: the browser attached the cookie to a
        // request from another origin. The request stays anonymous.
        if (
          found.source === 'cookie' &&
          !(await auth.isCookieAuthenticationAllowed(ctx.req))
        ) {
          ctx.logger.warn(
            { origin: ctx.req.header('origin') },
            'Access token cookie ignored: cross-origin request (see cookies.trustedOrigins)'
          )
          return
        }

        try {
          const session = await auth.verifyAccessToken(token)
          const user = await settings.dataProvider.findUserById(session.userId)
          if (!user) {
            if (found.source === 'header') rejectedTokens.add(ctx)
            return
          }

          ctx.user = user
          ctx.auth = { ...session, roles: auth.getUserRoles(user) }
        } catch (error) {
          if (found.source === 'header') rejectedTokens.add(ctx)
          ctx.logger.warn(
            error instanceof Error ? error : { error },
            'Invalid access token'
          )
        }
      }

      api.addGlobalMiddleware(authenticate)

      // Challenge of the 401 responses (RFC 7235, RFC 6750), unless one was
      // set by the app or another plugin.
      api.hooks.onResponse(({ response, ctx }) => {
        if (response.status !== 401) return
        const has = Object.keys(response.headers).some(
          (name) => name.toLowerCase() === 'www-authenticate'
        )
        if (has) return
        return {
          ...response,
          headers: {
            ...response.headers,
            'www-authenticate':
              ctx && rejectedTokens.has(ctx)
                ? 'Bearer error="invalid_token"'
                : 'Bearer',
          },
        }
      })

      if (options.jwks) {
        api.defineRoute({
          path: '/.well-known/jwks.json',
          meta: { tags: ['auth'], summary: 'Public keys of the access tokens' },
          handler: async ({ res }) => {
            // Short cache: verifiers pick up a rotation within minutes.
            res.setHeader('cache-control', 'public, max-age=300')
            return auth.getJwks()
          },
        })
      }

      if (options.routes !== false) {
        registerRoutes(api.createGroup(prefix), auth, settings)
      }
    },
  })
}
