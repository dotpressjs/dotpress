# OpenAPI

The functions, options and command of `@dotpress/openapi`. For a guide, see [OpenAPI and API docs](/services/openapi).

## openapiPlugin()

```ts
import { openapiPlugin } from '@dotpress/openapi'

const docs = openapiPlugin({ info: { title: 'Tasks API', version: '1.0.0' } })
await createApp({ adapter, plugins: [docs] })
```

Serves the document of the app, and an API reference page (Scalar). Unknown options are rejected.

| Option | Default | Description |
| --- | --- | --- |
| `info` | required | `title` and `version`, and the other fields of the OpenAPI `info` object. |
| `servers` | the public base path of the app | The servers of the document. |
| `tags` | — | Descriptions of the tags used by the routes (`meta.tags`). |
| `externalDocs` | — | A link to external documentation. |
| `securitySchemes` | — | Security schemes, added to those of the plugins (`AUTH_SECURITY_SCHEMES` of the auth plugin). |
| `path` | `'/openapi.json'` | The path of the document. |
| `ui` | `{ path: '/docs' }` | The API reference page, or `false` to serve the document only. |
| `middlewares` | `[]` | Middlewares of the document and page routes, for instance `requireRole('admin')`. |

| `ui` option | Default | Description |
| --- | --- | --- |
| `path` | `'/docs'` | The path of the page. |
| `title` | `info.title` | The title of the page. |
| `configuration` | `SCALAR_NEUTRAL_CONFIGURATION` | The [Scalar configuration](https://guides.scalar.com/scalar/scalar-api-references/configuration), merged with the neutral one. |
| `cdnUrl`, `integrity` | a pinned version on jsDelivr, with its hash | The script of Scalar, to host it yourself. |

`docs.getDocument()` returns the document, once the app is created. The warnings of the generation (a scheme used but not declared, a schema without JSON representation) are logged by the plugin.

## generateOpenApi()

```ts
import { generateOpenApi } from '@dotpress/openapi'

const document = generateOpenApi(app, { info: { title: 'Tasks API', version: '1.0.0' } })
```

Returns the document of an app, or of a list of `RouteInfo` (`app.routes`). It takes the options of the plugin, except `path`, `ui` and `middlewares`, plus `onWarning(message)` (`console.warn` by default).

## dotpress-openapi

```sh
npx dotpress-openapi src/server.ts --out openapi.json
```

| Argument | Description |
| --- | --- |
| `<module>` | The module that creates the app, like the entry point of the server or of AWS Lambda; or a module exporting the app, or a function creating it. |
| `--export <name>` | The export to use, when the module does not create one app. Defaults to `default`, or to the only exported app or function. |
| `--out <file>` | Writes the document to a file, instead of the standard output. |
| `--title`, `--api-version` | `info` of the document, without `openapiPlugin()`. Default to the name and version of the `package.json` of the current directory. |
| `--help`, `-h` | Prints the usage. |

The module runs without starting a server: `app.listen()` opens no port, the factory of `createLambdaHandler()` is called right away, and what the module prints goes to the standard error. An exported function receives an adapter that mounts nothing, as its single argument (`createApp(adapter)` or `createApp({ adapter })`). With `openapiPlugin()` in the app, its document is used as is. The apps are closed afterwards, and the command exits with a non-zero code on failure.

## Types

`OpenApiDocument` and the types of its objects (`InfoObject`, `OperationObject`, `JsonSchema`…) describe the subset of OpenAPI 3.1 that Dotpress writes. They may gain optional fields in minor versions. `OpenApiSource` is what `generateOpenApi()` accepts: an app, or a list of `RouteInfo`.
