import {
  createMemoryRateLimitStore,
  forbiddenError,
  type RateLimitStore,
} from '@dotpress/core'
import { createTestApp } from '@dotpress/testing'
import { describe, expect, it, vi } from 'vitest'
import { authPlugin, createAuth, type AuthOptions } from '../src/index.js'
import { createStore, keys, postJson, TEST_HASH_ROUNDS } from './support.js'

/** Apps sharing one auth service (and its throttle store), per IP address. */
const setup = async (settings: Partial<AuthOptions> = {}) => {
  const store = createStore()
  const auth = createAuth({
    keys,
    dataProvider: store.provider,
    issuer: 'https://api.example.com',
    passwordHashRounds: TEST_HASH_ROUNDS,
    ...settings,
  })
  const from = async (ip: string) =>
    (
      await createTestApp({
        routers: [],
        plugins: [authPlugin(auth)],
        adapter: { ip },
      })
    ).fetch
  return { auth, from }
}

type Fetch = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['from']>>

const attempt = (fetch: Fetch, username = 'ada', password = 'wrong') =>
  fetch('/auth/login', postJson({ username, password }))

const statuses = async (fetch: Fetch, count: number, username = 'ada') => {
  const result: number[] = []
  for (let index = 0; index < count; index++) {
    result.push((await attempt(fetch, username)).status)
  }
  return result
}

describe('login throttle', () => {
  it('blocks a client after 5 failed logins per minute', async () => {
    const onLoginFailed = vi.fn(async () => {})
    const { from } = await setup({ onLoginFailed })
    const fetch = await from('203.0.113.1')

    expect(await statuses(fetch, 5)).toEqual([401, 401, 401, 401, 401])

    const blocked = await attempt(fetch, 'ada', 'secret')
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({
      error: 'TOO_MANY_LOGIN_ATTEMPTS',
    })
    const retryAfter = Number(blocked.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThan(50)
    expect(retryAfter).toBeLessThanOrEqual(60)
    expect(onLoginFailed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        username: 'ada',
        errorType: 'too_many_attempts',
        ipAddress: '203.0.113.1',
      })
    )

    // Other clients and other accounts are not blocked.
    expect(
      (await attempt(await from('203.0.113.2'), 'ada', 'secret')).status
    ).toBe(200)
    expect((await attempt(fetch, 'linus', 'secret')).status).toBe(200)
  })

  it('treats unknown usernames like existing ones', async () => {
    const { from } = await setup()
    const fetch = await from('203.0.113.1')

    expect(await statuses(fetch, 6, 'grace')).toEqual(
      await statuses(await from('203.0.113.2'), 6)
    )
  })

  it('normalizes the username', async () => {
    const { from } = await setup()
    const fetch = await from('203.0.113.1')

    await statuses(fetch, 5, 'ada')
    expect((await attempt(fetch, ' ADA ')).status).toBe(429)
  })

  it('clears the counter of the client on success', async () => {
    const { from } = await setup()
    const fetch = await from('203.0.113.1')

    await statuses(fetch, 4)
    expect((await attempt(fetch, 'ada', 'secret')).status).toBe(200)
    expect(await statuses(fetch, 5)).toEqual([401, 401, 401, 401, 401])
  })

  it('limits the failed logins of an account from every IP address', async () => {
    const { from } = await setup({
      loginThrottle: {
        limits: { usernameAndIp: false, username: { max: 3, window: 3600 } },
      },
    })

    for (let index = 0; index < 3; index++) {
      expect((await attempt(await from(`203.0.113.${index + 1}`))).status).toBe(
        401
      )
    }
    const blocked = await attempt(await from('198.51.100.1'), 'ada', 'secret')
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(3500)
  })

  it('counts parallel attempts', async () => {
    const { from } = await setup()
    const fetch = await from('203.0.113.1')

    const results = await Promise.all(
      Array.from({ length: 20 }, () => attempt(fetch))
    )

    expect(results.filter((res) => res.status !== 429)).toHaveLength(5)
  })

  it('can be disabled', async () => {
    const { from } = await setup({ loginThrottle: false })
    const fetch = await from('203.0.113.1')

    expect(await statuses(fetch, 10)).not.toContain(429)
  })

  it('uses the configured store, with hashed keys', async () => {
    const memory = createMemoryRateLimitStore()
    const store: RateLimitStore = {
      increment: vi.fn(memory.increment),
      reset: vi.fn(memory.reset),
    }
    const { from } = await setup({ loginThrottle: { store } })
    const fetch = await from('203.0.113.1')

    await attempt(fetch, 'ada', 'secret')

    const keysUsed = vi.mocked(store.increment).mock.calls.map(([key]) => key)
    expect(keysUsed).toEqual([
      expect.stringMatching(/^dotpress:login:username-ip:[0-9a-f]{64}$/),
      expect.stringMatching(/^dotpress:login:username:[0-9a-f]{64}$/),
    ])
    expect(
      vi.mocked(store.increment).mock.calls.map(([, window]) => window)
    ).toEqual([60, 3600])
    // Only the counter of the client is cleared by a successful login.
    expect(vi.mocked(store.reset).mock.calls).toEqual([[keysUsed[0]]])
  })

  it.each([
    [
      { limits: { usernameAndIp: { max: 0, window: 60 } } },
      'loginThrottle.limits.usernameAndIp.max must be a positive integer',
    ],
    [
      { limits: { username: { max: 5, window: -1 } } },
      'loginThrottle.limits.username.window must be a number of seconds',
    ],
    [
      { store: {} as RateLimitStore },
      'loginThrottle.store must have increment() and reset() methods',
    ],
  ])('rejects invalid settings (%o)', async (loginThrottle, message) => {
    await expect(setup({ loginThrottle })).rejects.toThrow(message)
  })
})

describe('beforeLogin', () => {
  it('can reject an attempt before the password is checked', async () => {
    const beforeLogin = vi.fn(({ ipAddress }: { ipAddress: string }) =>
      ipAddress === '198.51.100.1' ? forbiddenError('LOGIN_BLOCKED') : undefined
    )
    const { auth, from } = await setup({ beforeLogin })
    const verifyPassword = vi.spyOn(auth, 'verifyPassword')

    const blocked = await attempt(await from('198.51.100.1'), 'ada', 'secret')
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toMatchObject({ message: 'LOGIN_BLOCKED' })
    expect(verifyPassword).not.toHaveBeenCalled()
    expect(beforeLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'ada',
        clientId: '',
        ipAddress: '198.51.100.1',
        req: expect.objectContaining({ method: 'POST' }),
      })
    )

    expect(
      (await attempt(await from('203.0.113.1'), 'ada', 'secret')).status
    ).toBe(200)
  })

  it('is not called for throttled attempts', async () => {
    const beforeLogin = vi.fn(async () => undefined)
    const { from } = await setup({ beforeLogin })
    const fetch = await from('203.0.113.1')

    await statuses(fetch, 6)

    expect(beforeLogin).toHaveBeenCalledTimes(5)
  })
})
