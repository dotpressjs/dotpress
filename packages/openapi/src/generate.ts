import type { Plugin, RouteInfo, DocumentedResponse } from '@dotpress/core'
import type * as z from 'zod'
import { createSchemaCollector, type SchemaSide } from './schemas.js'
import type {
  ExternalDocumentationObject,
  InfoObject,
  JsonSchema,
  OpenApiDocument,
  OperationObject,
  ParameterObject,
  PathItemObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  SecuritySchemeObject,
  ServerObject,
  TagObject,
} from './types.js'
import { assertKnownOptions } from './options.js'

export interface OpenApiOptions {
  info: InfoObject
  /**
   * Defaults to the `publicBasePath` of the app when it has one. Paths
   * include the `basePath`.
   */
  servers?: ServerObject[]
  /** Descriptions of the tags used by the routes (`meta.tags`). */
  tags?: TagObject[]
  externalDocs?: ExternalDocumentationObject
  /**
   * Security schemes, added to those of the installed plugins (for instance
   * `bearerAuth` with `@dotpress/auth`).
   */
  securitySchemes?: Record<string, SecuritySchemeObject>
  /**
   * Called for problems that do not prevent the generation, such as a
   * schema without JSON representation. Defaults to `console.warn`.
   */
  onWarning?: (message: string) => void
}

/** Routes to document: an app, or its routes. */
export type OpenApiSource =
  | readonly RouteInfo[]
  | {
      readonly routes: readonly RouteInfo[]
      readonly plugins?: readonly Plugin[]
      readonly publicBasePath?: string
    }

/** Schema of the error responses (`ErrorBody` of `@dotpress/core`). */
const ERROR_SCHEMA_NAME = 'DotpressError'

const ERROR_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    status: { type: 'integer', description: 'HTTP status.' },
    error: {
      type: 'string',
      description: 'Error code, for instance `VALIDATION_FAILED`.',
    },
    message: { type: 'string' },
    data: {
      type: 'object',
      additionalProperties: true,
      description: 'Details, such as the validation `issues`.',
    },
  },
  required: ['status', 'error', 'message'],
}

const ERROR_RESPONSES: Record<number, { name: string; description: string }> = {
  400: {
    name: 'BadRequest',
    description:
      'Invalid request: validation failed (`VALIDATION_FAILED`, with `data.issues`) or malformed body.',
  },
  401: { name: 'Unauthorized', description: 'Missing or invalid credentials.' },
  403: { name: 'Forbidden', description: 'Insufficient permissions.' },
  500: { name: 'InternalError', description: 'Unexpected error.' },
}

const isSecuritySchemes = (
  value: unknown
): value is Record<string, SecuritySchemeObject> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Security schemes exposed by plugins (`securitySchemes` property). */
const pluginSecuritySchemes = (plugins: readonly Plugin[]) =>
  Object.assign(
    {},
    ...plugins.map((plugin) => {
      const schemes = (plugin as { securitySchemes?: unknown }).securitySchemes
      return isSecuritySchemes(schemes) ? schemes : {}
    })
  ) as Record<string, SecuritySchemeObject>

/** `/users/:id` → `/users/{id}`. */
const toOpenApiPath = (path: string) =>
  path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')

const isOptional = (schema: z.core.$ZodType) => schema._zod.optin === 'optional'

/**
 * Generates an OpenAPI 3.1 document from the routes of an app: paths,
 * parameters, bodies and responses from the Zod schemas, `meta` fields,
 * security, and standard error responses.
 *
 * @example
 * const app = await createApp({ adapter, plugins: [authPlugin(auth)] })
 * const document = generateOpenApi(app, { info: { title: 'My API', version: '1.0.0' } })
 */
