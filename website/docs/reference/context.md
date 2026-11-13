# Request context

The `ctx` object received by middlewares and handlers, and its `req` and `res`. For an introduction, see [The request context](/concepts/context).

## RequestContext

| Key | Type | Description |
| --- | --- | --- |
| `req` | `DotpressRequest` | The request: see [req](#req). |
| `res` | `DotpressResponse` | The status, headers and cookies of the response: see [res](#res). |
| `requestId` | `string` | The ID of the request, also sent in the `X-Request-ID` header. |
| `logger` | `Logger` | A logger bound to the request: every line carries the `requestId`. |
| `raw` | `unknown` | The native request of the adapter (Express `req`, Fastify request, Hono context, Lambda event). An escape hatch. |
| `publicPath(path)` | `(path: string) => string` | The path seen by the browser, with the `basePath` or `publicBasePath` of the app. |

In a handler, `ctx` also holds the properties guaranteed by the [typed middlewares](./routes#definemiddleware) of the route and its groups.

## Keys added by plugins

| Key | Type | Plugin |
| --- | --- | --- |
| `user` | `AuthUser \| undefined` | [`authPlugin`](/auth/): the authenticated user. Typed `AuthUser` after `requireAuth`. |
| `auth` | `AuthSession \| undefined` | `authPlugin`: the token of the user, `userId`, `username`, `tokenId`, `sessionId`, `clientId`, `roles`, `claims`. Typed `AuthSession` after `requireAuth`. |
| `memo` | `Memo` | [`cachePlugin`](/services/cache): the memo of the request. |
| `cache` | `Cache` | `cachePlugin({ cache })`: the cache, with the request logger. |
| `events` | `EventBus` | [`eventsPlugin`](/services/events): the bus, with the request logger and `requestId`. |
| `mailer` | `Mailer` | [`mailerPlugin`](/services/mailer): the mailer, with the request logger. |

Plugin keys are computed on first access, at most once per request. Using the key of a plugin that is not installed throws:

```text
"ctx.mailer" is used, but the "mailerPlugin" plugin is not installed in createApp().
```

## req

| Member | Type | Description |
| --- | --- | --- |
| `method` | `string` | Uppercase: `'GET'`, `'POST'`… |
| `path` | `string` | Without the query string. |
| `url` | `string \| undefined` | The full URL, when the adapter knows it. |
| `params` | typed | Path parameters: from the path, or from `schema.params`. |
| `query` | typed | Query string: `Record<string, string \| string[]>` without schema, repeated keys giving arrays. |
| `body` | typed | The parsed body: `unknown` without schema, `undefined` when there is none. |
| `files` | typed | Files of a `multipart/form-data` body, as `File` objects. Empty otherwise. |
| `headers` | `Record<string, string \| undefined>` | Lowercase names. Repeated headers are joined with `, `. |
| `header(name)` | `(name: string) => string \| undefined` | A header, case-insensitive. |
| `cookies` | `Record<string, string>` | The cookies of the request, decoded. |
| `ip` | `string \| undefined` | The client address, as given by the server. Proxy headers count only when the server trusts them. See [Client IP address](/routing/http-options#client-ip-address-behind-a-proxy). |
| `rawBody` | `Uint8Array \| undefined` | The raw bytes of the body, on `rawBody: true` routes only (`Uint8Array` there). |
| `signal` | `AbortSignal` | Aborted when the client disconnects: pass it to long work. |

:::warning Middlewares see the raw request
Middlewares run before validation: `ctx.req.params`, `query` and `body` hold the raw values, typed as such. Handlers receive the parsed values.
:::

Request bodies are parsed by content type: JSON (`application/json`, `*+json`), forms (`application/x-www-form-urlencoded`, `multipart/form-data`), text (`text/*`, as a string), anything else as bytes. See [Bodies and file uploads](/routing/bodies).

## res

`ctx.res` never writes the body: the handler returns it. Every method returns `res`, so calls can be chained.

| Member | Description |
| --- | --- |
| `setStatus(status)` | The status of the response, between 100 and 599. |
| `statusCode` | The status set with `setStatus()`, or `undefined`. |
| `setHeader(name, value)` | Sets a header, replacing its values. `value` can be an array. |
| `appendHeader(name, value)` | Adds a value to a header. |
| `getHeader(name)` | A header set on the response. |
| `removeHeader(name)` | Removes a header. |
| `setCookie(name, value, options?)` | Adds a `Set-Cookie` header. The value is URI-encoded. |
| `clearCookie(name, options?)` | Expires a cookie. Pass the same `path` and `domain` as when it was set. |

Headers and cookies set on `res` are kept on the response, including an `HttpError` returned or thrown later; an unexpected error gives a `500` without them.

### Status

The status of a JSON response is, in this order: the `status` of `json(data, { status })`, then `res.setStatus()`, then the `status` of the route, then `200`. A handler returning `undefined` gets `204`, unless a status is set.

### Cookie options

```ts
ctx.res.setCookie('session', token, {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  maxAge: 60 * 60 * 24 * 7,
})
```

| Option | Type | Description |
| --- | --- | --- |
| `httpOnly` | `boolean` | Hidden from JavaScript in the browser. Use it for every session cookie. |
| `secure` | `boolean` | Sent over HTTPS only. |
| `sameSite` | `'strict' \| 'lax' \| 'none'` | When the browser sends the cookie with cross-site requests. `'none'` requires `secure`. |
| `maxAge` | `number` | Lifetime, in seconds. |
| `expires` | `Date` | Expiry date. |
| `path` | `string` | `/` by default. |
| `domain` | `string` | Domain of the cookie. Without it, the host only. |
| `partitioned` | `boolean` | A partitioned cookie (CHIPS). |
| `priority` | `'low' \| 'medium' \| 'high'` | Priority of the cookie. |

See [Cookies](/routing/http-options#cookies), and [Cookie mode](/auth/cookies) for authentication.

## Extending the context

Declare a key with module augmentation, then provide it from a plugin with `api.decorateContext()`, or set it in a middleware:

```ts
declare module '@dotpress/core' {
  interface RequestContext {
    services: AppServices
  }
}

declareContextKey('services', 'servicesPlugin')
```

`declareContextKey(key, pluginName)` makes the key throw an explicit error when the plugin is not installed. The keys of the core (`req`, `res`, `requestId`, `logger`, `raw`, `publicPath`) cannot be decorated. See [Adding your own keys](/concepts/context#adding-your-own-keys).
