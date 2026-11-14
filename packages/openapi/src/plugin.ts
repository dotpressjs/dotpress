import { definePlugin, text, type Middleware } from '@dotpress/core'
import { generateOpenApi, type OpenApiOptions } from './generate.js'
import type { OpenApiDocument } from './types.js'
import { renderScalarPage, type ScalarOptions } from './ui.js'
import { assertKnownOptions } from './options.js'

export interface OpenApiPluginOptions extends Omit<
  OpenApiOptions,
  'onWarning'
> {
  /** Path of the JSON document. Defaults to `/openapi.json`. */
  path?: string
  /**
   * Scalar API Reference page, at `/docs` by default. `false` serves the
   * document only.
   */
  ui?: ScalarOptions | false
  /**
   * Middlewares of the document and page routes, for instance to restrict
   * them to administrators.
   */
  middlewares?: Middleware[]
}

const HTML = { 'content-type': 'text/html; charset=utf-8' }
const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' }

/**
 * Serves the OpenAPI document of the app, generated at startup from its
 * routes (see `generateOpenApi()`), and a Scalar API Reference page.
 * Warnings are logged by the plugin logger.
 *
 * @example
 * await createApp({
 *   adapter,
 *   plugins: [openapiPlugin({ info: { title: 'My API', version: '1.0.0' } })],
 * })
 * // GET /openapi.json, GET /docs
 */
export const openapiPlugin = (options: OpenApiPluginOptions) => {
  assertKnownOptions('openapiPlugin()', options, [
    'info',
    'servers',
    'tags',
    'externalDocs',
    'securitySchemes',
    'path',
    'ui',
    'middlewares',
  ] satisfies (keyof OpenApiPluginOptions)[])
  if (options.ui !== undefined && options.ui !== false) {
    assertKnownOptions(
      'openapiPlugin()',
      options.ui,
      [
        'path',
        'title',
        'cdnUrl',
        'integrity',
        'configuration',
      ] satisfies (keyof ScalarOptions)[],
      'ui.'
    )
  }
  if (!options?.info?.title || !options.info.version) {
    throw new TypeError('openapiPlugin() requires info.title and info.version.')
  }

  const {
    path = '/openapi.json',
    ui = {},
    middlewares = [],
    ...settings
  } = options
  let document: OpenApiDocument | undefined
  let body = ''

  return definePlugin({
    name: 'openapi',
    /** The generated document. Available once the app is created. */
    getDocument(): OpenApiDocument {
      if (!document) {
        throw new Error(
          'The OpenAPI document is generated when the app is created.'
        )
      }
      return document
    },
    setup(api) {
      // Serialized once: response filters of the app do not apply.
      api.addRoute({
        path,
        middlewares,
        meta: { hidden: true },
        handler: () => text(body, { headers: JSON_TYPE }),
      })

      if (ui !== false) {
        const page = renderScalarPage(
          api.publicPath(path),
          ui.title ?? settings.info.title,
          ui
        )
        api.addRoute({
          path: ui.path ?? '/docs',
          middlewares,
          meta: { hidden: true },
          handler: () => text(page, { headers: HTML }),
        })
      }

      api.hooks.onInit(() => {
        document = generateOpenApi(
          {
            routes: api.getRoutes(),
            plugins: api.getPlugins(),
            publicBasePath: api.publicBasePath,
          },
          { ...settings, onWarning: (message) => api.logger.warn(message) }
        )
        body = JSON.stringify(document)
      })
    },
  })
}
