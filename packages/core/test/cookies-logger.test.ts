import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConsoleLogger } from '../src/index.js'
import { parseCookieHeader, serializeCookie } from '../src/cookies.js'

describe('cookies', () => {
  it('serializes every attribute', () => {
    expect(
      serializeCookie('token', 'a;b', {
        maxAge: 3600.7,
        expires: new Date(Date.UTC(2030, 0, 1)),
        domain: 'example.com',
        path: '/api',
        httpOnly: true,
        secure: true,
        partitioned: true,
        sameSite: 'none',
        priority: 'high',
      })
    ).toBe(
      'token=a%3Bb; Max-Age=3600; Expires=Tue, 01 Jan 2030 00:00:00 GMT; Domain=example.com; Path=/api; HttpOnly; Secure; Partitioned; SameSite=None; Priority=High'
    )
  })

  it('rejects invalid names and attributes', () => {
    expect(() => serializeCookie('bad name', 'x')).toThrow(
      'Invalid cookie name'
    )
    expect(() => serializeCookie('ok', 'x', { path: '/a;b' })).toThrow(
      'Invalid cookie path'
    )
    expect(() => serializeCookie('ok', 'x', { maxAge: Number.NaN })).toThrow(
      'Invalid cookie maxAge'
    )
  })

  it('parses a Cookie header', () => {
    expect(
      parseCookieHeader('a=1; b="quoted"; c=caf%C3%A9; a=ignored; bad; d=%E0')
    ).toEqual({ a: '1', b: 'quoted', c: 'café', d: '%E0' })
    expect(parseCookieHeader(undefined)).toEqual({})
  })
})

describe('console logger', () => {
  afterEach(() => vi.restoreAllMocks())

  it('filters entries below the configured level', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    createConsoleLogger().debug('hidden')
    createConsoleLogger({ level: 'debug' }).debug('shown')
    createConsoleLogger({ level: 'warn' }).info('hidden')

    expect(debug).toHaveBeenCalledTimes(1)
    expect(debug).toHaveBeenCalledWith('shown')
    expect(info).not.toHaveBeenCalled()
  })

  it('supports Pino-style calls and child bindings', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('boom')

    const logger = createConsoleLogger().child({ requestId: 'r1' })
    logger.error({ userId: 'u1' }, 'Login failed')
    logger.error(failure, 'Crashed')
    logger.child({ step: 2 }).error('Plain message')

    expect(error.mock.calls).toEqual([
      ['Login failed', { requestId: 'r1', userId: 'u1' }],
      ['Crashed', { requestId: 'r1', err: failure }],
      ['Plain message', { requestId: 'r1', step: 2 }],
    ])
  })
})
