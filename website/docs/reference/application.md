# Application

`createApp()` and the object it returns. For an introduction, see [How it works](/concepts/how-it-works#the-app).

## createApp()

```ts
import { createApp } from '@dotpress/core'

function createApp(options: AppOptions): Promise<App>
```

`createApp()` sets up the plugins, compiles the routes, runs the `onInit` hooks, mounts the routes on the adapter, then runs the `onReady` hooks. It does not start a server: call `app.listen()`, or hand the app to a serverless handler.

### Options

Unknown options are rejected, like those of every Dotpress function: see [Options and durations](/concepts/options).

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `adapter` | `HttpAdapter` | required | The HTTP adapter: [Express, Fastify, Hono, AWS Lambda](/adapters/). |
| `routers` | `Router[]` | `[globalRouter]` | The routers to mount. Without it, the routes declared with `defineRoute()`. See [Routers](/routing/routes#routers). |
| `plugins` | `Plugin[]` | `[]` | Set up in the given order, dependencies first. See [Plugin API](./plugins). |
| `middlewares` | `Middleware[]` | `[]` | Run on every route, after the plugin middlewares, before the group and route middlewares. |
| `responseFilters` | `ResponseFilter[]` | `[]` | Applied to every successful JSON result, before the plugin and router filters. |
| `basePath` | `string` | — | Prefix of every route, plugin routes included, when the proxy forwards the full path. |
| `publicBasePath` | `string` | — | Prefix removed by the proxy: routes are not prefixed, but `publicPath()` is. Cannot be combined with `basePath`. |
| `cors` | `CorsOptions` | disabled | Answers cross-origin requests. See [CORS options](#cors-options). |
| `logger` | `Logger` | console logger | Any logger with the [`Logger`](#logger) interface, Pino included. |
| `exposeErrors` | `boolean` | `false` | Adds the name, message and stack of unexpected errors to `500` responses. Never in production. |
| `generateRequestId` | `(req: DotpressRequest) => string` | `crypto.randomUUID()` | The ID of each request, sent as `X-Request-ID`: `(req) => req.header('x-request-id') ?? crypto.randomUUID()` keeps the one of a proxy. |
| `onError` | `(error: unknown, ctx: RequestContext \| undefined) => void \| Promise<void>` | — | Called with every unexpected error (anything but an `HttpError`). `ctx` is undefined outside a route. |

The body size limit is an option of the adapter (`bodyLimit`, 1 MiB by default), or of a route. See [Common options](/adapters/#common-options).

### Startup errors

`createApp()` rejects, instead of starting with a wrong configuration, when:

- `adapter` is missing;
- `basePath` and `publicBasePath` are both set, or one is not a valid path;
- two routes have the same method and path (`Route conflict: "GET /articles/:id" is already defined…`);
- a plugin is installed twice, depends on a plugin that is not installed, or the dependencies are circular;
- two plugins provide the same context key;
- the `cors` option is invalid, for instance `origin: '*'` with `credentials: true`;
- a `setup()`, `onInit` or `onReady` hook throws.

Route definitions are checked when they are declared: a path with unsupported syntax, an unknown method or an invalid `status` throws at `defineRoute()`.

## App

| Member | Description |
| --- | --- |
| `listen(port, host?)` | Starts the server, and returns `{ port, host }`: the actual port with `listen(0)`. Not available on serverless adapters. |
| `close()` | Stops the server, waits for the pending requests and closes the streamed responses, then runs the `onClose` hooks of the plugins, last plugin first. Rejects with the first failing hook, after running them all. |
| `routes` | The mounted routes (`RouteInfo[]`), with the base path: method, path, path parameters, schemas, metadata, security, status. |
| `plugins` | The installed plugins, in setup order. |
| `basePath`, `publicBasePath` | The normalized options, or `''`. |
| `publicPath(path)` | The path seen by the browser: `app.publicPath('/login')` gives `'/my-app/api/login'` with a base path. |
| `logger` | The logger of the app. |
| `adapter` | The adapter given to `createApp()`. |
| `native()` | The native application of the adapter: Express app, Fastify instance, Hono app. |

```ts
const app = await createApp({ adapter: expressAdapter(), routers, plugins })
await app.listen(3000)

process.once('SIGTERM', () => void app.close())
```

## CORS options

```ts
cors: {
  origin: ['https://app.example.com', /\.example\.com$/],
  credentials: true,
  exposedHeaders: ['X-Request-ID'],
  maxAge: 600,
}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `origin` | see below | required | The allowed origins. |
| `credentials` | `boolean` | `false` | Allows cookies and `fetch()` with `credentials: 'include'`. Not with `origin: '*'`. |
| `allowedHeaders` | `string[]` | the requested headers | Request headers allowed by preflight responses. |
| `exposedHeaders` | `string[]` | none | Response headers readable by the browser, besides the safelisted ones. |
| `maxAge` | `number` | — | How long browsers cache preflight responses, in seconds. |

`origin` accepts `'*'` (any origin, without credentials), an origin (`'https://app.example.com'`), a regular expression, a list of origins and regular expressions, or a function `(origin, req) => boolean | Promise<boolean>`, where `req` is the request (`req.header()`, `req.path`…).

See [CORS](/routing/http-options#cors) for preflight requests and error responses.

## Logger

```ts
interface Logger {
  debug: LogFn
  info: LogFn
  warn: LogFn
  error: LogFn
  child(bindings: Record<string, unknown>): Logger
}

interface LogFn {
  (message: string, ...args: unknown[]): void
  (data: object, message?: string, ...args: unknown[]): void
}
```

The signature is the one of Pino: `logger: pino()` works as is. The default logger writes to the `console`:

```ts
import { createConsoleLogger } from '@dotpress/core'

const logger = createConsoleLogger({ level: 'debug', bindings: { service: 'api' } })
```

| Option | Default | Description |
| --- | --- | --- |
| `level` | `'info'` | `debug`, `info`, `warn` or `error`. |
| `bindings` | `{}` | Fields added to every entry. |

See [Logging](/routing/logging).

## For adapter authors

An adapter implements the `HttpAdapter` contract of `@dotpress/core`, with the `NormalizedRequest` and `NormalizedResponse` types. The rest of what it needs comes from `@dotpress/core/adapter`, which applications do not need:

```ts
import {
  createRouteMatcher,
  parseQueryString,
  parseRequestBody,
  type CompiledRoute,
  type DotpressRuntime,
} from '@dotpress/core/adapter'
```

| Export | Description |
| --- | --- |
| `CompiledRoute`, `DotpressRuntime` | The routes to mount, and the responses for requests that match none. |
| `createRouteMatcher()` | Matches a request to a route, with the rules of every adapter. |
| `parseQueryString()`, `parseRequestBody()`, `DEFAULT_BODY_LIMIT` | The query and the body, limited to 1 MiB by default. |
| `malformedBodyError()`, `payloadTooLargeError()`, `unsupportedMediaTypeError()` | The errors of an unreadable body. |
| `fromWebRequest()`, `readRequestBody()`, `toWebResponse()` | For adapters built on the Web `Request` and `Response`. |

The rules every adapter follows are documented on the `HttpAdapter` interface, and checked by the [conformance suite](/services/testing#writing-an-adapter).
