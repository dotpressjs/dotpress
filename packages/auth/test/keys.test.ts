import { generateKeyPairSync } from 'node:crypto'
import { createTestApp } from '@dotpress/testing'
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeProtectedHeader,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importSPKI,
  exportJWK,
  jwtVerify,
} from 'jose'
import jwt from 'jsonwebtoken'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authPlugin,
  createAuth,
  type AuthOptions,
  type KeyPairOptions,
} from '../src/index.js'
import {
  createStore,
  initAuth,
  issueAccessToken,
  keys,
  newRefreshToken,
  TEST_HASH_ROUNDS,
} from './support.js'

// Some tests move the clock forward to expire the access tokens.
afterEach(() => {
  vi.useRealTimers()
})

const generatePair = async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  return {
    privateKey: await exportPKCS8(pair.privateKey),
    publicKey: await exportSPKI(pair.publicKey),
  }
}

const oldKeys = keys
const newKeys = await generatePair()

const thumbprintOf = async (publicKey: string) =>
  calculateJwkThumbprint(
    await exportJWK(await importSPKI(publicKey, 'RS256', { extractable: true }))
  )

/** Services sharing one data provider, with their own keys. */
const store = createStore()
const authWith = (
  keyPair: KeyPairOptions,
  settings: Partial<AuthOptions> = {}
) =>
  createAuth({
    keys: keyPair,
    dataProvider: store.provider,
    issuer: 'https://api.example.com',
    passwordHashRounds: TEST_HASH_ROUNDS,
    ...settings,
  })

const subject = { userId: 'u1', username: 'ada' }

describe('key identifiers', () => {
  it('sets the RFC 7638 thumbprint of the key as kid', async () => {
    const { accessToken } = await issueAccessToken(authWith(oldKeys), subject)

    expect(decodeProtectedHeader(accessToken).kid).toBe(
      await thumbprintOf(oldKeys.publicKey)
    )
  })

  it('accepts a custom kid', async () => {
    const auth = authWith({ ...oldKeys, kid: '2026-11' })
    const { accessToken } = await issueAccessToken(auth, subject)

    expect(decodeProtectedHeader(accessToken).kid).toBe('2026-11')
    await expect(auth.verifyAccessToken(accessToken)).resolves.toMatchObject({
      userId: 'u1',
    })
  })

  it('rejects tokens with an unknown kid, or signed by another key', async () => {
    const auth = authWith(oldKeys)
    const kid = await thumbprintOf(oldKeys.publicKey)
    const sign = (privateKey: string, keyid: string) =>
      jwt.sign({ username: 'ada', sid: 's1' }, privateKey, {
        algorithm: 'RS256',
        subject: 'u1',
        issuer: 'https://api.example.com',
        audience: 'https://api.example.com',
        expiresIn: 60,
        keyid,
        header: { alg: 'RS256', typ: 'at+jwt' },
      })

    await expect(
      auth.verifyAccessToken(sign(oldKeys.privateKey, kid))
    ).resolves.toMatchObject({ userId: 'u1' })
    for (const token of [
      sign(oldKeys.privateKey, 'unknown'),
      // Forged with another key, under the kid of the configured key.
      sign(newKeys.privateKey, kid),
    ]) {
      await expect(auth.verifyAccessToken(token)).rejects.toMatchObject({
        code: 'INVALID_ACCESS_TOKEN',
      })
    }
  })
})

