import { createHash } from 'node:crypto'
import { authPlugin, createAuth, requireRole } from '@dotpress/auth'
import { arrayOf, createRouter, forbiddenError } from '@dotpress/core'
import { createTestApp, type TestAppOptions } from '@dotpress/testing'
import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import {
  openapiPlugin,
  SCALAR_NEUTRAL_CONFIGURATION,
  type OpenApiDocument,
  type OpenApiPluginOptions,
} from '../src/index.js'
import { SCALAR_CDN_URL } from '../src/ui.js'
import { createKeys, expectValid, INFO } from './support.js'

const keys = await createKeys()

/** Scalar configuration of a page. */
const configurationOf = (html: string) => {
  const match = /Scalar\.createApiReference\('#app', (.*)\)\n/.exec(html)
  if (!match) throw new Error('No Scalar configuration in the page')
  return JSON.parse(match[1]!) as Record<string, unknown>
}

const createDocsApp = async (
  options: Partial<OpenApiPluginOptions> = {},
  appOptions: TestAppOptions = {}
) => {
  const router = createRouter()
  router.defineRoute({ path: '/users/:id', handler: () => ({}) })
  const plugin = openapiPlugin({ info: INFO, ...options })
  const app = await createTestApp({
    routers: [router],
    ...appOptions,
    plugins: [plugin, ...(appOptions.plugins ?? [])],
  })
  return { ...app, plugin }
}

