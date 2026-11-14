import { generateKeyPairSync } from 'node:crypto'
import { SignJWT, decodeJwt, decodeProtectedHeader, importPKCS8 } from 'jose'
import jwt from 'jsonwebtoken'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AuthError,
  createAuth,
  generatePasswordHash,
  isPasswordTooLong,
  type AuthOptions,
  type TokenPair,
} from '../src/index.js'
import {
  createStore,
  initAuth,
  issueAccessToken,
  keys,
  newRefreshToken,
  settingsOf,
  TEST_HASH_ROUNDS,
} from './support.js'

// Some tests move the clock forward to expire the access tokens.
afterEach(() => {
  vi.useRealTimers()
})

const DAY = 24 * 60 * 60
const HOUR = 60 * 60

const authWith = (settings: Partial<AuthOptions> = {}) => {
  const store = createStore()
  const auth = createAuth({
    keys,
    dataProvider: store.provider,
    issuer: 'https://api.example.com',
    passwordHashRounds: TEST_HASH_ROUNDS,
    ...settings,
  })
  return { auth, store }
}

describe('createAuth()', () => {
  it('requires keys and a data provider', () => {
    expect(() =>
      createAuth({ dataProvider: createStore().provider } as AuthOptions)
    ).toThrow('requires keys.privateKey and keys.publicKey')
    expect(() => createAuth({ keys } as AuthOptions)).toThrow(
      'requires a dataProvider'
    )
  })

  it('rejects unknown options, nested ones included', () => {
    for (const [settings, option] of [
      [{ accessTokenTtl: 900 }, 'accessTokenTtl'],
      [{ keys: { ...keys, id: 'main' } }, 'keys.id'],
      [
        { keys: { ...keys, additionalPublicKeys: [{ key: 'x' }] } },
        'keys.additionalPublicKeys[0].key',
      ],
      [{ session: { idleTimout: 60 } }, 'session.idleTimout'],
      [{ cookies: { enable: true } }, 'cookies.enable'],
      [{ clients: { allowed: ['app'], require: true } }, 'clients.require'],
      [
        { clients: { allowed: ['app'], sessions: { app: { idle: 60 } } } },
        'clients.sessions.app.idle',
      ],
      [{ loginThrottle: { limit: {} } }, 'loginThrottle.limit'],
      [
        { loginThrottle: { limits: { ip: { max: 1, window: 60 } } } },
        'loginThrottle.limits.ip',
      ],
      [
        { loginThrottle: { limits: { username: { max: 1, windows: 60 } } } },
        'loginThrottle.limits.username.windows',
      ],
    ] as const) {
      expect(() => authWith(settings as never)).toThrow(
        new TypeError(`createAuth(): unknown option "${option}".`)
      )
    }
  })

  it('names the renamed options', () => {
    const { privateKey, publicKey } = keys
    expect(() =>
      authWith({ keys: { secretKey: privateKey, publicKey } } as never)
    ).toThrow(new TypeError('keys.secretKey is renamed keys.privateKey.'))
  })

  it('accepts durations with a unit, rounded to the second', () => {
    const { auth } = authWith({
      accessTokenTTL: '15m',
      session: { idleTimeout: '7d', absoluteTimeout: '30d' },
      refreshTokenReuseInterval: '1500ms',
      loginThrottle: { limits: { username: { max: 10, window: '1h' } } },
    })

    expect(settingsOf(auth)).toMatchObject({
      accessTokenTTL: 900,
      session: { idleTimeout: 7 * DAY, absoluteTimeout: 30 * DAY },
      refreshTokenReuseInterval: 2,
      loginThrottle: { limits: { username: { max: 10, window: HOUR } } },
    })
    expect(() => authWith({ accessTokenTTL: '0.2s' })).toThrow(
      new RangeError(
        'Invalid accessTokenTTL: expected at least 1 second duration.'
      )
    )
  })

  it('requires an issuer', () => {
    for (const issuer of [undefined, '']) {
      expect(() => authWith({ issuer: issuer as unknown as string })).toThrow(
        'requires an issuer'
      )
    }
  })

  it('rejects an empty audience and invalid client lists', () => {
    expect(() => authWith({ audience: '' })).toThrow('Invalid audience')
    for (const allowed of [[], [''], 'app']) {
      expect(() =>
        authWith({ clients: { allowed: allowed as string[] } })
      ).toThrow('Invalid clients.allowed')
    }
  })

  it('applies the V1 defaults, with secure cookies', () => {
    const { auth } = authWith()

    expect(settingsOf(auth)).toMatchObject({
      accessTokenTTL: 900,
      session: { idleTimeout: 14 * DAY, absoluteTimeout: undefined },
      issuer: 'https://api.example.com',
      // The API audience defaults to the issuer.
      audience: 'https://api.example.com',
      cookies: {
        enabled: false,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        refreshTokenPath: '/auth',
        accessTokenName: '__Host-dotpress_access_token',
        refreshTokenName: '__Secure-dotpress_refresh_token',
        accessTokenInCookie: false,
      },
    })
  })

  describe('cookies', () => {
    const names = (cookies: AuthOptions['cookies']) => {
      const { accessTokenName, refreshTokenName } = settingsOf(
        authWith({ cookies }).auth
      ).cookies
      return [accessTokenName, refreshTokenName]
    }

    it.each([
      [{}, '__Host-', '__Secure-'],
      [{ refreshTokenPath: '/' }, '__Host-', '__Host-'],
      [{ path: '/api' }, '__Secure-', '__Secure-'],
      [{ domain: 'example.com' }, '__Secure-', '__Secure-'],
      [{ secure: false }, '', ''],
      [
        { path: undefined, refreshTokenPath: undefined },
        '__Host-',
        '__Secure-',
      ],
    ])(
      'prefixes the default names (%o)',
      (cookies, accessPrefix, refreshPrefix) => {
        expect(names(cookies)).toEqual([
          `${accessPrefix}dotpress_access_token`,
          `${refreshPrefix}dotpress_refresh_token`,
        ])
      }
    )

    it('keeps custom names', () => {
      expect(
        names({ accessTokenName: 'at', refreshTokenName: '__Secure-rt' })
      ).toEqual(['at', '__Secure-rt'])
      expect(
        names({ refreshTokenName: '__Host-rt', refreshTokenPath: '/' })
      ).toEqual(['__Host-dotpress_access_token', '__Host-rt'])
    })

    it.each([
      [{ accessTokenName: '__Host-at', domain: 'example.com' }, 'a __Host-'],
      [{ accessTokenName: '__Host-at', path: '/api' }, 'a __Host-'],
      [{ refreshTokenName: '__host-rt' }, 'a __Host-'],
      [{ accessTokenName: '__Secure-at', secure: false }, 'a __Secure-'],
      [{ refreshTokenName: '__SECURE-rt', secure: false }, 'a __Secure-'],
      [{ path: 'api' }, 'Invalid cookies.path'],
      [{ refreshTokenPath: '' }, 'Invalid cookies.refreshTokenPath'],
    ])('rejects invalid cookie settings (%o)', (cookies, message) => {
      expect(() => authWith({ cookies })).toThrow(message)
    })
  })

  describe('keys', () => {
    it('rejects PKCS#1 keys with conversion instructions', async () => {
      const pkcs1 = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      })

      await expect(
        initAuth(
          authWith({
            keys: { privateKey: pkcs1.privateKey, publicKey: keys.publicKey },
          }).auth
        )
      ).rejects.toThrow('openssl pkcs8 -topk8 -nocrypt')
      await expect(
        initAuth(
          authWith({
            keys: { privateKey: keys.privateKey, publicKey: pkcs1.publicKey },
          }).auth
        )
      ).rejects.toThrow('openssl rsa -RSAPublicKey_in')
    })

    it('rejects invalid keys, and retries on the next call', async () => {
      const { auth } = authWith({
        keys: { privateKey: 'not a key', publicKey: keys.publicKey },
      })

      await expect(initAuth(auth)).rejects.toThrow('Invalid auth privateKey')
      await expect(initAuth(auth)).rejects.toThrow('Invalid auth privateKey')
    })
  })

  describe('access tokens', () => {
    it('signs RS256 at+jwt tokens (RFC 9068)', async () => {
      const { auth } = authWith({
        accessTokenTTL: 900,
        clients: { allowed: ['backoffice'] },
        usernameClaim: true,
      })
      const before = Math.floor(Date.now() / 1000)

      const { accessTokenId, accessToken } = await issueAccessToken(auth, {
        userId: 'u1',
        username: 'ada',
        clientId: 'backoffice',
      })

      expect(decodeProtectedHeader(accessToken)).toEqual({
        alg: 'RS256',
        typ: 'at+jwt',
        kid: expect.any(String),
      })
      const claims = decodeJwt(accessToken)
      expect(claims).toMatchObject({
        sub: 'u1',
        username: 'ada',
        iss: 'https://api.example.com',
        aud: 'https://api.example.com',
        client_id: 'backoffice',
        jti: accessTokenId,
      })
      expect(claims.auth_time).toBeGreaterThanOrEqual(before)
      expect(claims.exp! - claims.iat!).toBe(900)
    })

    it('omits the username claim by default (personal data)', async () => {
      const { auth } = authWith()
      const pair = await auth.generateTokensForUser({
        userId: 'u1',
        username: 'ada@example.com',
      })

      expect(decodeJwt(pair.accessToken)).not.toHaveProperty('username')
      expect(
        (await auth.verifyAccessToken(pair.accessToken)).username
      ).toBeUndefined()
      const rotated = await auth.refreshTokens(pair)
      expect(decodeJwt(rotated.accessToken)).not.toHaveProperty('username')
    })

    it('does not write an empty username claim', async () => {
      const { auth } = authWith({ usernameClaim: true })
      const pair = await auth.generateTokensForUser({ userId: 'u1' })

      expect(decodeJwt(pair.accessToken)).not.toHaveProperty('username')
      // Session opened without the claim, refreshed with it enabled.
      const rotated = await auth.refreshTokens(pair)
      expect(decodeJwt(rotated.accessToken)).not.toHaveProperty('username')
    })

    it('verifies tokens and rejects tampered or expired ones', async () => {
      const { auth } = authWith()
      const { accessToken } = await issueAccessToken(auth, {
        userId: 'u1',
        username: 'ada',
      })

      await expect(auth.verifyAccessToken(accessToken)).resolves.toMatchObject({
        userId: 'u1',
        username: undefined,
        clientId: undefined,
      })

      const [header, , signature] = accessToken.split('.')
      const forged = `${header}.${Buffer.from(
        JSON.stringify({ sub: 'u2' })
      ).toString('base64url')}.${signature}`
      await expect(auth.verifyAccessToken(forged)).rejects.toBeInstanceOf(
        AuthError
      )

      const expired = jwt.sign({ username: 'ada' }, keys.privateKey, {
        algorithm: 'RS256',
        subject: 'u1',
        expiresIn: -10,
      })
      await expect(auth.verifyAccessToken(expired)).rejects.toMatchObject({
        code: 'INVALID_ACCESS_TOKEN',
      })
    })

    it.each([
      [
        'another issuer',
        // Same audience: only the issuer differs.
        {
          issuer: 'https://staging.example.com',
          audience: 'https://api.example.com',
        },
      ],
      ['another audience', { audience: 'https://billing.example.com' }],
    ])('rejects tokens of %s', async (_label, settings) => {
      const { accessToken } = await issueAccessToken(authWith(settings).auth, {
        userId: 'u1',
        username: 'ada',
      })

      await expect(
        authWith().auth.verifyAccessToken(accessToken)
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_TOKEN' })
    })

    it('verifies a configured audience', async () => {
      const { auth } = authWith({ audience: 'https://api.example.com/admin' })
      const { accessToken } = await issueAccessToken(auth, {
        userId: 'u1',
        username: 'ada',
      })

      expect(decodeJwt(accessToken).aud).toBe('https://api.example.com/admin')
      await expect(auth.verifyAccessToken(accessToken)).resolves.toMatchObject({
        userId: 'u1',
      })
    })

    it('rejects JWTs that are not access tokens (typ)', async () => {
      const { auth } = authWith()
      // Same key, issuer and audience, but another type of token.
      const idToken = jwt.sign({ username: 'ada' }, keys.privateKey, {
        algorithm: 'RS256',
        subject: 'u1',
        issuer: 'https://api.example.com',
        audience: 'https://api.example.com',
        expiresIn: 60,
      })

      await expect(auth.verifyAccessToken(idToken)).rejects.toMatchObject({
        code: 'INVALID_ACCESS_TOKEN',
      })
    })

    it('only accepts the clients of the configuration', async () => {
      const issuer = authWith({ clients: { allowed: ['app', 'backoffice'] } })
      const tokenFor = async (clientId?: string) =>
        (
          await issueAccessToken(issuer.auth, {
            userId: 'u1',
            username: 'ada',
            clientId,
          })
        ).accessToken
      const app = await tokenFor('app')
      const anonymous = await tokenFor()

      const verifier = authWith({
        clients: { allowed: ['backoffice'], required: true },
      }).auth
      await expect(verifier.verifyAccessToken(app)).rejects.toMatchObject({
        code: 'INVALID_ACCESS_TOKEN',
      })
      await expect(verifier.verifyAccessToken(anonymous)).rejects.toMatchObject(
        { code: 'INVALID_ACCESS_TOKEN' }
      )
      await expect(
        verifier.verifyAccessToken(await tokenFor('backoffice'))
      ).resolves.toMatchObject({ clientId: 'backoffice' })
    })

    it('refuses to sign tokens for unknown or missing clients', async () => {
      const { auth } = authWith({
        clients: { allowed: ['app'], required: true },
      })
      const subject = { userId: 'u1', username: 'ada' }

      await expect(
        issueAccessToken(auth, { ...subject, clientId: 'other' })
      ).rejects.toThrow('Unknown client "other"')
      await expect(issueAccessToken(auth, subject)).rejects.toThrow(
        'A clientId is required'
      )
    })

    it('rejects V1 access tokens, then migrates them with a refresh', async () => {
      const { auth, store } = authWith({
        clients: { allowed: ['backoffice'] },
      })
      // V1 token: typ JWT, empty issuer, client in `aud`.
      const v1Token = jwt.sign(
        {
          sub: 'u1',
          username: 'ada',
          auth_time: 1700000000,
          aud: 'backoffice',
        },
        keys.privateKey,
        { algorithm: 'RS256', issuer: '', expiresIn: 3600, jwtid: 'v1-jti' }
      )
      const refresh = await newRefreshToken()
      await store.provider.storeRefreshToken({
        ...refresh,
        userId: 'u1',
        accessTokenId: 'v1-jti',
        sessionId: 'v1-family',
        expiresAt: new Date(Date.now() + 60_000),
      })

      await expect(auth.verifyAccessToken(v1Token)).rejects.toMatchObject({
        code: 'INVALID_ACCESS_TOKEN',
      })

      const migrated = await auth.refreshTokens({
        accessToken: v1Token,
        refreshToken: refresh.token,
      })

      expect(decodeProtectedHeader(migrated.accessToken).typ).toBe('at+jwt')
      expect(decodeJwt(migrated.accessToken)).toMatchObject({
        iss: 'https://api.example.com',
        aud: 'https://api.example.com',
        client_id: 'backoffice',
        auth_time: 1700000000,
      })
      await expect(
        auth.verifyAccessToken(migrated.accessToken)
      ).resolves.toMatchObject({ userId: 'u1', clientId: 'backoffice' })
    })

    it('issues tokens that V1 (jsonwebtoken) accepts', async () => {
      const { auth } = authWith()
      const { accessToken } = await issueAccessToken(auth, {
        userId: 'u1',
        username: 'ada',
      })

      expect(jwt.verify(accessToken, keys.publicKey)).toMatchObject({
        sub: 'u1',
      })
    })
  })

  describe('refresh tokens', () => {
    it('generates 128 random bytes, and stores their SHA-256 hash only', async () => {
      const store = createStore()
      const storeRefreshToken = vi.spyOn(store.provider, 'storeRefreshToken')
      const auth = createAuth({
        keys,
        dataProvider: store.provider,
        issuer: 'https://api.example.com',
      })
      const { refreshToken } = await auth.generateTokensForUser({
        userId: 'u1',
      })

      expect(refreshToken).toMatch(/^[0-9a-f]{256}$/)
      const { createHash } = await import('node:crypto')
      const [stored] = storeRefreshToken.mock.calls[0]!
      expect(Object.keys(stored).sort()).toEqual([
        'accessTokenId',
        'expiresAt',
        'sessionId',
        'tokenHash',
        'userId',
      ])
      expect(stored.tokenHash).toBe(
        createHash('sha256').update(refreshToken).digest('hex')
      )
    })

    it('rotates a token pair, keeping the original claims', async () => {
      const { auth, store } = authWith({
        clients: { allowed: ['backoffice'] },
        usernameClaim: true,
      })
      const pair = await auth.generateTokensForUser({
        userId: 'u1',
        username: 'ada',
        clientId: 'backoffice',
      })
      const original = decodeJwt(pair.accessToken)

      const rotated = await auth.refreshTokens(pair)

      expect(rotated.userId).toBe('u1')
      expect(rotated.refreshToken).not.toBe(pair.refreshToken)
      expect(decodeJwt(rotated.accessToken)).toMatchObject({
        sub: 'u1',
        username: 'ada',
        client_id: 'backoffice',
        auth_time: original.auth_time,
      })
      expect([...store.refreshTokens.values()].map((t) => t.isUsed)).toEqual([
        true,
        false,
      ])
    })

    it('ends the sessions of a client removed from the configuration', async () => {
      const { auth, store } = authWith({
        clients: { allowed: ['app', 'kiosk'] },
      })
      const pair = await auth.generateTokensForUser({
        userId: 'u1',
        username: 'ada',
        clientId: 'kiosk',
      })
      const updated = createAuth({
        keys,
        dataProvider: store.provider,
        issuer: 'https://api.example.com',
        passwordHashRounds: TEST_HASH_ROUNDS,
        clients: { allowed: ['app'] },
      })

      await expect(updated.refreshTokens(pair)).rejects.toMatchObject({
        code: 'INVALID_REFRESH_TOKEN',
      })
    })

    it('accepts expired access tokens', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const { auth } = authWith({ accessTokenTTL: 1 })
      const pair = await auth.generateTokensForUser({
        userId: 'u1',
        username: 'ada',
      })
      vi.setSystemTime(Date.now() + 5000)

      await expect(auth.verifyAccessToken(pair.accessToken)).rejects.toThrow()
      await expect(auth.refreshTokens(pair)).resolves.toMatchObject({
        userId: 'u1',
      })
    })

    it.each([
      [
        'revoked',
        (data: { revokedAt?: Date | null }) => (data.revokedAt = new Date()),
      ],
      [
        'of another token',
        (data: { accessTokenId: string }) => (data.accessTokenId = 'other'),
      ],
      ['of another user', (data: { userId: string }) => (data.userId = 'u2')],
    ])('rejects refresh tokens %s', async (_label, alter) => {
      const { auth, store } = authWith()
      const pair = await auth.generateTokensForUser({
        userId: 'u1',
        username: 'ada',
      })
      alter([...store.refreshTokens.values()][0] as never)

      await expect(auth.refreshTokens(pair)).rejects.toMatchObject({
        code: 'INVALID_REFRESH_TOKEN',
      })
    })

    it('rejects invalid reuse intervals', () => {
      expect(() => authWith({ refreshTokenReuseInterval: -1 })).toThrow(
        'refreshTokenReuseInterval must be a number of seconds'
      )
    })

    describe('reuse detection', () => {
      const subject = { userId: 'u1', username: 'ada' }
      const storedOf = (store: ReturnType<typeof createStore>, index: number) =>
        [...store.refreshTokens.values()][index]!

      it('keeps the session family across rotations', async () => {
        const { auth, store } = authWith()
        const pair = await auth.generateTokensForUser(subject)
        await auth.refreshTokens(pair)

        const [first, second] = [storedOf(store, 0), storedOf(store, 1)]
        expect(first.sessionId).toEqual(expect.any(String))
        expect(second.sessionId).toBe(first.sessionId)
        expect(first.usedAt).toBeInstanceOf(Date)
      })

      it('revokes the session when a used refresh token is presented again', async () => {
        const onRefreshTokenReuse = vi.fn(async () => {})
        const { auth, store } = authWith({
          refreshTokenReuseInterval: 0,
          onRefreshTokenReuse,
        })
        const stolen = await auth.generateTokensForUser(subject)
        // The attacker (or the client) rotates first…
        const rotated = await auth.refreshTokens(stolen)

        // …then the other one presents the used token.
        await expect(auth.refreshTokens(stolen)).rejects.toMatchObject({
          code: 'REFRESH_TOKEN_REUSED',
        })

        // The whole session is revoked: the rotated token is unusable.
        await expect(auth.refreshTokens(rotated)).rejects.toMatchObject({
          code: 'INVALID_REFRESH_TOKEN',
        })
        expect(onRefreshTokenReuse).toHaveBeenCalledWith({
          userId: 'u1',
          sessionId: storedOf(store, 0).sessionId,
          accessTokenId: storedOf(store, 0).accessTokenId,
        })
      })

      it('only revokes the reused session', async () => {
        const { auth } = authWith({ refreshTokenReuseInterval: 0 })
        const laptop = await auth.generateTokensForUser(subject)
        const phone = await auth.generateTokensForUser(subject)

        await auth.refreshTokens(laptop)
        await expect(auth.refreshTokens(laptop)).rejects.toMatchObject({
          code: 'REFRESH_TOKEN_REUSED',
        })

        await expect(auth.refreshTokens(phone)).resolves.toMatchObject({
          userId: 'u1',
        })
      })

      it('issues a new pair in the same session within the reuse interval', async () => {
        const onRefreshTokenReuse = vi.fn(async () => {})
        const { auth, store } = authWith({ onRefreshTokenReuse })
        const pair = await auth.generateTokensForUser(subject)
        const rotated = await auth.refreshTokens(pair)
        const firstUse = storedOf(store, 0).usedAt

        // A second tab, or a retry after a lost response, presents the same
        // token just after: it gets its own pair, in the same session.
        const retried = await auth.refreshTokens(pair)

        expect(retried.refreshToken).not.toBe(rotated.refreshToken)
        expect(storedOf(store, 2).sessionId).toBe(storedOf(store, 0).sessionId)
        // The interval stays counted from the first use.
        expect(storedOf(store, 0).usedAt).toBe(firstUse)
        await expect(auth.refreshTokens(rotated)).resolves.toMatchObject({
          userId: 'u1',
        })
        await expect(auth.refreshTokens(retried)).resolves.toMatchObject({
          userId: 'u1',
        })
        expect(onRefreshTokenReuse).not.toHaveBeenCalled()
      })

      it('revokes the pairs issued within the interval on a later reuse', async () => {
        const { auth, store } = authWith()
        const pair = await auth.generateTokensForUser(subject)
        const rotated = await auth.refreshTokens(pair)
        const retried = await auth.refreshTokens(pair)
        storedOf(store, 0).usedAt = new Date(Date.now() - 11_000)

        await expect(auth.refreshTokens(pair)).rejects.toMatchObject({
          code: 'REFRESH_TOKEN_REUSED',
        })
        for (const tokens of [rotated, retried]) {
          await expect(auth.refreshTokens(tokens)).rejects.toMatchObject({
            code: 'INVALID_REFRESH_TOKEN',
          })
        }
      })

      it('revokes the session after the reuse interval', async () => {
        const { auth, store } = authWith({ refreshTokenReuseInterval: 10 })
        const pair = await auth.generateTokensForUser(subject)
        const rotated = await auth.refreshTokens(pair)
        storedOf(store, 0).usedAt = new Date(Date.now() - 11_000)

        await expect(auth.refreshTokens(pair)).rejects.toMatchObject({
          code: 'REFRESH_TOKEN_REUSED',
        })
        await expect(auth.refreshTokens(rotated)).rejects.toMatchObject({
          code: 'INVALID_REFRESH_TOKEN',
        })
      })

      it('revokes every session of the user for tokens stored without family', async () => {
        const { auth, store } = authWith()
        const legacy = await auth.generateTokensForUser(subject)
        const other = await auth.generateTokensForUser(subject)
        // Token stored before families existed, already used.
        Object.assign(storedOf(store, 0), {
          sessionId: null,
          isUsed: true,
          usedAt: null,
        })

        await expect(auth.refreshTokens(legacy)).rejects.toMatchObject({
          code: 'REFRESH_TOKEN_REUSED',
        })
        await expect(auth.refreshTokens(other)).rejects.toMatchObject({
          code: 'INVALID_REFRESH_TOKEN',
        })
      })

      it('starts a family when rotating a token stored without one', async () => {
        const { auth, store } = authWith()
        const legacy = await auth.generateTokensForUser(subject)
        storedOf(store, 0).sessionId = null

        await auth.refreshTokens(legacy)
        await auth.refreshTokens(legacy)

        // Both pairs issued from the legacy token share the new family.
        expect(storedOf(store, 1).sessionId).toEqual(expect.any(String))
        expect(storedOf(store, 2).sessionId).toBe(storedOf(store, 1).sessionId)
      })

      it('revokes the session even when the reuse hook fails', async () => {
        const { auth } = authWith({
          refreshTokenReuseInterval: 0,
          onRefreshTokenReuse: async () => {
            throw new Error('Alerting down')
          },
        })
        const pair = await auth.generateTokensForUser(subject)
        const rotated = await auth.refreshTokens(pair)

        await expect(auth.refreshTokens(pair)).rejects.toMatchObject({
          code: 'REFRESH_TOKEN_REUSED',
        })
        await expect(auth.refreshTokens(rotated)).rejects.toMatchObject({
          code: 'INVALID_REFRESH_TOKEN',
        })
      })
    })

    it('rejects expired refresh tokens', async () => {
      const { auth, store } = authWith()
      const pair = await auth.generateTokensForUser({
        userId: 'u1',
        username: 'ada',
      })
      ;[...store.refreshTokens.values()][0]!.expiresAt = new Date(0)

      await expect(auth.refreshTokens(pair)).rejects.toMatchObject({
        code: 'EXPIRED_REFRESH_TOKEN',
      })
    })

    it('rejects access tokens signed with another key', async () => {
      const { auth } = authWith()
      const other = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      })
      const pair = await auth.generateTokensForUser({
        userId: 'u1',
        username: 'ada',
      })
      const forged = jwt.sign({ sub: 'u1' }, other.privateKey, {
        algorithm: 'RS256',
      })

      await expect(
        auth.refreshTokens({ ...pair, accessToken: forged })
      ).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' })
    })
  })

  describe('sessions', () => {
    const subject = { userId: 'u1', username: 'ada' }
    let now = Date.UTC(2026, 0, 1)
    const advance = (seconds: number) => {
      now += seconds * 1000
      vi.setSystemTime(now)
    }

    beforeEach(() => {
      now = Date.UTC(2026, 0, 1)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(now)
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('keeps active sessions forever without absolute timeout', async () => {
      const { auth } = authWith()
      let tokens: TokenPair = await auth.generateTokensForUser(subject)

      // Active every 13 days during a year.
      for (let day = 0; day < 365; day += 13) {
        advance(13 * DAY)
        const refreshed = await auth.refreshTokens(tokens)
        expect(refreshed.sessionExpiresAt).toBeUndefined()
        expect(refreshed.refreshTokenExpiresAt.getTime()).toBe(
          now + 14 * DAY * 1000
        )
        tokens = refreshed
      }
    })

    it('ends inactive sessions after the idle timeout', async () => {
      const { auth } = authWith({ session: { idleTimeout: 7 * DAY } })
      const tokens = await auth.generateTokensForUser(subject)

      advance(7 * DAY + 1)

      await expect(auth.refreshTokens(tokens)).rejects.toMatchObject({
        code: 'EXPIRED_REFRESH_TOKEN',
      })
    })

    it('ends sessions at the absolute timeout, even when active', async () => {
      const { auth } = authWith({
        accessTokenTTL: HOUR,
        session: { idleTimeout: 12 * HOUR, absoluteTimeout: DAY },
      })
      const start = now
      const end = start + DAY * 1000
      const first = await auth.generateTokensForUser(subject)
      expect(first.sessionExpiresAt?.getTime()).toBe(end)

      advance(11 * HOUR)
      const second = await auth.refreshTokens(first)
      advance(11 * HOUR)
      const third = await auth.refreshTokens(second)

      // Everything is bounded by the end of the session.
      expect(third.sessionExpiresAt?.getTime()).toBe(end)
      expect(third.refreshTokenExpiresAt.getTime()).toBe(end)
      expect(third.accessTokenExpiresAt.getTime()).toBe(now + HOUR * 1000)
      // At 23h30, an access token of one hour would outlive the session.
      advance(90 * 60)
      const fourth = await auth.refreshTokens(third)
      expect(fourth.accessTokenExpiresAt.getTime()).toBe(end)
      expect(decodeJwt(fourth.accessToken).exp).toBe(end / 1000)

      advance(HOUR)
      await expect(auth.refreshTokens(fourth)).rejects.toMatchObject({
        code: 'EXPIRED_REFRESH_TOKEN',
      })
    })

    it('ends the sessions opened before an absolute timeout was configured', async () => {
      const { auth, store } = authWith()
      const tokens = await auth.generateTokensForUser(subject)
      // Configuration change: the stored refresh token is not bounded.
      const bounded = createAuth({
        keys,
        dataProvider: store.provider,
        issuer: 'https://api.example.com',
        passwordHashRounds: TEST_HASH_ROUNDS,
        session: { absoluteTimeout: DAY },
      })

      advance(DAY + 1)

      await expect(bounded.refreshTokens(tokens)).rejects.toMatchObject({
        code: 'EXPIRED_REFRESH_TOKEN',
      })
    })

    it('applies the session lifetimes of the client', async () => {
      const { auth } = authWith({
        session: { absoluteTimeout: DAY },
        clients: {
          allowed: ['app', 'backoffice'],
          sessions: {
            backoffice: { idleTimeout: HOUR },
            // Explicitly removes the global absolute timeout.
            app: { absoluteTimeout: undefined },
          },
        },
      })
      let app: TokenPair = await auth.generateTokensForUser({
        ...subject,
        clientId: 'app',
      })
      const backoffice = await auth.generateTokensForUser({
        ...subject,
        clientId: 'backoffice',
      })
      expect(backoffice.refreshTokenExpiresAt.getTime()).toBe(now + HOUR * 1000)
      expect(backoffice.sessionExpiresAt?.getTime()).toBe(now + DAY * 1000)

      for (let index = 0; index < 3; index++) {
        advance(DAY)
        app = await auth.refreshTokens(app)
      }

      advance(-3 * DAY + HOUR + 1)
      await expect(auth.refreshTokens(backoffice)).rejects.toMatchObject({
        code: 'EXPIRED_REFRESH_TOKEN',
      })
    })

    it('ends sessions without auth_time when an absolute timeout applies', async () => {
      const legacySession = async (settings: Partial<AuthOptions>) => {
        const { auth, store } = authWith(settings)
        const accessToken = jwt.sign({ sub: 'u1' }, keys.privateKey, {
          algorithm: 'RS256',
          jwtid: 'old-jti',
        })
        const refresh = await newRefreshToken()
        await store.provider.storeRefreshToken({
          ...refresh,
          userId: 'u1',
          accessTokenId: 'old-jti',
          sessionId: 'old',
          expiresAt: new Date(now + DAY * 1000),
        })
        return auth.refreshTokens({
          accessToken,
          refreshToken: refresh.token,
        })
      }

      await expect(
        legacySession({ session: { absoluteTimeout: DAY } })
      ).rejects.toMatchObject({ code: 'EXPIRED_REFRESH_TOKEN' })
      await expect(legacySession({})).resolves.toMatchObject({ userId: 'u1' })
    })

    it('computes the end of a session from its access token', async () => {
      const { auth } = authWith({ session: { absoluteTimeout: DAY } })
      const { accessToken } = await auth.generateTokensForUser(subject)

      const session = await auth.verifyAccessToken(accessToken)

      expect(auth.getSessionExpiresAt(session)?.getTime()).toBe(
        now + DAY * 1000
      )
      expect(authWith().auth.getSessionExpiresAt(session)).toBeUndefined()
    })

    it.each([
      [{ session: { idleTimeout: 0 } }, 'Invalid session.idleTimeout'],
      [
        { session: { absoluteTimeout: -1 } },
        'session.absoluteTimeout must be a number of seconds',
      ],
      [
        {
          clients: {
            allowed: ['app'],
            sessions: { app: { idleTimeout: Number.NaN } },
          },
        },
        'clients.sessions.app.idleTimeout must be a number of seconds',
      ],
      [
        { clients: { allowed: ['app'], sessions: { kiosk: {} } } },
        '"kiosk" is not in clients.allowed',
      ],
      [{ refreshTokenTTLInDays: 14 }, 'replaced by session.idleTimeout'],
    ])('rejects invalid session settings (%o)', (settings, message) => {
      expect(() => authWith(settings as Partial<AuthOptions>)).toThrow(message)
    })
  })

  describe('revocation', () => {
    const subject = { userId: 'u1', username: 'ada' }

    it('revokes every session of a user with revokeUserSessions()', async () => {
      const { auth } = authWith()
      const first = await auth.generateTokensForUser(subject)
      const second = await auth.generateTokensForUser(subject)
      const other = await auth.generateTokensForUser({
        userId: 'u2',
        username: 'linus',
      })

      await auth.revokeUserSessions('u1')

      for (const pair of [first, second]) {
        await expect(auth.refreshTokens(pair)).rejects.toMatchObject({
          code: 'INVALID_REFRESH_TOKEN',
        })
      }
      await expect(auth.refreshTokens(other)).resolves.toMatchObject({
        userId: 'u2',
      })
      await expect(auth.revokeUserSessions('')).rejects.toThrow(
        'revokeUserSessions() requires a userId.'
      )
    })

    it('ends the session of a deleted or disabled user at refresh', async () => {
      const { auth, store } = authWith()
      const first = await auth.generateTokensForUser(subject)
      const second = await auth.generateTokensForUser(subject)
      expect((await auth.refreshTokens(first)).user).toEqual({
        id: 'u1',
        username: 'ada',
        roles: ['admin'],
      })
      const third = await auth.generateTokensForUser(subject)

      store.users.delete('u1')

      await expect(auth.refreshTokens(third)).rejects.toMatchObject({
        code: 'INVALID_REFRESH_TOKEN',
      })
      const sid = decodeJwt(third.accessToken).sid
      const tokens = [...store.refreshTokens.values()]
      // Only this session is revoked; the others end at their refresh.
      expect(
        tokens.filter((token) => token.revokedAt).map((t) => t.sessionId)
      ).toEqual([sid])
      store.users.set('u1', {
        id: 'u1',
        username: 'ada',
        role: 'admin',
        roles: ['admin'],
        passwordHash: null,
      })
      await expect(auth.refreshTokens(third)).rejects.toMatchObject({
        code: 'INVALID_REFRESH_TOKEN',
      })
      await expect(auth.refreshTokens(second)).resolves.toBeDefined()
    })

    it('revokes every session of a deleted user for tokens without family', async () => {
      const { auth, store } = authWith()
      const first = await auth.generateTokensForUser(subject)
      await auth.generateTokensForUser(subject)
      for (const token of store.refreshTokens.values()) token.sessionId = null
      store.users.delete('u1')

      await expect(auth.refreshTokens(first)).rejects.toMatchObject({
        code: 'INVALID_REFRESH_TOKEN',
      })
      expect(
        [...store.refreshTokens.values()].every((token) => token.revokedAt)
      ).toBe(true)
    })

    it('rejects the access tokens of revoked sessions with isSessionRevoked', async () => {
      const store = createStore({ sessionRevocation: true })
      const isSessionRevoked = vi.spyOn(store.provider, 'isSessionRevoked')
      const auth = createAuth({
        keys,
        dataProvider: store.provider,
        issuer: 'https://api.example.com',
      })
      const first = await auth.generateTokensForUser(subject)
      const second = await auth.generateTokensForUser(subject)
      const sid = decodeJwt(first.accessToken).sid

      await expect(
        auth.verifyAccessToken(first.accessToken)
      ).resolves.toMatchObject({ sessionId: sid })
      await auth.revokeSession(first.refreshToken)

      await expect(
        auth.verifyAccessToken(first.accessToken)
      ).rejects.toMatchObject({ code: 'SESSION_REVOKED' })
      await expect(
        auth.verifyAccessToken(second.accessToken)
      ).resolves.toBeDefined()
      expect(isSessionRevoked).toHaveBeenLastCalledWith(
        decodeJwt(second.accessToken).sid
      )
    })

    it('calls isSessionRevoked on the data provider', async () => {
      const revoked = new Set<string>()
      const provider = {
        ...createStore().provider,
        revoked,
        async isSessionRevoked(this: { revoked: Set<string> }, sid: string) {
          return this.revoked.has(sid)
        },
      }
      const auth = createAuth({
        keys,
        dataProvider: provider,
        issuer: 'https://api.example.com',
      })
      const { accessToken } = await auth.generateTokensForUser(subject)
      revoked.add(String(decodeJwt(accessToken).sid))

      await expect(auth.verifyAccessToken(accessToken)).rejects.toMatchObject({
        code: 'SESSION_REVOKED',
      })
    })

    it('fails closed when isSessionRevoked throws', async () => {
      const provider = {
        ...createStore().provider,
        isSessionRevoked: async () => {
          throw new Error('Database unavailable')
        },
      }
      const auth = createAuth({
        keys,
        dataProvider: provider,
        issuer: 'https://api.example.com',
      })
      const { accessToken } = await auth.generateTokensForUser(subject)

      await expect(auth.verifyAccessToken(accessToken)).rejects.toMatchObject({
        code: 'INVALID_ACCESS_TOKEN',
      })
    })

    it('keeps the access tokens of revoked sessions until expiry without isSessionRevoked', async () => {
      const { auth } = authWith()
      const pair = await auth.generateTokensForUser(subject)
      await auth.revokeSession(pair.refreshToken)

      await expect(
        auth.verifyAccessToken(pair.accessToken)
      ).resolves.toBeDefined()
    })
  })

  describe('logout', () => {
    const subject = { userId: 'u1', username: 'ada' }
    const hashOf = async (token: string) => {
      const { createHash } = await import('node:crypto')
      return createHash('sha256').update(token).digest('hex')
    }
    const twoSessions = async () => {
      const context = authWith()
      const first = await context.auth.generateTokensForUser(subject)
      const second = await context.auth.generateTokensForUser(subject)
      return { ...context, first, second }
    }

    it('identifies the session with a sid claim, kept across rotations', async () => {
      const { auth, store, first, second } = await twoSessions()
      const { sid } = decodeJwt(first.accessToken)

      expect(sid).toEqual(expect.any(String))
      expect(decodeJwt(second.accessToken).sid).not.toBe(sid)
      expect(
        store.refreshTokens.get(await hashOf(first.refreshToken))?.sessionId
      ).toBe(sid)

      const rotated = await auth.refreshTokens(first)
      expect(decodeJwt(rotated.accessToken).sid).toBe(sid)
      expect(
        (await auth.verifyAccessToken(rotated.accessToken)).sessionId
      ).toBe(sid)
    })

    it('rejects access tokens without session', async () => {
      const { auth } = authWith()
      const withoutSession = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt' })
        .setSubject('u1')
        .setIssuer('https://api.example.com')
        .setAudience('https://api.example.com')
        .setJti('jti')
        .setIssuedAt()
        .setExpirationTime('1m')
        .sign(await importPKCS8(keys.privateKey, 'RS256'))

      await expect(
        auth.verifyAccessToken(withoutSession)
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_TOKEN' })
    })

    it('revokes the session of a refresh token only', async () => {
      const { auth, first, second } = await twoSessions()

      expect(await auth.revokeSession(first.refreshToken)).toEqual({
        userId: 'u1',
        sessionId: decodeJwt(first.accessToken).sid,
      })
      await expect(auth.refreshTokens(first)).rejects.toMatchObject({
        code: 'INVALID_REFRESH_TOKEN',
      })
      await expect(auth.refreshTokens(second)).resolves.toBeDefined()
    })

    it('revokes the session of a used, revoked or expired token', async () => {
      const { auth, store, first } = await twoSessions()
      const rotated = await auth.refreshTokens(first)
      const stored = store.refreshTokens.get(await hashOf(first.refreshToken))!
      stored.expiresAt = new Date(Date.now() - 1000)
      stored.revokedAt = new Date()

      expect(await auth.revokeSession(first.refreshToken)).toBeDefined()
      await expect(auth.refreshTokens(rotated)).rejects.toMatchObject({
        code: 'INVALID_REFRESH_TOKEN',
      })
    })

    it('revokes every session with scope all', async () => {
      const { auth, first, second } = await twoSessions()

      expect(
        await auth.revokeSession(first.refreshToken, { scope: 'all' })
      ).toEqual({ userId: 'u1', sessionId: decodeJwt(first.accessToken).sid })
      for (const pair of [first, second]) {
        await expect(auth.refreshTokens(pair)).rejects.toMatchObject({
          code: 'INVALID_REFRESH_TOKEN',
        })
      }
    })

    it.each([
      ['used', { isUsed: true, usedAt: new Date() }],
      ['revoked', { revokedAt: new Date() }],
      ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ])(
      'requires an active token for scope all (%s)',
      async (_label, change) => {
        const { auth, store, first, second } = await twoSessions()
        Object.assign(
          store.refreshTokens.get(await hashOf(first.refreshToken))!,
          change
        )

        expect(
          await auth.revokeSession(first.refreshToken, { scope: 'all' })
        ).toBeUndefined()
        await expect(auth.refreshTokens(second)).resolves.toBeDefined()
      }
    )

    it('ignores unknown tokens', async () => {
      const { auth, store } = await twoSessions()

      for (const scope of ['current', 'all'] as const) {
        expect(await auth.revokeSession('unknown', { scope })).toBeUndefined()
      }
      expect(
        [...store.refreshTokens.values()].some((token) => token.revokedAt)
      ).toBe(false)
    })

    it('revokes every session for tokens stored without family', async () => {
      const { auth, store, first, second } = await twoSessions()
      store.refreshTokens.get(await hashOf(first.refreshToken))!.sessionId =
        null

      expect(await auth.revokeSession(first.refreshToken)).toEqual({
        userId: 'u1',
        sessionId: undefined,
      })
      await expect(auth.refreshTokens(second)).rejects.toMatchObject({
        code: 'INVALID_REFRESH_TOKEN',
      })
    })
  })

  describe('passwords', () => {
    it('checks the options of generatePasswordHash()', async () => {
      await expect(
        generatePasswordHash('secret', { cost: 4 } as never)
      ).rejects.toThrow(
        new TypeError('generatePasswordHash(): unknown option "cost".')
      )
      await expect(
        generatePasswordHash('secret', { rounds: 3 })
      ).rejects.toThrow(
        new RangeError(
          'generatePasswordHash(): rounds must be an integer between 4 and 31.'
        )
      )
    })

    it('hashes and verifies passwords with bcrypt', async () => {
      const { auth } = authWith()
      const hash = await generatePasswordHash('secret', { rounds: 4 })

      expect(hash).toMatch(/^\$2[aby]\$04\$/)
      await expect(auth.verifyPassword('secret', hash)).resolves.toBe(true)
      await expect(auth.verifyPassword('wrong', hash)).resolves.toBe(false)
      await expect(auth.hashPassword('secret')).resolves.toMatch(/^\$2/)
    })

    it('uses a cost of 12 by default', async () => {
      const store = createStore()
      const auth = createAuth({
        keys,
        dataProvider: store.provider,
        issuer: 'https://api.example.com',
      })

      expect(settingsOf(auth).passwordHashRounds).toBe(12)
      expect(await generatePasswordHash('secret')).toMatch(/^\$2[aby]\$12\$/)
    })

    it('rejects passwords longer than 72 bytes instead of truncating them', async () => {
      const { auth } = authWith()
      const ascii = 'a'.repeat(72)
      // 37 characters, 74 bytes in UTF-8.
      const accented = 'é'.repeat(37)

      expect(isPasswordTooLong(ascii)).toBe(false)
      expect(isPasswordTooLong(`${ascii}a`)).toBe(true)
      expect(isPasswordTooLong(accented)).toBe(true)
      await expect(auth.hashPassword(ascii)).resolves.toMatch(/^\$2/)
      for (const password of [`${ascii}a`, accented]) {
        await expect(auth.hashPassword(password)).rejects.toThrow(RangeError)
        await expect(
          generatePasswordHash(password, { rounds: 4 })
        ).rejects.toThrow('Password too long')
      }
    })

    it('detects hashes with another cost, and rehashes verified passwords', async () => {
      const { auth } = authWith({ passwordHashRounds: 5 })
      const long = 'a'.repeat(80)
      const hash = await auth.rehashPassword(long)

      expect(hash).toMatch(/^\$2[aby]\$05\$/)
      await expect(auth.verifyPassword(long, hash)).resolves.toBe(true)
      expect(auth.passwordNeedsRehash(hash)).toBe(false)
      expect(
        auth.passwordNeedsRehash(await generatePasswordHash('x', { rounds: 4 }))
      ).toBe(true)
      expect(auth.passwordNeedsRehash('not-a-bcrypt-hash')).toBe(false)
    })

    it('hashes with passwordHashRounds by default', async () => {
      const { auth } = authWith({ passwordHashRounds: 5 })
      await expect(auth.hashPassword('secret')).resolves.toMatch(
        /^\$2[aby]\$05\$/
      )
    })

    it.each([3, 32, 10.5, Number.NaN])(
      'rejects an invalid passwordHashRounds (%s)',
      (passwordHashRounds) => {
        expect(() => authWith({ passwordHashRounds })).toThrow(
          'Invalid passwordHashRounds'
        )
      }
    )

    it.each([null, undefined, '', 'not-a-bcrypt-hash'])(
      'rejects passwords without valid hash (%o), against a dummy hash',
      async (passwordHash) => {
        const { auth } = authWith()
        await expect(auth.verifyPassword('secret', passwordHash)).resolves.toBe(
          false
        )
      }
    )

    it('takes as long without valid hash as with a wrong password', async () => {
      // Higher cost than the other tests, so that the bcrypt time dominates
      // the measure (around 15 ms).
      const rounds = 8
      const { auth } = authWith({ passwordHashRounds: rounds })
      const hash = await generatePasswordHash('secret', { rounds })
      await initAuth(auth)

      const checks = {
        wrongPassword: () => auth.verifyPassword('wrong', hash),
        withoutHash: () => auth.verifyPassword('wrong', null),
      }
      const durations = {
        wrongPassword: [] as number[],
        withoutHash: [] as number[],
      }
      // Warm-up, then both checks in turn: a slower moment of the machine
      // (CI runners, tests running in parallel) slows both of them.
      await checks.wrongPassword()
      await checks.withoutHash()
      for (let index = 0; index < 7; index++) {
        for (const name of ['wrongPassword', 'withoutHash'] as const) {
          const start = performance.now()
          await checks[name]()
          durations[name].push(performance.now() - start)
        }
      }
      const median = (values: number[]) => values.sort((a, b) => a - b)[3]!

      // Without dummy hash, about 50 times less: a third leaves room for the
      // noise of the measure.
      expect(median(durations.withoutHash)).toBeGreaterThan(
        median(durations.wrongPassword) / 3
      )
    })
  })
})
