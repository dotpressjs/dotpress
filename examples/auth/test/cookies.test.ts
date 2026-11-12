import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  ACCESS_COOKIE,
  cookieHeader,
  cookiesOf,
  REFRESH_COOKIE,
  startApp,
  type TestApi,
} from './support.ts'

// Cookie mode, for browsers: both tokens are httpOnly cookies, out of reach
// of the JavaScript of the page. The browser sends them by itself.
let api: TestApi

beforeEach(async () => {
  api = await startApp()
  await api.createUser('alice')
})

afterEach(async () => {
  vi.useRealTimers()
  await api.close()
})

/** Logs in in cookie mode, and returns the cookies the browser keeps. */
const loginWithCookies = async () =>
  cookiesOf(await api.login('alice', { mode: 'cookie' }))

/** Headers a browser sends for a request of the page itself. */
const sameOrigin = (cookies: Record<string, { value: string }>) => ({
  cookie: cookieHeader(cookies),
  'sec-fetch-site': 'same-origin',
})

it('sets the tokens as cookies, and never returns them in the body', async () => {
  const res = await api.login('alice', { mode: 'cookie' })
  expect(res.status).toBe(200)

  const body = await res.json()
  expect(body).toEqual({
    userId: expect.any(String),
    expiresIn: 900,
    expiresAt: expect.any(String),
  })

  const cookies = cookiesOf(res)
  expect(cookies[ACCESS_COOKIE]?.raw).toMatch(/HttpOnly/i)
  expect(cookies[ACCESS_COOKIE]?.raw).toMatch(/Secure/i)
  // The refresh token is only sent to the auth routes, and never with a
  // navigation from another site.
  expect(cookies[REFRESH_COOKIE]?.raw).toMatch(/Path=\/auth/)
  expect(cookies[REFRESH_COOKIE]?.raw).toMatch(/SameSite=Strict/i)
})

it('authenticates the requests of the page with the cookies', async () => {
  const cookies = await loginWithCookies()

  const me = await api.request('/auth/me', { headers: sameOrigin(cookies) })
  expect(await me.json()).toMatchObject({ username: 'alice' })

  const created = await api.post(
    '/notes',
    { text: 'Hello' },
    sameOrigin(cookies)
  )
  expect(created.status).toBe(201)
})

it('ignores the cookies sent by a request from another site', async () => {
  const cookies = await loginWithCookies()
  // Cross-site request forgery: a form of another site posting to the API,
  // with the cookies attached by the browser.
  const crossSite = {
    cookie: cookieHeader(cookies),
    'sec-fetch-site': 'cross-site',
    origin: 'https://attacker.example',
  }

  const created = await api.post('/notes', { text: 'Forged' }, crossSite)
  expect(created.status).toBe(401)

  const refreshed = await api.post('/auth/refresh', {}, crossSite)
  expect(refreshed.status).toBe(403)
  expect(await refreshed.json()).toMatchObject({
    message: 'CROSS_ORIGIN_REQUEST',
  })
})

it('refreshes the cookies', async () => {
  const cookies = await loginWithCookies()

  const refreshed = await api.post('/auth/refresh', {}, sameOrigin(cookies))
  expect(refreshed.status).toBe(200)

  const next = cookiesOf(refreshed)
  expect(next[REFRESH_COOKIE]?.value).not.toBe(cookies[REFRESH_COOKIE]?.value)
  const me = await api.request('/auth/me', { headers: sameOrigin(next) })
  expect(me.status).toBe(200)
})

it('restores the session when the page loads, even after the access token expired', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const cookies = await loginWithCookies()
  vi.setSystemTime(Date.now() + 60 * 60 * 1000) // one hour later

  const restored = await api.post('/auth/restore', {}, sameOrigin(cookies))
  expect(restored.status).toBe(200)
  expect(await restored.json()).toMatchObject({
    user: { username: 'alice' },
  })

  // New cookies replace the expired access token.
  const me = await api.request('/auth/me', {
    headers: sameOrigin(cookiesOf(restored)),
  })
  expect(me.status).toBe(200)
})

it('logs out, and clears the cookies', async () => {
  const cookies = await loginWithCookies()

  const logout = await api.post('/auth/logout', {}, sameOrigin(cookies))
  expect(logout.status).toBe(200)
  const cleared = cookiesOf(logout)
  expect(cleared[ACCESS_COOKIE]?.value).toBe('')
  expect(cleared[REFRESH_COOKIE]?.value).toBe('')

  // Cookies kept by a stolen copy no longer work.
  const refreshed = await api.post('/auth/refresh', {}, sameOrigin(cookies))
  expect(refreshed.status).toBe(401)
})
