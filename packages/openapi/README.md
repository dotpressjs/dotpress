# @dotpress/openapi

OpenAPI 3.1 documents generated from the routes of a Dotpress app, with a [Scalar](https://scalar.com) API reference. No annotations: paths, parameters, bodies and responses come from the Zod schemas of the routes, security from their middlewares.

> 🚧 Dotpress V2 is in alpha (`2.0.0-alpha`): the API may still change before 2.0.0.

```ts
import { createApp } from '@dotpress/core'
import { openapiPlugin } from '@dotpress/openapi'

await createApp({
  adapter,
  plugins: [
    authPlugin(auth),
    openapiPlugin({ info: { title: 'My API', version: '1.0.0' } }),
  ],
})
// GET /openapi.json: the document
// GET /docs: the Scalar API reference
```

The document is generated once, when the app is created. Like `@dotpress/core`, the package only relies on Web-standard APIs.

## What is documented

| Source                                 | OpenAPI                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `path` (`/users/:id`)                  | path (`/users/{id}`), with the `basePath` of the app                                                         |
| `schema.params`, `schema.query`        | path and query parameters (object schemas). Path parameters without schema are strings.                      |
| `schema.body`                          | `application/json` request body, required unless the schema is optional                                      |
| `schema.files`                         | `multipart/form-data` request body, with the `body` fields                                                   |
| `schema.response`, `status`            | success response (`200` by default)                                                                          |
| `meta.responses`                       | other responses (see below)                                                                                  |
| middlewares, `meta.security`           | security requirements (see below)                                                                            |
| `meta.summary`, `description`, `tags`… | operation fields. `meta.hidden` excludes the route.                                                          |
| —                                      | standard errors: `400` with request schemas, `401` and `403` on secured routes, `500` (schema `DotpressError`) |

Request schemas are documented as the client sends them (Zod input: `z.coerce.number()` is a number, a field with a default is optional); response schemas as the API returns them (Zod output). Dates are ISO 8601 strings.

### Other responses

```ts
defineRoute({
  path: '/members/:id/export',
  meta: {
    responses: {
      200: { description: 'CSV export', contentType: 'text/csv' },
      404: 'Member not found',
      409: { description: 'Already exported', schema: ExportStatus },
    },
  },
  handler: ...,
})
```

An entry replaces the generated response of the same status.

### Security

A route is secured by the schemes its middlewares declare (`defineMiddleware(fn, { security: ['apiKey'] })`), including group and global middlewares; `requireAuth`, `requireRole()` and `requireClient()` of `@dotpress/auth` declare `bearerAuth`. `meta.security` overrides them, and `[]` marks a route as public.

Security schemes come from the installed plugins (`securitySchemes` property: `bearerAuth` for `@dotpress/auth`) and from the `securitySchemes` option. A scheme used by a route but not declared is reported as a warning.

### Reusable schemas

A Zod schema with an identifier is declared once in `components/schemas`, and referenced:

```ts
const Member = z.object({ id: z.string(), name: z.string() }).meta({ id: 'Member', description: 'A member' })
```

When the input and output of a schema differ (defaults, `additionalProperties: false` of the output of objects), the request side gets an `Input` variant: `Member` and `MemberInput`. Two different schemas with the same identifier fail the generation. Recursive schemas need an identifier.

## Plugin options

| Option            | Default                         | Description                                                                                                                                                   |
| ----------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `info`            | —                               | **Required.** `title`, `version`, and the other fields of the OpenAPI `info` object.                                                                          |
| `servers`         | the `publicBasePath` of the app | Servers of the document.                                                                                                                                      |
| `tags`            | —                               | Descriptions of the tags used by the routes.                                                                                                                  |
| `externalDocs`    | —                               | Link to external documentation.                                                                                                                               |
| `securitySchemes` | —                               | Security schemes, added to those of the plugins.                                                                                                              |
| `path`            | `/openapi.json`                 | Path of the document.                                                                                                                                         |
| `ui`              | `{ path: '/docs' }`             | Scalar page: `path`, `title` (`info.title`), `configuration` ([Scalar configuration](https://guides.scalar.com/scalar/scalar-api-references/configuration)), `cdnUrl`, `integrity`. `false` serves the document only. |
| `middlewares`     | `[]`                            | Middlewares of the document and page routes, for instance to restrict them.                                                                                   |

The page loads a pinned version of Scalar from jsDelivr, checked with Subresource Integrity. It is neutral by default (`SCALAR_NEUTRAL_CONFIGURATION`): no telemetry, no AI agent or MCP integration, no developer toolbar, no button to the Scalar API client, system fonts instead of fonts.scalar.com, and no "Powered by Scalar" link. `ui.configuration` overrides these settings, and its `customCss` is appended. Set `cdnUrl` to host the script yourself; with a strict Content Security Policy, the page also needs an inline script. Warnings (schemas without JSON representation, undeclared security schemes) are logged by the plugin logger.

Behind a reverse proxy, the URLs follow the `basePath` or `publicBasePath` of the app (see `@dotpress/core`).

## Command line

`dotpress-openapi` writes the document without starting the server, for instance to commit it or to generate clients in CI:

```sh
npx dotpress-openapi src/app.ts --export createApp --out openapi.json
```

The module exports the app (the result of `createApp()`), or a function creating it; `--export` chooses the export (`default` by default). The routes are mounted but no server is started, and the app is closed afterwards (`onClose` hooks). With `openapiPlugin()`, its document is used as is; otherwise, the document is generated with `--title` and `--api-version`, or the name and version of the `package.json` of the current directory. Without `--out`, the document is printed on the standard output. Warnings and errors go to the standard error, with a non-zero exit code on failure.

TypeScript modules are loaded with the type stripping of Node.js (22.18 or later): erasable syntax only, and relative imports ending in `.ts`. Otherwise, point to the compiled module, or run the command with `NODE_OPTIONS="--import tsx"`.

## Without the plugin

`generateOpenApi()` takes an app (or its routes) and returns the document, for instance to write it in CI:

```ts
import { generateOpenApi } from '@dotpress/openapi'

const app = await createApp({ adapter, plugins: [authPlugin(auth)] })
const document = generateOpenApi(app, { info: { title: 'My API', version: '1.0.0' } })
```

It accepts the same options as the plugin, except `path`, `ui` and `middlewares`, plus `onWarning` (default: `console.warn`).

## License

MIT