describe('openapiPlugin()', () => {
  it('requires info.title and info.version', () => {
    // @ts-expect-error missing info
    expect(() => openapiPlugin({})).toThrow(
      'openapiPlugin(): info.title and info.version are required.'
    )
  })

  it('rejects unknown options', () => {
    const info = { title: 'API', version: '1.0.0' }
    expect(() => openapiPlugin({ info, middleware: [] } as never)).toThrow(
      new TypeError('openapiPlugin(): unknown option "middleware".')
    )
    expect(() => openapiPlugin({ info, ui: { cdn: 'x' } } as never)).toThrow(
      new TypeError('openapiPlugin(): unknown option "ui.cdn".')
    )
  })

  it('serves the document, without its own routes', async () => {
    const { fetch, plugin } = await createDocsApp()

    const res = await fetch('/openapi.json')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(
      'application/json; charset=utf-8'
    )
    const document = (await res.json()) as OpenApiDocument
    expect(Object.keys(document.paths)).toEqual(['/users/{id}'])
    expect(document).toEqual(plugin.getDocument())
    await expectValid(document)
  })

  it('is not changed by the response filters of the app', async () => {
    const { fetch } = await createDocsApp(
      {},
      { responseFilters: [(_, result) => ({ data: result })] }
    )

    expect(await (await fetch('/openapi.json')).json()).toHaveProperty(
      'openapi'
    )
  })

  it('serves the Scalar API Reference', async () => {
    const { fetch } = await createDocsApp()

    const res = await fetch('/docs')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const html = await res.text()
    expect(html).toContain('<title>Test API</title>')
    expect(html).toContain(
      `<script src="${SCALAR_CDN_URL}" integrity="sha384-hwB9WroDTpZaI38gr+u9CXA6ksz5gUYgD2GxXazKl/agT1L2GWUiRFWGJYNiFu4Q" crossorigin="anonymous"></script>`
    )
    expect(configurationOf(html)).toEqual({
      ...SCALAR_NEUTRAL_CONFIGURATION,
      url: '/openapi.json',
    })
  })

  describe('Content Security Policy of the page', () => {
    /** The policy as directives, and the hash of the inline script. */
    const policyOf = async (res: Response) => {
      const header = res.headers.get('content-security-policy')
      const html = await res.text()
      const inline = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!
      const hash = createHash('sha256').update(inline).digest('base64')
      const directives = Object.fromEntries(
        (header ?? '').split('; ').map((directive) => {
          const [name, ...sources] = directive.split(' ')
          return [name!, sources]
        })
      )
      return { header, directives, hash }
    }

    it('allows the Scalar script, the inline script and the document only', async () => {
      const { fetch } = await createDocsApp()

      const { directives, hash } = await policyOf(await fetch('/docs'))

      expect(directives).toEqual({
        'default-src': ["'none'"],
        'script-src': ['https://cdn.jsdelivr.net', `'sha256-${hash}'`],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      })
    })

    it('follows the configuration: hash, script host, servers', async () => {
      const { fetch } = await createDocsApp({
        servers: [{ url: 'https://api.example.com/v1' }, { url: '/relative' }],
        ui: {
          cdnUrl: '/assets/scalar.js',
          configuration: { theme: 'purple' },
        },
      })

      const { directives, hash } = await policyOf(await fetch('/docs'))

      // The hash covers the configuration of the page.
      expect(directives['script-src']).toEqual(["'self'", `'sha256-${hash}'`])
      expect(directives['connect-src']).toEqual([
        "'self'",
        'https://api.example.com',
      ])
    })

    it('takes extra sources, or no policy', async () => {
      const extended = await createDocsApp({
        ui: {
          contentSecurityPolicy: {
            'img-src': ['https://cdn.example.com'],
            'frame-ancestors': ["'self'"],
          },
        },
      })
      const { directives } = await policyOf(await extended.fetch('/docs'))
      expect(directives['img-src']).toEqual([
        "'self'",
        'data:',
        'https://cdn.example.com',
      ])
      expect(directives['frame-ancestors']).toEqual(["'self'"])

      const none = await createDocsApp({ ui: { contentSecurityPolicy: false } })
      const res = await none.fetch('/docs')
      expect(res.headers.get('content-security-policy')).toBeNull()
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    })

    it('is not set on the document', async () => {
      const { fetch } = await createDocsApp()
      const res = await fetch('/openapi.json')
      expect(res.headers.get('content-security-policy')).toBeNull()
    })
  })

  it('keeps the page neutral by default', async () => {
    const { fetch } = await createDocsApp()

    expect(configurationOf(await (await fetch('/docs')).text())).toEqual({
      telemetry: false,
      agent: { disabled: true },
      mcp: { disabled: true },
      showDeveloperTools: 'never',
      hideClientButton: true,
      withDefaultFonts: false,
      customCss: 'a[href*="utm_source=powered-by"] { display: none; }',
      url: '/openapi.json',
    })
  })

  it('lets the configuration override the neutral defaults', async () => {
    const { fetch } = await createDocsApp({
      ui: {
        configuration: {
          telemetry: true,
          hideClientButton: false,
          customCss: '.light-mode { --scalar-color-accent: teal; }',
        },
      },
    })

    expect(configurationOf(await (await fetch('/docs')).text())).toMatchObject({
      telemetry: true,
      hideClientButton: false,
      withDefaultFonts: false,
      customCss:
        'a[href*="utm_source=powered-by"] { display: none; }\n.light-mode { --scalar-color-accent: teal; }',
    })
  })

  it('configures the page', async () => {
    const { fetch } = await createDocsApp({
      path: '/spec.json',
      ui: {
        path: '/reference',
        title: 'Docs <&> "API"',
        cdnUrl: '/static/scalar.js',
        configuration: { theme: 'purple', url: '/ignored', note: '</script>' },
      },
    })

    expect((await fetch('/docs')).status).toBe(404)
    expect((await fetch('/spec.json')).status).toBe(200)
    const html = await (await fetch('/reference')).text()
    expect(html).toContain('<title>Docs &lt;&amp;&gt; &quot;API&quot;</title>')
    // Custom script: no integrity unless given.
    expect(html).toContain('<script src="/static/scalar.js"></script>')
    expect(html).toContain(`"note":"\\u003c/script>"`)
    expect(configurationOf(html)).toMatchObject({
      theme: 'purple',
      url: '/spec.json',
      note: '</script>',
    })
    expect(html.match(/<\/script>/g)).toHaveLength(2)
  })

  it('uses the integrity hash given with a custom script', async () => {
    const { fetch } = await createDocsApp({
      ui: {
        cdnUrl: 'https://cdn.example.com/scalar.js',
        integrity: 'sha384-x',
      },
    })

    expect(await (await fetch('/docs')).text()).toContain(
      '<script src="https://cdn.example.com/scalar.js" integrity="sha384-x" crossorigin="anonymous"></script>'
    )
  })

  it('can serve the document only', async () => {
    const { fetch } = await createDocsApp({ ui: false })

    expect((await fetch('/docs')).status).toBe(404)
    expect((await fetch('/openapi.json')).status).toBe(200)
  })

  it('follows the base path of the app', async () => {
    const prefixed = await createDocsApp({}, { basePath: '/my-app' })
    const html = await (await prefixed.fetch('/my-app/docs')).text()
    expect(configurationOf(html).url).toBe('/my-app/openapi.json')
    expect(
      Object.keys(
        (
          (await (await prefixed.fetch('/my-app/openapi.json')).json()) as {
            paths: object
          }
        ).paths
      )
    ).toEqual(['/my-app/users/{id}'])

    const proxied = await createDocsApp({}, { publicBasePath: '/my-app' })
    expect(
      configurationOf(await (await proxied.fetch('/docs')).text()).url
    ).toBe('/my-app/openapi.json')
    expect(proxied.plugin.getDocument().servers).toEqual([{ url: '/my-app' }])
  })

  it('protects its routes with middlewares', async () => {
    const { fetch } = await createDocsApp({
      middlewares: [() => forbiddenError()],
    })

    expect((await fetch('/openapi.json')).status).toBe(403)
    expect((await fetch('/docs')).status).toBe(403)
    expect((await fetch('/users/1')).status).toBe(200)
  })

  it('logs warnings with the plugin logger', async () => {
    const router = createRouter()
    router.defineRoute({
      path: '/big',
      schema: (z) => ({ response: z.bigint() }),
      handler: () => 1n,
    })
    const { logger } = await createTestApp({
      routers: [router],
      plugins: [openapiPlugin({ info: INFO })],
    })

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        args: [
          'GET /big (response): bigint cannot be represented in JSON Schema, documented as any value.',
        ],
      })
    )
  })

  it('gives the document once the app is created', () => {
    const plugin = openapiPlugin({ info: INFO })

    expect(() => plugin.getDocument()).toThrow(
      'The OpenAPI document is generated when the app is created.'
    )
  })

  it('documents a complete app', async () => {
    const auth = createAuth({
      keys,
      issuer: 'https://api.example.com',
      dataProvider: {} as never,
    })
    const Member = z
      .object({
        id: z.string(),
        name: z.string().min(1),
        role: z.enum(['admin', 'member']).default('member'),
        joinedAt: z.date(),
      })
      .meta({ id: 'Member', description: 'A member of an organization.' })

    const router = createRouter()
    const members = router.createGroup('/orgs/:orgId/members')
    members.defineRoute({
      method: 'post',
      path: '/',
      status: 201,
      schema: {
        body: Member.pick({ name: true, role: true }),
        response: Member,
      },
      meta: {
        summary: 'Add a member',
        tags: ['members'],
        operationId: 'addMember',
        responses: { 409: 'The member already exists.' },
      },
      handler: () => ({}) as never,
    })
    members.defineRoute({
      path: '/',
      schema: (z) => ({
        query: z.object({
          page: z.coerce.number().int().min(1).default(1),
          role: arrayOf(z.enum(['admin', 'member'])).optional(),
        }),
        response: z.array(Member),
      }),
      meta: { summary: 'List the members', tags: ['members'] },
      handler: () => [],
    })
    router.createGroup('/admin', [requireRole('admin')]).defineRoute({
      method: 'put',
      path: '/logo',
      schema: (z) => ({
        files: z.object({ logo: z.file().mime(['image/png']) }),
      }),
      meta: { summary: 'Upload the logo', tags: ['admin'] },
      handler: () => undefined,
    })
    router.defineRoute({
      path: '/export.csv',
      meta: {
        summary: 'Export the members',
        responses: {
          200: { description: 'CSV file.', contentType: 'text/csv' },
        },
      },
      handler: () => undefined,
    })

    const plugin = openapiPlugin({
      info: { ...INFO, description: 'Reference document of the tests.' },
      servers: [{ url: 'https://api.example.com' }],
      tags: [{ name: 'members', description: 'Members of the organizations.' }],
    })
    const { fetch } = await createTestApp({
      routers: [router],
      plugins: [authPlugin(auth, { jwks: true }), plugin],
    })

    const document = (await (
      await fetch('/openapi.json')
    ).json()) as OpenApiDocument
    await expectValid(document)
    await expect(JSON.stringify(document, null, 2) + '\n').toMatchFileSnapshot(
      './__snapshots__/reference.json'
    )
  })
})
