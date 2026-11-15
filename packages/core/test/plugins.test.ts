import { describe, expect, it, vi } from 'vitest'
import {
  createApp,
  createRouter,
  declareContextKey,
  definePlugin,
  json,
  unauthorizedError,
  type Middleware,
  type Plugin,
  type ResponseEvent,
} from '../src/index.js'
import {
  createTestApp,
  memoryAdapter,
  silentLogger,
} from './support/memory-adapter.js'

declare module '../src/index.js' {
  interface RequestContext {
    clock: { now: () => number }
    counter: { value: number }
    session?: { id: string }
    notInstalled: { ping: () => string }
  }
}

declareContextKey('notInstalled', 'notInstalledPlugin')

const noopPlugin = (name: string, extra: Partial<Plugin> = {}) =>
  definePlugin({ name, setup: () => {}, ...extra })

describe('plugins', () => {
  describe('setup', () => {
    it('mounts plugin routes and groups', async () => {
      const health = definePlugin({
        name: 'health',
        setup(api) {
          api.defineRoute({
            path: '/health',
            handler: () => ({ status: 'ok' }),
          })
          api
            .createGroup('/admin')
            .defineRoute({ path: '/stats', handler: () => ({ stats: true }) })
        },
      })

      const { inject, app } = await createTestApp(
        (router) => {
          router.defineRoute({ path: '/users', handler: () => [] })
        },
        { plugins: [health] }
      )

      expect((await inject({ url: '/health' })).body).toEqual({
        status: 'ok',
      })
      expect((await inject({ url: '/admin/stats' })).body).toEqual({
        stats: true,
      })
      expect(app.routes.map((route) => route.path)).toEqual([
        '/users',
        '/health',
        '/admin/stats',
      ])
    })

    it('sets plugins up in dependency order and awaits async setups', async () => {
      const calls: string[] = []
      const track = (name: string, dependsOn?: string[]) =>
        definePlugin({
          name,
          dependsOn,
          async setup() {
            await Promise.resolve()
            calls.push(name)
          },
        })

      await createTestApp(() => {}, {
        plugins: [
          track('openapi', ['auth']),
          track('auth', ['db']),
          track('db'),
          track('mailer'),
        ],
      })

      expect(calls).toEqual(['db', 'auth', 'openapi', 'mailer'])
    })

    it.each([
      [[noopPlugin('a'), noopPlugin('a')], 'Plugin "a" is installed twice'],
      [
        [noopPlugin('openapi', { dependsOn: ['auth'] })],
        'Plugin "openapi" depends on "auth", which is not installed',
      ],
      [
        [
          noopPlugin('a', { dependsOn: ['b'] }),
          noopPlugin('b', { dependsOn: ['a'] }),
        ],
        'Circular plugin dependency: a -> b -> a',
      ],
      [[(() => {}) as unknown as Plugin], 'Invalid plugin'],
    ])('rejects invalid plugin lists (%#)', async (plugins, message) => {
      await expect(
        createApp({ adapter: memoryAdapter(), routers: [], plugins })
      ).rejects.toThrow(message)
    })

    it('only accepts registrations during setup()', async () => {
      let saved: Parameters<Plugin['setup']>[0] | undefined
      await createTestApp(() => {}, {
        plugins: [
          definePlugin({
            name: 'late',
            setup(api) {
              saved = api
            },
          }),
        ],
      })

      expect(() =>
        saved!.defineRoute({ path: '/late', handler: () => null })
      ).toThrow(
        'api.defineRoute() of plugin "late" can only be called during setup()'
      )
      expect(() => saved!.hooks.onReady(() => {})).toThrow(
        'can only be called during setup()'
      )
    })

    it('exposes other plugins through getPlugin()', async () => {
      const auth = definePlugin({
        name: 'auth',
        securitySchemes: ['bearer'],
        setup: () => {},
      })
      let schemes: unknown

      await createTestApp(() => {}, {
        plugins: [
          auth,
          definePlugin({
            name: 'openapi',
            dependsOn: ['auth'],
            setup(api) {
              schemes = api.getPlugin<typeof auth>('auth')?.securitySchemes
              expect(api.getPlugin('missing')).toBeUndefined()
            },
          }),
        ],
      })

      expect(schemes).toEqual(['bearer'])
    })
  })

  describe('middlewares and filters', () => {
    it('runs request hooks, plugin middlewares, app middlewares, then route middlewares', async () => {
      const calls: string[] = []
      const track =
        (name: string): Middleware =>
        () => {
          calls.push(name)
        }

      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({
            path: '/order',
            middlewares: [track('route')],
            handler: () => null,
          })
        },
        {
          middlewares: [track('app')],
          plugins: [
            definePlugin({
              name: 'tracker',
              setup(api) {
                api.addGlobalMiddleware(track('plugin'))
                api.hooks.onRequest(track('onRequest'))
              },
            }),
          ],
        }
      )

      await inject({ url: '/order' })

      expect(calls).toEqual(['onRequest', 'plugin', 'app', 'route'])
    })

    it('stops the pipeline when a request hook returns a response', async () => {
      const handler = vi.fn()
      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({ path: '/private', handler })
        },
        {
          plugins: [
            definePlugin({
              name: 'guard',
              setup(api) {
                api.hooks.onRequest(() => unauthorizedError())
              },
            }),
          ],
        }
      )

      expect((await inject({ url: '/private' })).status).toBe(401)
      expect(handler).not.toHaveBeenCalled()
    })

    describe('wrapRequest', () => {
      /** A scope like AsyncLocalStorage, for one request at a time. */
      const createScope = () => {
        let current: string[] | undefined
        return {
          get: () => current,
          run: async <T>(names: string[], next: () => Promise<T>) => {
            const previous = current
            current = names
            try {
              return await next()
            } finally {
              current = previous
            }
          },
        }
      }
      type Scope = ReturnType<typeof createScope>
      const scoped = (name: string, store: Scope) =>
        definePlugin({
          name,
          setup(api) {
            api.hooks.wrapRequest((_ctx, next) =>
              store.run([...(store.get() ?? []), name], next)
            )
          },
        })

      it('runs request hooks, middlewares and the handler inside the hooks', async () => {
        const store = createScope()
        const seen: unknown[] = []
        const track: Middleware = () => {
          seen.push(store.get())
        }
        const { inject } = await createTestApp(
          (router) => {
            router.defineRoute({
              path: '/scoped',
              middlewares: [track],
              handler: async () => {
                await new Promise((resolve) => setTimeout(resolve, 1))
                return { scope: store.get() }
              },
            })
          },
          {
            plugins: [
              scoped('outer', store),
              scoped('inner', store),
              definePlugin({
                name: 'hook',
                setup(api) {
                  api.hooks.onRequest(track)
                },
              }),
            ],
          }
        )
        const res = await inject({ url: '/scoped' })
        expect(res.body).toEqual({ scope: ['outer', 'inner'] })
        expect(seen).toEqual([
          ['outer', 'inner'],
          ['outer', 'inner'],
        ])
        expect(store.get()).toBeUndefined()
      })

      it('handles errors inside the hooks', async () => {
        const store = createScope()
        const scopes: unknown[] = []
        const onError = vi.fn(() => {
          scopes.push(store.get())
        })
        const { inject } = await createTestApp(
          (router) => {
            router.defineRoute({
              path: '/fails',
              handler: () => {
                throw new Error('boom')
              },
            })
          },
          { plugins: [scoped('scope', store)], onError }
        )
        expect((await inject({ url: '/fails' })).status).toBe(500)
        expect(scopes).toEqual([['scope']])
      })

      it('runs the request once when next() is called twice', async () => {
        const handler = vi.fn(() => ({ ok: true }))
        const { inject } = await createTestApp(
          (router) => {
            router.defineRoute({ path: '/twice', handler })
          },
          {
            plugins: [
              definePlugin({
                name: 'twice',
                setup(api) {
                  api.hooks.wrapRequest(async (_ctx, next) => {
                    await next()
                    return next()
                  })
                },
              }),
            ],
          }
        )
        expect((await inject({ url: '/twice' })).body).toEqual({ ok: true })
        expect(handler).toHaveBeenCalledOnce()
      })

      it('fails requests whose hook does not call next() or throws', async () => {
        const handler = vi.fn(() => null)
        const logger = silentLogger()
        const { inject } = await createTestApp(
          (router) => {
            router.defineRoute({ path: '/skipped', handler })
          },
          {
            logger,
            plugins: [
              definePlugin({
                name: 'skips',
                setup(api) {
                  api.hooks.wrapRequest((async () => undefined) as never)
                },
              }),
            ],
          }
        )
        expect((await inject({ url: '/skipped' })).status).toBe(500)
        expect(handler).not.toHaveBeenCalled()
        expect(logger.entries).toContainEqual({
          level: 'error',
          args: [
            new Error('A wrapRequest hook must call next().'),
            expect.any(String),
          ],
        })

        const failing = await createTestApp(
          (router) => {
            router.defineRoute({ path: '/throws', handler })
          },
          {
            plugins: [
              definePlugin({
                name: 'throws',
                setup(api) {
                  api.hooks.wrapRequest(() => {
                    throw new Error('no scope')
                  })
                },
              }),
            ],
          }
        )
        const res = await failing.inject({ url: '/throws' })
        expect(res.status).toBe(500)
        expect(res.headers['x-request-id']).toEqual(expect.any(String))
      })

      it('refuses hooks that are not functions', async () => {
        await expect(
          createApp({
            adapter: memoryAdapter(),
            logger: silentLogger(),
            plugins: [
              definePlugin({
                name: 'broken',
                setup(api) {
                  api.hooks.wrapRequest('scope' as never)
                },
              }),
            ],
          })
        ).rejects.toThrow(
          new TypeError(
            'Plugin "broken": hooks.wrapRequest() expects a function.'
          )
        )
      })
    })

    it('applies app filters, plugin filters, then router filters', async () => {
      const { inject } = await createTestApp(
        (router) => {
          router.addResponseFilter((_ctx, result) => [
            ...(result as string[]),
            'router',
          ])
          router.defineRoute({ path: '/filters', handler: () => [] })
        },
        {
          responseFilters: [(_ctx, result) => [...(result as string[]), 'app']],
          plugins: [
            definePlugin({
              name: 'filter',
              setup(api) {
                api.addResponseFilter((_ctx, result) => [
                  ...(result as string[]),
                  'plugin',
                ])
              },
            }),
          ],
        }
      )

      expect((await inject({ url: '/filters' })).body).toEqual([
        'app',
        'plugin',
        'router',
      ])
    })
  })

  describe('decorateContext()', () => {
    it('provides lazy values, computed once per request', async () => {
      const factory = vi.fn(() => ({ value: 0 }))

      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({
            path: '/count',
            handler: ({ counter }) => {
              counter.value += 1
              return { value: counter.value }
            },
          })
          router.defineRoute({ path: '/unused', handler: () => null })
        },
        {
          plugins: [
            definePlugin({
              name: 'counter',
              setup(api) {
                api.decorateContext('counter', factory)
              },
            }),
          ],
        }
      )

      await inject({ url: '/unused' })
      expect(factory).not.toHaveBeenCalled()

      expect((await inject({ url: '/count' })).body).toEqual({ value: 1 })
      expect((await inject({ url: '/count' })).body).toEqual({ value: 1 })
      expect(factory).toHaveBeenCalledTimes(2)
    })

    it('gives the factory the request context, and lets middlewares override values', async () => {
      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({
            path: '/session',
            handler: ({ session }) => ({ session }),
          })
          router.defineRoute({
            path: '/override',
            middlewares: [
              (ctx) => {
                ctx.session = { id: 'from-middleware' }
              },
            ],
            handler: ({ session }) => ({ session }),
          })
        },
        {
          plugins: [
            definePlugin({
              name: 'session',
              setup(api) {
                api.decorateContext('session', (ctx) => {
                  const id = ctx.req.cookies.sid
                  return id ? { id } : undefined
                })
              },
            }),
          ],
        }
      )

      expect(
        (await inject({ url: '/session', headers: { cookie: 'sid=abc' } })).body
      ).toEqual({ session: { id: 'abc' } })
      expect((await inject({ url: '/session' })).body).toEqual({})
      expect((await inject({ url: '/override' })).body).toEqual({
        session: { id: 'from-middleware' },
      })
    })

    it('rejects reserved and already provided keys', async () => {
      await expect(
        createTestApp(() => {}, {
          plugins: [
            definePlugin({
              name: 'bad',
              setup(api) {
                // @ts-expect-error reserved key
                api.decorateContext('req', () => null)
              },
            }),
          ],
        })
      ).rejects.toThrow('reserved context key "req"')

      const clock = (name: string) =>
        definePlugin({
          name,
          setup(api) {
            api.decorateContext('clock', () => ({ now: () => 0 }))
          },
        })

      await expect(
        createTestApp(() => {}, { plugins: [clock('a'), clock('b')] })
      ).rejects.toThrow(
        'cannot decorate "ctx.clock": it is already provided by plugin "a"'
      )
    })

    it('throws an explicit error when a declared key is used without its plugin', async () => {
      const logger = silentLogger()
      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({
            path: '/ping',
            handler: ({ notInstalled }) => notInstalled.ping(),
          })
          router.defineRoute({
            path: '/manual',
            middlewares: [
              (ctx) => {
                ctx.notInstalled = { ping: () => 'manual' }
              },
            ],
            handler: ({ notInstalled }) => notInstalled.ping(),
          })
        },
        { logger, exposeErrors: true }
      )

      const res = await inject({ url: '/ping' })
      expect(res.status).toBe(500)
      expect(res.body).toMatchObject({
        data: {
          message:
            '"ctx.notInstalled" is used, but the "notInstalledPlugin" plugin is not installed in createApp().',
        },
      })

      expect((await inject({ url: '/manual' })).body).toBe('manual')
    })

    it('uses the plugin value when the declared key is installed', async () => {
      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({
            path: '/ping',
            handler: ({ notInstalled }) => notInstalled.ping(),
          })
        },
        {
          plugins: [
            definePlugin({
              name: 'notInstalledPlugin',
              setup(api) {
                api.decorateContext('notInstalled', () => ({
                  ping: () => 'pong',
                }))
              },
            }),
          ],
        }
      )

      expect((await inject({ url: '/ping' })).body).toBe('pong')
    })

    it('rejects reserved keys in declareContextKey()', () => {
      // @ts-expect-error reserved key
      expect(() => declareContextKey('res', 'x')).toThrow('reserved')
    })
  })

  describe('error hooks', () => {
    it('calls the app and plugin error hooks, isolating failures', async () => {
      const logger = silentLogger()
      const appHook = vi.fn()
      const pluginHook = vi.fn()
      const failure = new Error('Boom')

      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({
            path: '/crash',
            handler: () => {
              throw failure
            },
          })
        },
        {
          logger,
          onError: appHook,
          plugins: [
            definePlugin({
              name: 'reporter',
              setup(api) {
                api.onError(() => {
                  throw new Error('Reporter down')
                })
                api.onError(pluginHook)
              },
            }),
          ],
        }
      )

      expect((await inject({ url: '/crash' })).status).toBe(500)
      expect(appHook).toHaveBeenCalledWith(failure, expect.any(Object))
      expect(pluginHook).toHaveBeenCalledWith(failure, expect.any(Object))
      expect(logger.entries).toContainEqual({
        level: 'error',
        args: [
          expect.objectContaining({ message: 'Reporter down' }),
          'onError hook failed',
        ],
      })
    })
  })

  describe('lifecycle hooks', () => {
    it('runs onInit with the routes, then onReady once mounted', async () => {
      const calls: string[] = []
      const adapter = memoryAdapter()
      const mount = adapter.mount
      adapter.mount = (routes, runtime) => {
        calls.push('mount')
        return mount(routes, runtime)
      }

      const router = createRouter()
      router.defineRoute({ path: '/users', handler: () => [] })

      await createApp({
        adapter,
        routers: [router],
        logger: silentLogger(),
        plugins: [
          definePlugin({
            name: 'lifecycle',
            setup(api) {
              expect(() => api.getRoutes()).toThrow(
                'api.getRoutes(): the routes are compiled after setup()'
              )
              api.hooks.onInit(() => {
                calls.push(
                  `init:${api
                    .getRoutes()
                    .map((route) => route.path)
                    .join(',')}`
                )
              })
              api.hooks.onReady(() => {
                calls.push('ready')
              })
            },
          }),
        ],
      })

      expect(calls).toEqual(['init:/users', 'mount', 'ready'])
    })

    it('runs onClose hooks in reverse order after the adapter, reporting failures', async () => {
      const calls: string[] = []
      const logger = silentLogger()
      const adapter = memoryAdapter()
      adapter.close = async () => {
        calls.push('adapter')
      }

      const closing = (name: string, fail = false) =>
        definePlugin({
          name,
          setup(api) {
            api.hooks.onClose(() => {
              calls.push(name)
              if (fail) throw new Error(`${name} failed`)
            })
          },
        })

      const app = await createApp({
        adapter,
        routers: [],
        logger,
        plugins: [closing('db'), closing('cache', true), closing('events')],
      })

      await expect(app.close()).rejects.toThrow('cache failed')
      expect(calls).toEqual(['adapter', 'events', 'cache', 'db'])
      expect(logger.entries).toContainEqual({
        level: 'error',
        args: [
          expect.objectContaining({ message: 'cache failed' }),
          'onClose hook failed',
        ],
      })
    })
  })

  describe('onResponse hooks', () => {
    it('receive every response, including 404 and 405', async () => {
      const events: ResponseEvent[] = []

      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({ path: '/users/:id', handler: () => ({ id: 1 }) })
        },
        {
          plugins: [
            definePlugin({
              name: 'logger',
              setup(api) {
                api.hooks.onResponse((event) => {
                  events.push(event)
                })
              },
            }),
          ],
        }
      )

      await inject({ url: '/users/1' })
      await inject({ url: '/missing' })
      await inject({ method: 'post', url: '/users/1' })
      await inject({ method: 'post', url: '/users/1', rawBody: '{oops' })

      expect(
        events.map((event) => [
          event.request.path,
          event.response.status,
          event.route?.path,
          event.ctx === undefined,
        ])
      ).toEqual([
        ['/users/1', 200, '/users/:id', false],
        ['/missing', 404, undefined, true],
        ['/users/1', 405, undefined, true],
        ['/users/1', 400, undefined, true],
      ])
      for (const event of events) {
        expect(event.duration).toBeGreaterThanOrEqual(0)
        expect(event.requestId).toBe(event.response.headers['x-request-id'])
      }
      expect(events[0]?.ctx?.requestId).toBe(events[0]?.requestId)
    })

    it('can replace responses, for instance to add headers', async () => {
      const logger = silentLogger()
      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({ path: '/data', handler: () => json({ a: 1 }) })
        },
        {
          logger,
          plugins: [
            definePlugin({
              name: 'cors',
              setup(api) {
                api.hooks.onResponse(({ request, response }) => {
                  if (request.method.toUpperCase() === 'OPTIONS') {
                    return {
                      status: 204,
                      headers: {
                        ...response.headers,
                        'access-control-allow-origin': '*',
                      },
                      body: null,
                    }
                  }
                  return {
                    ...response,
                    headers: {
                      ...response.headers,
                      'access-control-allow-origin': '*',
                    },
                  }
                })
                api.hooks.onResponse(() => {
                  throw new Error('Broken hook')
                })
              },
            }),
          ],
        }
      )

      const data = await inject({ url: '/data' })
      expect(data.headers['access-control-allow-origin']).toBe('*')
      expect(data.body).toEqual({ a: 1 })

      const preflight = await inject({ method: 'options', url: '/data' })
      expect(preflight.status).toBe(204)
      expect(preflight.headers['access-control-allow-origin']).toBe('*')

      expect(logger.entries).toContainEqual({
        level: 'error',
        args: [
          expect.objectContaining({ message: 'Broken hook' }),
          'onResponse hook failed',
        ],
      })
    })
  })
})
