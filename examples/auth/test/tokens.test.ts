import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bearer,
  PASSWORD,
  startApp,
  type TestApi,
  type Tokens,
} from './support.ts'

// Body mode: the tokens are returned in the response body, and the access
// token is sent in the Authorization header. For mobile apps and services.
let api: TestApi

beforeEach(async () => {
  api = await startApp()
})

afterEach(async () => {
  vi.useRealTimers()
  await api.close()
})

/** Moves the clock: tokens expire without waiting. */
const advance = (seconds: number) =>
  vi.setSystemTime(Date.now() + seconds * 1000)

describe('login', () => {
  it('signs up, logs in, and calls the API with the access token', async () => {
    const signUp = await api.post('/users', {
      username: 'Alice',
      password: PASSWORD,
    })
    expect(signUp.status).toBe(201)
    expect(await signUp.json()).toEqual({
      id: expect.any(String),
      username: 'alice',
      role: 'user',
      createdAt: expect.any(String),
    })

    const login = await api.login('alice')
    expect(login.status).toBe(200)
    const tokens = (await login.json()) as Tokens
    expect(tokens).toEqual({
      userId: expect.any(String),
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: 900, // 15 minutes
      expiresAt: expect.any(String),
    })

    const me = await api.request('/auth/me', {
      headers: bearer(tokens.accessToken),
    })
    expect(await me.json()).toEqual({
      id: tokens.userId,
      username: 'alice',
      roles: ['user'],
    })

    const created = await api.post(
      '/notes',
      { text: 'Hello' },
      bearer(tokens.accessToken)
    )
    expect(created.status).toBe(201)
    const note = await created.json()

    const list = await api.request('/notes', {
      headers: bearer(tokens.accessToken),
    })
    expect(await list.json()).toEqual([note])
  })

  it('rejects invalid credentials, without revealing whether the account exists', async () => {
    await api.createUser('alice')

    const wrongPassword = await api.post('/auth/login', {
      username: 'alice',
      password: 'not the password',
    })
    const unknownUser = await api.login('nobody')

    expect(wrongPassword.status).toBe(401)
    const body = await wrongPassword.json()
    expect(body).toMatchObject({
      error: 'UNAUTHORIZED',
      message: 'INVALID_LOGIN',
    })
    expect(await unknownUser.json()).toEqual(body)
  })

  it('limits the failed attempts per username and client', async () => {
    await api.createUser('alice')
    const attempt = () =>
      api.post('/auth/login', { username: 'alice', password: 'guess' })

    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401)

    const blocked = await attempt()
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/)
    // Even with the right password, until the window ends.
    expect((await api.login('alice')).status).toBe(429)
  })
})

describe('guarded routes', () => {
  it('answer 401 with a challenge, without valid access token', async () => {
    const anonymous = await api.request('/notes')
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('www-authenticate')).toBe('Bearer')

    const invalid = await api.request('/notes', { headers: bearer('forged') })
    expect(invalid.status).toBe(401)
    expect(invalid.headers.get('www-authenticate')).toBe(
      'Bearer error="invalid_token"'
    )
  })
})

describe('refresh', () => {
  it('rotates the tokens when the access token expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await api.createUser('alice')
    const tokens = await api.loginTokens('alice')

    advance(15 * 60 + 1)
    const expired = await api.request('/notes', {
      headers: bearer(tokens.accessToken),
    })
    expect(expired.status).toBe(401)
    expect(expired.headers.get('www-authenticate')).toBe(
      'Bearer error="invalid_token"'
    )

    // The expired access token, with its refresh token, gets a new pair.
    const refreshed = await api.post('/auth/refresh', {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    })
    expect(refreshed.status).toBe(200)
    const next = (await refreshed.json()) as Tokens
    expect(next.refreshToken).not.toBe(tokens.refreshToken)

    const notes = await api.request('/notes', {
      headers: bearer(next.accessToken),
    })
    expect(notes.status).toBe(200)
  })

  it('revokes the session when a used refresh token comes back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await api.createUser('alice')
    const first = await api.loginTokens('alice')
    const refresh = (tokens: Tokens) =>
      api.post('/auth/refresh', {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      })

    const second = (await (await refresh(first)).json()) as Tokens

    // Within 10 seconds, a retry (lost response, several tabs) still works.
    expect((await refresh(first)).status).toBe(200)

    // Later, the token was probably stolen: the whole session is revoked.
    advance(11)
    const reused = await refresh(first)
    expect(reused.status).toBe(401)
    expect(await reused.json()).toMatchObject({
      message: 'INVALID_REFRESH_TOKEN',
    })

    expect((await refresh(second)).status).toBe(401)
    // Immediately, thanks to dataProvider.isSessionRevoked().
    const notes = await api.request('/notes', {
      headers: bearer(second.accessToken),
    })
    expect(notes.status).toBe(401)
  })
})

describe('logout', () => {
  it('ends the current session, and keeps the other devices logged in', async () => {
    await api.createUser('alice')
    const phone = await api.loginTokens('alice')
    const laptop = await api.loginTokens('alice')

    const logout = await api.post('/auth/logout', {
      refreshToken: phone.refreshToken,
    })
    expect(logout.status).toBe(200)

    const phoneNotes = await api.request('/notes', {
      headers: bearer(phone.accessToken),
    })
    expect(phoneNotes.status).toBe(401)
    const phoneRefresh = await api.post('/auth/refresh', {
      accessToken: phone.accessToken,
      refreshToken: phone.refreshToken,
    })
    expect(phoneRefresh.status).toBe(401)

    const laptopNotes = await api.request('/notes', {
      headers: bearer(laptop.accessToken),
    })
    expect(laptopNotes.status).toBe(200)
  })

  it('ends every session of the user with scope "all"', async () => {
    await api.createUser('alice')
    const phone = await api.loginTokens('alice')
    const laptop = await api.loginTokens('alice')

    const logout = await api.post('/auth/logout', {
      refreshToken: phone.refreshToken,
      scope: 'all',
    })
    expect(logout.status).toBe(200)

    for (const device of [phone, laptop]) {
      const notes = await api.request('/notes', {
        headers: bearer(device.accessToken),
      })
      expect(notes.status).toBe(401)
    }
  })
})
