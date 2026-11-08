import { generateKeyPairSync } from 'node:crypto'
import { decodeJwt, decodeProtectedHeader } from 'jose'
import jwt from 'jsonwebtoken'
import { describe, expect, it } from 'vitest'
import {
  AuthError,
  createAuth,
  generatePasswordHash,
  type AuthSettings,
} from '../src/index.js'
import { createStore, keys } from './support.js'

const authWith = (settings: Partial<AuthSettings> = {}) => {
  const store = createStore()
  const auth = createAuth({
    keys,
    dataProvider: store.provider,
    issuer: 'https://api.example.com',
    ...settings,
  })
  return { auth, store }
}

describe('createAuth()', () => {
  it('requires keys and a data provider', () => {
    expect(() =>
      createAuth({ dataProvider: createStore().provider } as AuthSettings)
    ).toThrow('requires keys.secretKey and keys.publicKey')
    expect(() => createAuth({ keys } as AuthSettings)).toThrow(
      'requires a dataProvider'
    )
  })

  it('applies the V1 defaults, with secure cookies', () => {
    const { auth } = authWith({ issuer: undefined })

    expect(auth.settings).toMatchObject({
      accessTokenTTL: 3600,
      refreshTokenTTLInDays: 14,
      issuer: '',
      cookies: {
        enabled: false,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        accessTokenName: 'dotpress_access_token',
        refreshTokenName: 'dotpress_refresh_token',
        accessTokenInCookie: false,
      },
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
        authWith({
          keys: { secretKey: pkcs1.privateKey, publicKey: keys.publicKey },
        }).auth.init()
      ).rejects.toThrow('openssl pkcs8 -topk8 -nocrypt')
      await expect(
        authWith({
          keys: { secretKey: keys.secretKey, publicKey: pkcs1.publicKey },
        }).auth.init()
      ).rejects.toThrow('openssl rsa -RSAPublicKey_in')
    })

    it('rejects invalid keys, and retries on the next call', async () => {
      const { auth } = authWith({
        keys: { secretKey: 'not a key', publicKey: keys.publicKey },
      })

      await expect(auth.init()).rejects.toThrow('Invalid auth secretKey')
      await expect(auth.init()).rejects.toThrow('Invalid auth secretKey')
    })
  })

  describe('access tokens', () => {
    it('signs RS256 tokens with the V1 claims', async () => {
      const { auth } = authWith({ accessTokenTTL: 900 })
      const before = Math.floor(Date.now() / 1000)

      const { jwtId, accessToken } = await auth.generateAccessToken({
        userId: 'u1',
        username: 'ada',
        aud: 'backoffice',
      })

      expect(decodeProtectedHeader(accessToken)).toEqual({
        alg: 'RS256',
        typ: 'JWT',
      })
      const claims = decodeJwt(accessToken)
      expect(claims).toMatchObject({
        sub: 'u1',
        username: 'ada',
        aud: 'backoffice',
        iss: 'https://api.example.com',
        jti: jwtId,
      })
      expect(claims.auth_time).toBeGreaterThanOrEqual(before)
      expect(claims.exp! - claims.iat!).toBe(900)
    })

    it('verifies tokens and rejects tampered or expired ones', async () => {
      const { auth } = authWith()
      const { accessToken } = await auth.generateAccessToken({
        userId: 'u1',
        username: 'ada',
      })

      await expect(auth.verifyAccessToken(accessToken)).resolves.toMatchObject({
        userId: 'u1',
        username: 'ada',
        audience: undefined,
      })

      const [header, , signature] = accessToken.split('.')
      const forged = `${header}.${Buffer.from(
        JSON.stringify({ sub: 'u2' })
      ).toString('base64url')}.${signature}`
      await expect(auth.verifyAccessToken(forged)).rejects.toBeInstanceOf(
        AuthError
      )

      const expired = jwt.sign({ username: 'ada' }, keys.secretKey, {
        algorithm: 'RS256',
        subject: 'u1',
        expiresIn: -10,
      })
      await expect(auth.verifyAccessToken(expired)).rejects.toMatchObject({
        code: 'INVALID_ACCESS_TOKEN',
      })
    })

    it('accepts tokens issued by V1 (jsonwebtoken)', async () => {
      const { auth } = authWith()
      const v1Token = jwt.sign(
        {
          sub: 'u1',
          username: 'ada',
          auth_time: Math.floor(Date.now() / 1000),
        },
        keys.secretKey,
        {
          algorithm: 'RS256',
          issuer: 'https://api.example.com',
          expiresIn: 3600,
          jwtid: 'v1-jti',
        }
      )

      await expect(auth.verifyAccessToken(v1Token)).resolves.toMatchObject({
        userId: 'u1',
        tokenId: 'v1-jti',
      })
    })

    it('issues tokens that V1 (jsonwebtoken) accepts', async () => {
      const { auth } = authWith()
      const { accessToken } = await auth.generateAccessToken({
        userId: 'u1',
        username: 'ada',
      })

      expect(jwt.verify(accessToken, keys.publicKey)).toMatchObject({
        sub: 'u1',
        username: 'ada',
      })
    })
  })

  describe('refresh tokens', () => {
    it('generates 128 random bytes and their SHA-256 hash, like V1', async () => {
      const { auth } = authWith()
      const { token, tokenHash } = await auth.generateRefreshToken()

      expect(token).toMatch(/^[0-9a-f]{256}$/)
      const { createHash } = await import('node:crypto')
      expect(tokenHash).toBe(createHash('sha256').update(token).digest('hex'))
    })

    it('rotates a token pair, keeping the original claims', async () => {
      const { auth, store } = authWith()
      const pair = await auth.generateTokensForUser({
        userId: 'u1',
        username: 'ada',
        aud: 'backoffice',
      })
      const original = decodeJwt(pair.accessToken)

      const rotated = await auth.refreshTokens(pair)

      expect(rotated.userId).toBe('u1')
      expect(rotated.refreshToken).not.toBe(pair.refreshToken)
      expect(decodeJwt(rotated.accessToken)).toMatchObject({
        sub: 'u1',
        username: 'ada',
        aud: 'backoffice',
        auth_time: original.auth_time,
      })
      expect([...store.refreshTokens.values()].map((t) => t.isUsed)).toEqual([
        true,
        false,
      ])
    })

    it('accepts expired access tokens', async () => {
      const { auth } = authWith({ accessTokenTTL: -10 })
      const pair = await auth.generateTokensForUser({
        userId: 'u1',
        username: 'ada',
      })

      await expect(auth.verifyAccessToken(pair.accessToken)).rejects.toThrow()
      await expect(auth.refreshTokens(pair)).resolves.toMatchObject({
        userId: 'u1',
      })
    })

    it.each([
      ['used', (data: { isUsed: boolean }) => (data.isUsed = true)],
      [
        'revoked',
        (data: { revokedAt?: Date | null }) => (data.revokedAt = new Date()),
      ],
      ['of another token', (data: { jwtId: string }) => (data.jwtId = 'other')],
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

  describe('passwords', () => {
    it('hashes and verifies passwords with bcrypt', async () => {
      const { auth } = authWith()
      const hash = await generatePasswordHash('secret', 4)

      expect(hash).toMatch(/^\$2[aby]\$04\$/)
      await expect(auth.verifyPassword('secret', hash)).resolves.toBe(true)
      await expect(auth.verifyPassword('wrong', hash)).resolves.toBe(false)
      await expect(auth.hashPassword('secret', 4)).resolves.toMatch(/^\$2/)
    })
  })
})
