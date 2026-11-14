import { describe, expect, it } from 'vitest'
import { type HttpMethod } from '../src/index.js'
import { createRouteMatcher, type CompiledRoute } from '../src/adapter-api.js'

const route = (method: HttpMethod, path: string) =>
  ({ method, path }) as unknown as CompiledRoute

const matcherFor = (...routes: CompiledRoute[]) => createRouteMatcher(routes)

describe('createRouteMatcher()', () => {
  it('matches static paths and extracts parameters', () => {
    const users = route('get', '/users')
    const member = route('get', '/orgs/:orgId/members/:id')
    const matcher = matcherFor(users, member)

    expect(matcher.match('GET', '/users')).toEqual({ route: users, params: {} })
    expect(matcher.match('get', '/orgs/acme/members/42')).toEqual({
      route: member,
      params: { orgId: 'acme', id: '42' },
    })
    expect(matcher.match('GET', '/orgs/acme')).toBeUndefined()
    expect(matcher.match('GET', '/users/42')).toBeUndefined()
  })

  it('matches the root path', () => {
    const root = route('get', '/')
    expect(matcherFor(root).match('GET', '/')?.route).toBe(root)
  })

  it('is case-sensitive', () => {
    expect(matcherFor(route('get', '/users')).match('GET', '/Users')).toBe(
      undefined
    )
  })

  it('ignores trailing and duplicate slashes', () => {
    const users = route('get', '/users/:id')
    const matcher = matcherFor(users)

    expect(matcher.match('GET', '/users/42/')?.params).toEqual({ id: '42' })
    expect(matcher.match('GET', '//users//42')?.params).toEqual({ id: '42' })
  })

  it('gives static segments priority over parameters', () => {
    const byId = route('get', '/users/:id')
    const me = route('get', '/users/me')
    const matcher = matcherFor(byId, me)

    expect(matcher.match('GET', '/users/me')?.route).toBe(me)
    expect(matcher.match('GET', '/users/42')?.route).toBe(byId)
  })

  it('backtracks to parameters when a static branch does not match', () => {
    const settings = route('get', '/users/me/settings')
    const posts = route('get', '/users/:id/posts')
    const matcher = matcherFor(settings, posts)

    expect(matcher.match('GET', '/users/me/posts')).toEqual({
      route: posts,
      params: { id: 'me' },
    })
  })

  it('supports different parameter names at the same position', () => {
    const user = route('get', '/users/:id')
    const posts = route('get', '/users/:userId/posts')
    const matcher = matcherFor(user, posts)

    expect(matcher.match('GET', '/users/1')?.params).toEqual({ id: '1' })
    expect(matcher.match('GET', '/users/1/posts')?.params).toEqual({
      userId: '1',
    })
  })

  it('decodes path segments', () => {
    const file = route('get', '/files/:name')
    const cafe = route('get', '/caf%C3%A9')
    const matcher = matcherFor(file, cafe)

    expect(matcher.match('GET', '/files/a%20b%2Fc')?.params).toEqual({
      name: 'a b/c',
    })
    expect(matcher.match('GET', '/files/100%')?.params).toEqual({
      name: '100%',
    })
    expect(matcher.match('GET', '/café')?.route).toBe(cafe)
  })

  it('does not pollute prototypes through parameter names', () => {
    const matcher = matcherFor(route('get', '/:__proto__'))
    const params = matcher.match('GET', '/polluted')?.params

    expect(Object.hasOwn(params ?? {}, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('only matches the declared method, with a GET fallback for HEAD', () => {
    const get = route('get', '/items')
    const matcher = matcherFor(get, route('post', '/items'))

    expect(matcher.match('HEAD', '/items')?.route).toBe(get)
    expect(matcher.match('OPTIONS', '/items')).toBeUndefined()
    expect(matcher.match('DELETE', '/items')).toBeUndefined()
  })

  it('prefers an explicit HEAD route', () => {
    const head = route('head', '/items')
    const matcher = matcherFor(route('get', '/items'), head)

    expect(matcher.match('HEAD', '/items')?.route).toBe(head)
  })

  it('lists the methods accepted by a path', () => {
    const matcher = matcherFor(
      route('delete', '/items/:id'),
      route('get', '/items/:id'),
      route('options', '/items/:id'),
      route('put', '/items/:id'),
      route('post', '/items')
    )

    expect(matcher.allowedMethods('/items/42')).toEqual([
      'get',
      'head',
      'put',
      'delete',
      'options',
    ])
    expect(matcher.allowedMethods('/items/')).toEqual(['post'])
    expect(matcher.allowedMethods('/missing')).toEqual([])
  })

  it('rejects conflicting routes', () => {
    expect(() =>
      matcherFor(route('get', '/users/:id'), route('get', '/users/:userId'))
    ).toThrow('Route conflict')
  })
})