export const generateOpenApi = (
  source: OpenApiSource,
  options: OpenApiOptions
): OpenApiDocument => {
  assertKnownOptions('generateOpenApi()', options, [
    'info',
    'servers',
    'tags',
    'externalDocs',
    'securitySchemes',
    'onWarning',
  ] satisfies (keyof OpenApiOptions)[])
  if (!options?.info?.title || !options.info.version) {
    throw new TypeError(
      'generateOpenApi(): info.title and info.version are required.'
    )
  }

  const app = Array.isArray(source)
    ? { routes: source as readonly RouteInfo[] }
    : (source as Exclude<OpenApiSource, readonly RouteInfo[]>)
  const warn = options.onWarning ?? ((message) => console.warn(message))
  const collector = createSchemaCollector(warn)
  const securitySchemes = {
    ...pluginSecuritySchemes(app.plugins ?? []),
    ...options.securitySchemes,
  }

  const usedErrors = new Set<number>()
  const unknownSchemes = new Set<string>()
  const operationIds = new Map<string, string>()
  const paths: Record<string, PathItemObject> = {}

  for (const route of app.routes) {
    if (route.meta.hidden) continue

    const label = `${route.method.toUpperCase()} ${route.path}`
    const convert = (schema: z.core.$ZodType, side: SchemaSide, part: string) =>
      collector.convert(schema, side, `${label} (${part})`)

    /** Properties of an object schema, for parameters and form fields. */
    const objectOf = (schema: z.core.$ZodType, part: string) => {
      const resolved = collector.resolve(convert(schema, 'input', part))
      if (
        resolved.type !== 'object' ||
        typeof resolved.properties !== 'object'
      ) {
        warn(`${label} (${part}): not an object schema, not documented.`)
        return undefined
      }
      return {
        properties: resolved.properties as Record<string, JsonSchema>,
        required: (resolved.required as string[] | undefined) ?? [],
      }
    }

    const parameter = (
      name: string,
      location: 'path' | 'query',
      schema: JsonSchema,
      required: boolean
    ): ParameterObject => ({
      name,
      in: location,
      ...(required && { required: true }),
      ...(typeof schema.description === 'string' && {
        description: schema.description,
      }),
      ...(schema.deprecated === true && { deprecated: true }),
      schema,
    })

    const { schema } = route
    const parameters: ParameterObject[] = []

    const params = schema.params && objectOf(schema.params, 'params')
    for (const name of route.pathParams) {
      parameters.push(
        parameter(
          name,
          'path',
          params?.properties[name] ?? { type: 'string' },
          true
        )
      )
    }

    const query = schema.query && objectOf(schema.query, 'query')
    for (const [name, property] of Object.entries(query?.properties ?? {})) {
      parameters.push(
        parameter(name, 'query', property, query!.required.includes(name))
      )
    }

    let requestBody: RequestBodyObject | undefined
    if (schema.files) {
      const files = objectOf(schema.files, 'files')
      const fields = schema.body && objectOf(schema.body, 'body')
      const required = [...(fields?.required ?? []), ...(files?.required ?? [])]
      requestBody = {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: { ...fields?.properties, ...files?.properties },
              ...(required.length > 0 && { required }),
            },
          },
        },
      }
    } else if (schema.body) {
      requestBody = {
        required: !isOptional(schema.body),
        content: {
          'application/json': { schema: convert(schema.body, 'input', 'body') },
        },
      }
    }

    const responses: Record<string, ResponseObject | ReferenceObject> = {}
    const status = route.status ?? 200
    responses[status] = {
      description: 'Successful response.',
      ...(schema.response &&
        status !== 204 && {
          content: {
            'application/json': {
              schema: convert(schema.response, 'output', 'response'),
            },
          },
        }),
    }

    for (const [key, value] of Object.entries(route.meta.responses ?? {})) {
      const response: DocumentedResponse =
        typeof value === 'string' ? { description: value } : value
      responses[key] = {
        description: response.description,
        ...((response.schema || response.contentType) && {
          content: {
            [response.contentType ?? 'application/json']: response.schema
              ? {
                  schema: convert(response.schema, 'output', `${key} response`),
                }
              : {},
          },
        }),
      }
    }

    const validated =
      schema.params || schema.query || schema.body || schema.files
    const secured = route.security.length > 0
    for (const code of [
      ...(validated ? [400] : []),
      ...(secured ? [401, 403] : []),
      500,
    ]) {
      if (code in responses) continue
      usedErrors.add(code)
      responses[code] = {
        $ref: `#/components/responses/${ERROR_RESPONSES[code]!.name}`,
      }
    }

    for (const scheme of route.security.flat()) {
      if (!(scheme in securitySchemes)) unknownSchemes.add(scheme)
    }

    const { meta } = route
    if (meta.operationId !== undefined) {
      const existing = operationIds.get(meta.operationId)
      if (existing) {
        throw new Error(
          `Duplicate operationId "${meta.operationId}": ${existing} and ${label}.`
        )
      }
      operationIds.set(meta.operationId, label)
    }

    const operation: OperationObject = {
      ...(meta.summary !== undefined && { summary: meta.summary }),
      ...(meta.description !== undefined && { description: meta.description }),
      ...(meta.tags !== undefined && { tags: [...meta.tags] }),
      ...(meta.operationId !== undefined && { operationId: meta.operationId }),
      ...(meta.deprecated === true && { deprecated: true }),
      ...(parameters.length > 0 && { parameters }),
      ...(requestBody && { requestBody }),
      responses,
      ...(secured && {
        security: route.security.map((requirement) =>
          Object.fromEntries(requirement.map((scheme) => [scheme, []]))
        ),
      }),
    }

    const path = toOpenApiPath(route.path)
    paths[path] = { ...paths[path], [route.method]: operation }
  }

  for (const scheme of unknownSchemes) {
    warn(
      `Security scheme "${scheme}" is used by routes but not declared: add it to the securitySchemes option.`
    )
  }

  const { schemas, finalRefs } = collector.finalize([ERROR_SCHEMA_NAME])
  if (usedErrors.size > 0) schemas[ERROR_SCHEMA_NAME] = ERROR_SCHEMA

  const errorResponses = Object.fromEntries(
    [...usedErrors]
      .sort((a, b) => a - b)
      .map((code) => {
        const { name, description } = ERROR_RESPONSES[code]!
        return [
          name,
          {
            description,
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${ERROR_SCHEMA_NAME}` },
              },
            },
          },
        ]
      })
  )

  const servers =
    options.servers ??
    (app.publicBasePath ? [{ url: app.publicBasePath }] : undefined)

  const components = {
    ...(Object.keys(schemas).length > 0 && { schemas }),
    ...(usedErrors.size > 0 && { responses: errorResponses }),
    ...(Object.keys(securitySchemes).length > 0 && { securitySchemes }),
  }

  return {
    openapi: '3.1.1',
    info: options.info,
    ...(servers && { servers }),
    ...(options.tags && { tags: options.tags }),
    ...(options.externalDocs && { externalDocs: options.externalDocs }),
    paths: finalRefs(paths),
    ...(Object.keys(components).length > 0 && { components }),
  }
}