describe('key rotation', () => {
  it('verifies and refreshes the tokens of the previous key', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const before = authWith(oldKeys, { accessTokenTTL: 1 })
    const pair = await before.generateTokensForUser(subject)
    vi.setSystemTime(Date.now() + 5000)
    const valid = await issueAccessToken(authWith(oldKeys), subject)

    const after = authWith({
      ...newKeys,
      additionalPublicKeys: [oldKeys.publicKey],
    })

    await expect(
      after.verifyAccessToken(valid.accessToken)
    ).resolves.toMatchObject({ userId: 'u1' })
    // An inactive client refreshes with an expired token of the old key.
    const refreshed = await after.refreshTokens(pair)
    expect(decodeProtectedHeader(refreshed.accessToken).kid).toBe(
      await thumbprintOf(newKeys.publicKey)
    )

    // Once the old key is removed, its tokens are rejected.
    const removed = authWith(newKeys)
    await expect(
      removed.verifyAccessToken(valid.accessToken)
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_TOKEN' })
  })

  it('accepts the next key before the rotation (rolling deployments)', async () => {
    const announced = authWith({
      ...oldKeys,
      additionalPublicKeys: [{ publicKey: newKeys.publicKey }],
    })
    const { accessToken } = await issueAccessToken(authWith(newKeys), subject)

    await expect(
      announced.verifyAccessToken(accessToken)
    ).resolves.toMatchObject({ userId: 'u1' })
  })

  it('tries every key for tokens without kid', async () => {
    const auth = authWith({
      ...newKeys,
      additionalPublicKeys: [oldKeys.publicKey],
    })
    const { refreshToken, accessToken } = await (async () => {
      const refresh = await newRefreshToken()
      await store.provider.storeRefreshToken({
        ...refresh,
        userId: 'u1',
        accessTokenId: 'v1-jti',
        sessionId: 'v1',
        expiresAt: new Date(Date.now() + 60_000),
      })
      // V1 token, signed by the old key, without kid.
      const v1 = jwt.sign({ sub: 'u1', username: 'ada' }, oldKeys.privateKey, {
        algorithm: 'RS256',
        jwtid: 'v1-jti',
      })
      return { refreshToken: refresh.token, accessToken: v1 }
    })()

    await expect(
      auth.refreshTokens({ accessToken, refreshToken })
    ).resolves.toMatchObject({ userId: 'u1' })
  })
})

describe('key validation', () => {
  it('fails at startup when the public key does not match the private key', async () => {
    const auth = authWith({
      privateKey: newKeys.privateKey,
      publicKey: oldKeys.publicKey,
    })

    await expect(initAuth(auth)).rejects.toThrow(
      'publicKey does not match privateKey'
    )
  })

  it('rejects invalid additional keys', async () => {
    const pkcs1 = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    }).publicKey

    await expect(
      initAuth(authWith({ ...oldKeys, additionalPublicKeys: [pkcs1] }))
    ).rejects.toThrow('additionalPublicKeys[0]: PKCS#1 keys')
    await expect(
      initAuth(authWith({ ...oldKeys, additionalPublicKeys: ['garbage'] }))
    ).rejects.toThrow('Invalid auth additionalPublicKeys[0]')
  })

  it('rejects a kid shared by different keys', async () => {
    await expect(
      initAuth(
        authWith({
          ...oldKeys,
          kid: 'main',
          additionalPublicKeys: [{ publicKey: newKeys.publicKey, kid: 'main' }],
        })
      )
    ).rejects.toThrow('kid "main" is used by several keys')
    // The same key listed twice is harmless.
    await expect(
      initAuth(
        authWith({ ...oldKeys, additionalPublicKeys: [oldKeys.publicKey] })
      )
    ).resolves.toBeUndefined()
  })
})

describe('JWKS', () => {
  const rotated = { ...newKeys, additionalPublicKeys: [oldKeys.publicKey] }

  it('publishes the public keys, active key first', async () => {
    const jwks = await authWith(rotated).getJwks()

    expect(jwks.keys).toEqual([
      expect.objectContaining({
        kty: 'RSA',
        kid: await thumbprintOf(newKeys.publicKey),
        alg: 'RS256',
        use: 'sig',
      }),
      expect.objectContaining({ kid: await thumbprintOf(oldKeys.publicKey) }),
    ])
    // Public parts only.
    expect(Object.keys(jwks.keys[0]!).sort()).toEqual(
      ['alg', 'e', 'kid', 'kty', 'n', 'use'].sort()
    )
  })

  it('serves /.well-known/jwks.json when enabled, usable by verifiers', async () => {
    const auth = authWith(rotated)
    const { fetch } = await createTestApp({
      routers: [],
      plugins: [authPlugin(auth, { jwks: true })],
    })

    const res = await fetch('/.well-known/jwks.json')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')

    // Another service verifies the tokens with the published keys.
    const keySet = createLocalJWKSet(await res.json())
    const { accessToken } = await issueAccessToken(auth, subject)
    await expect(jwtVerify(accessToken, keySet)).resolves.toMatchObject({
      payload: { sub: 'u1' },
    })
  })

  it('is not served by default', async () => {
    const { fetch } = await createTestApp({
      routers: [],
      plugins: [authPlugin(authWith(oldKeys))],
    })

    expect((await fetch('/.well-known/jwks.json')).status).toBe(404)
  })
})
