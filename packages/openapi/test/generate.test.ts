import { arrayOf, defineMiddleware, type Middleware } from '@dotpress/core'
import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import { generateOpenApi } from '../src/index.js'
import { expectValid, generate, INFO, operation } from './support.js'

const secured = (...schemes: string[]): Middleware =>
  defineMiddleware(() => undefined, { security: schemes })

const handler = () => ({}) as never

describe('generateOpenApi()', () => {
  describe('document', () => {
    it('requires info.title and info.version', () => {
      for (const info of [undefined, { title: 'API' }, { version: '1' }]) {
        // @ts-expect-error invalid info
        expect(() => generateOpenApi([], { info })).toThrow(
          'generateOpenApi() requires info.title and info.version.'
        )
      }
    })

    it('rejects unknown options', () => {
      expect(() =>
        generateOpenApi([], {
          info: { title: 'API', version: '1.0.0' },
          server: [],
        } as never)
      ).toThrow(new TypeError('generateOpenApi(): unknown option "server".'))
    })

    it('generates an OpenAPI 3.1 document', async () => {
      const { document } = await generate((router) => {
        router.defineRoute({ path: '/health', handler })
      })

      expect(document).toMatchObject({
        openapi: '3.1.1',
        info: INFO,
        paths: { '/health': { get: { responses: {} } } },
      })
      expect(document).not.toHaveProperty('servers')
    })

    it('declares no components without routes', async () => {
      const { document } = await generate(() => {})

      expect(document).toEqual({ openapi: '3.1.1', info: INFO, paths: {} })
    })

    it('accepts a list of routes', async () => {
      const { app } = await generate((router) => {
        router.defineRoute({ path: '/health', handler })
      })

      const document = generateOpenApi(app.routes, { info: INFO })

      expect(Object.keys(document.paths)).toEqual(['/health'])
      await expectValid(document)
    })

    it('passes servers, tags and externalDocs through', async () => {
      const options = {
        servers: [{ url: 'https://api.example.com' }],
        tags: [{ name: 'members', description: 'Members' }],
        externalDocs: { url: 'https://docs.example.com' },
      }
      const { document } = await generate(() => {}, options)

      expect(document).toMatchObject(options)
    })

    it('uses the public base path as server, and keeps the base path in paths', async () => {
      const route = (router: Parameters<Parameters<typeof generate>[0]>[0]) =>
        router.defineRoute({ path: '/users/:id', handler })

      const proxied = await generate(route, {}, { publicBasePath: '/my-app' })
      expect(proxied.document.servers).toEqual([{ url: '/my-app' }])
      expect(Object.keys(proxied.document.paths)).toEqual(['/users/{id}'])

      const prefixed = await generate(route, {}, { basePath: '/my-app' })
      expect(prefixed.document).not.toHaveProperty('servers')
      expect(Object.keys(prefixed.document.paths)).toEqual([
        '/my-app/users/{id}',
      ])

      const explicit = await generate(
        route,
        { servers: [{ url: 'https://api.example.com/my-app' }] },
        { publicBasePath: '/my-app' }
      )
      expect(explicit.document.servers).toEqual([
        { url: 'https://api.example.com/my-app' },
      ])
    })

    it('excludes hidden routes', async () => {
      const { document } = await generate((router) => {
        router.defineRoute({ path: '/a', handler })
        router.defineRoute({ path: '/b', meta: { hidden: true }, handler })
      })

      expect(Object.keys(document.paths)).toEqual(['/a'])
    })
  })

  describe('operations', () => {
    it('groups the methods of a path', async () => {
      const { document } = await generate((router) => {
        router.defineRoute({ path: '/orgs/:orgId/members/:id', handler })
        router.defineRoute({
          method: 'delete',
          path: '/orgs/:orgId/members/:id',
          handler,
        })
      })

      expect(Object.keys(document.paths)).toEqual([
        '/orgs/{orgId}/members/{id}',
      ])
      expect(
        Object.keys(document.paths['/orgs/{orgId}/members/{id}']!)
      ).toEqual(['get', 'delete'])
    })

    it('copies the meta fields', async () => {
      const { document } = await generate((router) => {
        router.defineRoute({
          path: '/a',
          meta: {
            summary: 'Summary',
            description: 'Description',
            tags: ['a'],
            operationId: 'getA',
            deprecated: true,
          },
          handler,
        })
        router.defineRoute({
          path: '/b',
          meta: { deprecated: false },
          handler,
        })
      })

      expect(operation(document, 'get', '/a')).toMatchObject({
        summary: 'Summary',
        description: 'Description',
        tags: ['a'],
        operationId: 'getA',
        deprecated: true,
      })
      expect(Object.keys(operation(document, 'get', '/b'))).toEqual([
        'responses',
      ])
    })

    it('rejects duplicate operation ids', async () => {
      await expect(
        generate((router) => {
          router.defineRoute({
            path: '/a',
            meta: { operationId: 'x' },
            handler,
          })
          router.defineRoute({
            method: 'post',
            path: '/a',
            meta: { operationId: 'x' },
            handler,
          })
        })
      ).rejects.toThrow('Duplicate operationId "x": GET /a and POST /a.')
    })
  })

  describe('parameters', () => {
    it('documents path parameters, as strings without schema', async () => {
      const { document } = await generate((router) => {
        router.defineRoute({ path: '/orgs/:orgId/members/:id', handler })
        router.defineRoute({
          path: '/items/:id',
          schema: (z) => ({
            params: z.object({ id: z.coerce.number().int().describe('Item') }),
          }),
          handler,
        })
      })

      expect(
        operation(document, 'get', '/orgs/{orgId}/members/{id}').parameters
      ).toEqual([
        {
          name: 'orgId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ])
      expect(operation(document, 'get', '/items/{id}').parameters).toEqual([
        {
          name: 'id',
          in: 'path',
          required: true,
          description: 'Item',
          schema: expect.objectContaining({
            type: 'integer',
            description: 'Item',
          }),
        },
      ])
    })

    it('documents query parameters', async () => {
      const { document } = await generate((router) => {
        router.defineRoute({
          path: '/items',
          schema: (z) => ({
            query: z.object({
              search: z.string(),
              page: z.coerce.number().default(1),
              tag: arrayOf(z.string()).optional(),
              old: z.string().optional().meta({ deprecated: true }),
            }),
          }),
          handler,
        })
      })

      expect(operation(document, 'get', '/items').parameters).toEqual([
        {
          name: 'search',
          in: 'query',
          required: true,
          schema: { type: 'string' },
        },
        {
          name: 'page',
          in: 'query',
          schema: { type: 'number', default: 1 },
        },
        {
          name: 'tag',
          in: 'query',
          schema: { type: 'array', items: { type: 'string' } },
        },
        {
          name: 'old',
          in: 'query',
          deprecated: true,
          schema: { type: 'string', deprecated: true },
        },
      ])
    })

    it('resolves object schemas with an identifier', async () => {
      const Pagination = z
        .object({ page: z.coerce.number() })
        .meta({ id: 'Pagination' })
      const { document } = await generate((router) => {
        router.defineRoute({
          path: '/items',
          schema: { query: Pagination },
          handler,
        })
      })

      expect(operation(document, 'get', '/items').parameters).toEqual([
        {
          name: 'page',
          in: 'query',
          required: true,
          schema: { type: 'number' },
        },
      ])
    })

    it('warns about query schemas that are not objects', async () => {
      const { document, warnings } = await generate((router) => {
        router.defineRoute({
          path: '/items',
          schema: (z) => ({
            query: z.union([
              z.object({ a: z.string() }),
              z.object({ b: z.string() }),
            ]),
          }),
          handler,
        })
      })

      expect(operation(document, 'get', '/items')).not.toHaveProperty(
        'parameters'
      )
      expect(warnings).toEqual([
        'GET /items (query): not an object schema, not documented.',
      ])
    })
  })

  describe('request bodies', () => {
    it('documents JSON bodies, on the input side', async () => {
      const { document } = await generate((router) => {
        router.defineRoute({
          method: 'post',
          path: '/a',
          schema: (z) => ({
            body: z.object({
              name: z.string(),
              role: z.string().default('user'),
            }),
          }),
          handler,
        })
        router.defineRoute({
          method: 'post',
          path: '/b',
          schema: (z) => ({ body: z.object({ x: z.string() }).optional() }),
          handler,
        })
      })

      expect(operation(document, 'post', '/a').requestBody).toEqual({
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                role: { type: 'string', default: 'user' },
              },
              required: ['name'],
            },
          },
        },
      })
      expect(operation(document, 'post', '/b').requestBody).toMatchObject({
        required: false,
      })
    })

    it('documents uploads as multipart forms', async () => {
      const { document } = await generate((router) => {
        router.defineRoute({
          method: 'post',
          path: '/photos',
          schema: (z) => ({
            body: z.object({ caption: z.string().optional() }),
            files: z.object({
              photos: arrayOf(z.array(z.file().mime(['image/png'])).max(5)),
            }),
          }),
          handler,
        })
        router.defineRoute({
          method: 'post',
          path: '/avatar',
          schema: (z) => ({ files: z.object({ avatar: z.file().optional() }) }),
          handler,
        })
      })

      expect(operation(document, 'post', '/photos').requestBody).toEqual({
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                caption: { type: 'string' },
                photos: {
                  type: 'array',
                  maxItems: 5,
                  items: expect.objectContaining({
                    type: 'string',
                    format: 'binary',
                    contentMediaType: 'image/png',
                  }),
                },
              },
              required: ['photos'],
            },
          },
        },
      })
      expect(operation(document, 'post', '/avatar').requestBody).toMatchObject({
        content: {
          'multipart/form-data': {
            schema: { type: 'object', properties: { avatar: {} } },
          },
        },
      })
      expect(
        (
          operation(document, 'post', '/avatar').requestBody as {
            content: Record<string, { schema: object }>
          }
        ).content['multipart/form-data']!.schema
      ).not.toHaveProperty('required')
    })
  })

  describe('responses', () => {
    it('documents the success response, on the output side', async () => {
      const { document } = await generate((router) => {
        router.defineRoute({
          path: '/a',
          schema: (z) => ({
            response: z.object({ at: z.date(), n: z.number().default(0) }),
          }),
          handler,
        })
        router.defineRoute({ method: 'post', path: '/b', status: 201, handler })
        router.defineRoute({
          method: 'delete',
          path: '/c',
          status: 204,
          schema: (z) => ({ response: z.object({}) }),
          handler,
        })
      })

      expect(operation(document, 'get', '/a').responses['200']).toEqual({
        description: 'Successful response.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                at: { type: 'string', format: 'date-time' },
                n: { type: 'number', default: 0 },
              },
              required: ['at', 'n'],
              additionalProperties: false,
            },
          },
        },
      })
      expect(operation(document, 'post', '/b').responses['201']).toEqual({
        description: 'Successful response.',
      })
      expect(operation(document, 'delete', '/c').responses['204']).toEqual({
        description: 'Successful response.',
      })
    })

    it('adds meta.responses', async () => {
      const Conflict = z.object({ id: z.string() })
      const { document } = await generate((router) => {
        router.defineRoute({
          path: '/export',
          meta: {
            responses: {
              200: { description: 'CSV export', contentType: 'text/csv' },
              404: 'Not found',
              409: { description: 'Conflict', schema: Conflict },
              410: {
                description: 'Gone',
                schema: z.string(),
                contentType: 'text/plain',
              },
            },
          },
          handler,
        })
      })

      expect(operation(document, 'get', '/export').responses).toMatchObject({
        200: { description: 'CSV export', content: { 'text/csv': {} } },
        404: { description: 'Not found' },
        409: {
          description: 'Conflict',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { id: { type: 'string' } },
              },
            },
          },
        },
        410: { content: { 'text/plain': { schema: { type: 'string' } } } },
      })
    })

    it('adds the standard error responses', async () => {
      const { document } = await generate((router) => {
        router.defineRoute({ path: '/public', handler })
        router.defineRoute({
          path: '/validated',
          schema: (z) => ({ query: z.object({ q: z.string() }) }),
          handler,
        })
        router.defineRoute({
          path: '/secured',
          middlewares: [secured('bearerAuth')],
          handler,
        })
        router.defineRoute({
          path: '/custom',
          middlewares: [secured('bearerAuth')],
          meta: { responses: { 401: 'Custom' } },
          handler,
        })
      })

      const ref = (name: string) => ({
        $ref: `#/components/responses/${name}`,
      })
      const statuses = (path: string) =>
        operation(document, 'get', path).responses

      expect(statuses('/public')).toEqual({
        200: expect.anything(),
        500: ref('InternalError'),
      })
      expect(statuses('/validated')).toEqual({
        200: expect.anything(),
        400: ref('BadRequest'),
        500: ref('InternalError'),
      })
      expect(statuses('/secured')).toEqual({
        200: expect.anything(),
        401: ref('Unauthorized'),
        403: ref('Forbidden'),
        500: ref('InternalError'),
      })
      expect(statuses('/custom')['401']).toEqual({ description: 'Custom' })

      expect(Object.keys(document.components!.responses!)).toEqual([
        'BadRequest',
        'Unauthorized',
        'Forbidden',
        'InternalError',
      ])
      expect(document.components!.schemas!.DotpressError).toMatchObject({
        required: ['status', 'error', 'message'],
      })
    })

    it('declares only the error responses in use', async () => {
      const { document } = await generate((router) => {
        router.defineRoute({ path: '/public', handler })
      })

      expect(Object.keys(document.components!.responses!)).toEqual([
        'InternalError',
      ])
    })
  })

  describe('security', () => {
    it('documents the security requirements of the routes', async () => {
      const { document, warnings } = await generate(
        (router) => {
          router.defineRoute({
            path: '/either',
            middlewares: [secured('bearerAuth', 'apiKey')],
            handler,
          })
          router.defineRoute({
            path: '/both',
            middlewares: [secured('bearerAuth'), secured('apiKey')],
            handler,
          })
          router.defineRoute({
            path: '/public',
            middlewares: [secured('bearerAuth')],
            meta: { security: [] },
            handler,
          })
        },
        {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer' },
            apiKey: { type: 'apiKey', name: 'x-api-key', in: 'header' },
          },
        }
      )

      expect(operation(document, 'get', '/either').security).toEqual([
        { bearerAuth: [] },
        { apiKey: [] },
      ])
      expect(operation(document, 'get', '/both').security).toEqual([
        { bearerAuth: [], apiKey: [] },
      ])
      expect(operation(document, 'get', '/public')).not.toHaveProperty(
        'security'
      )
      expect(warnings).toEqual([])
    })

    it('warns about undeclared security schemes', async () => {
      const { warnings } = await generate((router) => {
        router.defineRoute({
          path: '/a',
          middlewares: [secured('apiKey')],
          handler,
        })
        router.defineRoute({
          path: '/b',
          middlewares: [secured('apiKey')],
          handler,
        })
      })

      expect(warnings).toEqual([
        'Security scheme "apiKey" is used by routes but not declared: add it to the securitySchemes option.',
      ])
    })

    it('reads the security schemes of the plugins', async () => {
      const plugin = {
        name: 'keys',
        securitySchemes: {
          apiKey: { type: 'apiKey', name: 'x-api-key', in: 'header' },
          other: { type: 'http', scheme: 'basic' },
        },
        setup: () => {},
      }
      const ignored = { name: 'none', securitySchemes: 'invalid', setup() {} }

      const { document } = await generate(
        () => {},
        { securitySchemes: { other: { type: 'http', scheme: 'bearer' } } },
        { plugins: [plugin, ignored] }
      )

      expect(document.components!.securitySchemes).toEqual({
        apiKey: { type: 'apiKey', name: 'x-api-key', in: 'header' },
        other: { type: 'http', scheme: 'bearer' },
      })
    })
  })

  describe('schemas', () => {
    const Member = z
      .object({ id: z.string(), role: z.string().default('user') })
      .meta({ id: 'Member', description: 'A member' })

    it('declares schemas with an identifier as components', async () => {
      const Tag = z.object({ name: z.string() }).meta({ id: 'Tag' })
      const Post = z
        .object({ tags: z.array(Tag), main: Tag })
        .meta({ id: 'Post' })
      const { document } = await generate((router) => {
        router.defineRoute({
          path: '/posts/:id',
          schema: { response: Post },
          handler,
        })
        router.defineRoute({
          path: '/tags',
          schema: { response: z.array(Tag) },
          handler,
        })
      })

      const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
      expect(
        operation(document, 'get', '/posts/{id}').responses['200']
      ).toMatchObject({
        content: { 'application/json': { schema: ref('Post') } },
      })
      expect(
        operation(document, 'get', '/tags').responses['200']
      ).toMatchObject({
        content: {
          'application/json': { schema: { type: 'array', items: ref('Tag') } },
        },
      })
      expect(document.components!.schemas).toMatchObject({
        Post: {
          type: 'object',
          properties: { tags: { items: ref('Tag') }, main: ref('Tag') },
        },
        Tag: { type: 'object', properties: { name: { type: 'string' } } },
      })
    })

    it('adds an Input variant when input and output differ', async () => {
      const Team = z.object({ members: z.array(Member) }).meta({ id: 'Team' })
      const Label = z.object({ name: z.string() }).meta({ id: 'Label' })
      // Same input and output, but it references a schema that differs.
      const Squad = z.strictObject({ lead: Member }).meta({ id: 'Squad' })
      const { document } = await generate((router) => {
        router.defineRoute({
          method: 'post',
          path: '/teams',
          schema: { body: Team, response: Team },
          handler,
        })
        router.defineRoute({
          method: 'post',
          path: '/squads',
          schema: { body: Squad, response: Squad },
          handler,
        })
        router.defineRoute({
          method: 'post',
          path: '/labels',
          schema: { body: z.strictObject({ label: Label }), response: Label },
          handler,
        })
      })

      const schemas = document.components!.schemas!
      expect(Object.keys(schemas).sort()).toEqual([
        'DotpressError',
        'Label',
        'LabelInput',
        'Member',
        'MemberInput',
        'Squad',
        'SquadInput',
        'Team',
        'TeamInput',
      ])
      expect(schemas.SquadInput).toMatchObject({
        properties: { lead: { $ref: '#/components/schemas/MemberInput' } },
      })
      expect(schemas.Member).toMatchObject({
        required: ['id', 'role'],
        additionalProperties: false,
        description: 'A member',
      })
      expect(schemas.MemberInput).toMatchObject({ required: ['id'] })
      expect(schemas.MemberInput).not.toHaveProperty('additionalProperties')
      expect(schemas.TeamInput).toMatchObject({
        properties: {
          members: { items: { $ref: '#/components/schemas/MemberInput' } },
        },
      })
      expect(schemas.Team).toMatchObject({
        properties: {
          members: { items: { $ref: '#/components/schemas/Member' } },
        },
      })
      expect(operation(document, 'post', '/teams').requestBody).toMatchObject({
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/TeamInput' },
          },
        },
      })
    })

    it('keeps a single schema when input and output are the same', async () => {
      const Range = z
        .strictObject({ from: z.number(), to: z.number() })
        .meta({ id: 'Range' })
      const Interval = z.strictObject({ range: Range }).meta({ id: 'Interval' })
      const { document } = await generate((router) => {
        router.defineRoute({
          method: 'post',
          path: '/ranges',
          schema: { body: Interval, response: Interval },
          handler,
        })
        router.defineRoute({
          method: 'post',
          path: '/members',
          schema: { body: Member },
          handler,
        })
      })

      expect(Object.keys(document.components!.schemas!).sort()).toEqual([
        'DotpressError',
        'Interval',
        'Member',
        'Range',
      ])
      // Only used as input: no suffix.
      expect(document.components!.schemas!.Member).toMatchObject({
        required: ['id'],
      })
      expect(operation(document, 'post', '/members').requestBody).toMatchObject(
        {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Member' },
            },
          },
        }
      )
    })

    it('rejects two different schemas with the same identifier', async () => {
      await expect(
        generate((router) => {
          router.defineRoute({
            path: '/a',
            schema: { response: z.object({ a: z.string() }).meta({ id: 'X' }) },
            handler,
          })
          router.defineRoute({
            path: '/b',
            schema: { response: z.object({ b: z.string() }).meta({ id: 'X' }) },
            handler,
          })
        })
      ).rejects.toThrow(
        'Two different schemas use the identifier "X" (GET /b (response)).'
      )
    })

    it('rejects identifiers used twice or reserved', async () => {
      const MemberInput = z
        .object({ x: z.string() })
        .meta({ id: 'MemberInput' })
      await expect(
        generate((router) => {
          router.defineRoute({
            method: 'post',
            path: '/a',
            schema: { body: Member, response: Member },
            handler,
          })
          router.defineRoute({
            path: '/b',
            schema: { response: MemberInput },
            handler,
          })
        })
      ).rejects.toThrow('The schema identifier "MemberInput" is used twice')

      await expect(
        generate((router) => {
          router.defineRoute({
            path: '/a',
            schema: {
              response: z.object({}).meta({ id: 'DotpressError' }),
            },
            handler,
          })
        })
      ).rejects.toThrow('"DotpressError" is used twice (or is reserved')
    })

    it('supports recursive schemas', async () => {
      const Category = z
        .object({
          name: z.string(),
          get children(): z.ZodArray<typeof Category> {
            return z.array(Category)
          },
        })
        .meta({ id: 'Category' })
      const Node = z.object({
        get next(): z.ZodOptional<typeof Node> {
          return Node.optional()
        },
      })

      const { document } = await generate((router) => {
        router.defineRoute({
          path: '/categories',
          schema: { response: z.array(Category) },
          handler,
        })
        router.defineRoute({
          path: '/nodes',
          schema: { response: z.object({ first: Node }) },
          handler,
        })
      })

      const schemas = document.components!.schemas!
      expect(schemas.Category).toMatchObject({
        properties: {
          children: { items: { $ref: '#/components/schemas/Category' } },
        },
      })
      // A recursive schema without identifier gets a generated name.
      expect(schemas.Schema1).toMatchObject({
        properties: { next: { $ref: '#/components/schemas/Schema1' } },
      })
    })

    it('rejects a recursive root schema without identifier', async () => {
      const Node = z.object({
        get next(): z.ZodOptional<typeof Node> {
          return Node.optional()
        },
      })

      await expect(
        generate((router) => {
          router.defineRoute({
            path: '/n',
            schema: { response: Node },
            handler,
          })
        })
      ).rejects.toThrow(
        "GET /n (response): recursive schema without identifier. Name it with .meta({ id: 'Name' })."
      )
    })

    it('documents dates as ISO 8601 strings', async () => {
      const { document } = await generate((router) => {
        router.defineRoute({
          method: 'post',
          path: '/events',
          schema: (z) => ({ body: z.object({ at: z.coerce.date() }) }),
          handler,
        })
      })

      expect(operation(document, 'post', '/events').requestBody).toMatchObject({
        content: {
          'application/json': {
            schema: {
              properties: { at: { type: 'string', format: 'date-time' } },
            },
          },
        },
      })
    })

    it('warns about types without JSON representation', async () => {
      const { document, warnings } = await generate((router) => {
        router.defineRoute({
          path: '/a',
          schema: (z) => ({
            response: z.object({
              big: z.bigint(),
              length: z.string().transform((value) => value.length),
            }),
          }),
          handler,
        })
      })

      expect(warnings).toEqual([
        'GET /a (response): bigint, transform cannot be represented in JSON Schema, documented as any value.',
      ])
      expect(operation(document, 'get', '/a').responses['200']).toMatchObject({
        content: {
          'application/json': {
            schema: { properties: { big: {}, length: {} } },
          },
        },
      })
    })

    it('warns with console.warn by default', async () => {
      const { app } = await generate((router) => {
        router.defineRoute({
          path: '/a',
          schema: (z) => ({ response: z.bigint() }),
          handler,
        })
      })
      const original = console.warn
      const messages: unknown[] = []
      console.warn = (message: unknown) => void messages.push(message)
      try {
        generateOpenApi(app, { info: INFO })
      } finally {
        console.warn = original
      }

      expect(messages).toEqual([
        'GET /a (response): bigint cannot be represented in JSON Schema, documented as any value.',
      ])
    })
  })
})
