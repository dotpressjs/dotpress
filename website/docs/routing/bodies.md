# Bodies and file uploads

Dotpress reads and parses request bodies itself, the same way on every adapter. Validate them with the `body` and `files` schemas of the route (see [Validation](./validation)).

## Content types

| `Content-Type` | `req.body` |
| --- | --- |
| `application/json`, `*+json` | the parsed JSON |
| `application/x-www-form-urlencoded` | a record of strings, arrays for repeated keys |
| `multipart/form-data` | the text fields, like a form; the files are in `req.files` |
| `text/*` | a string, decoded with the declared charset (UTF-8 by default) |
| anything else | the bytes, as a `Uint8Array` |
| no body | `undefined` |

A body that cannot be parsed (invalid JSON, invalid UTF-8, broken multipart) gets `400 MALFORMED_BODY`. A compressed body (`Content-Encoding: gzip`…) or an unknown charset gets `415 UNSUPPORTED_MEDIA_TYPE`.

## Body size limit

Bodies are limited to **1 MiB** by default. A larger body gets `413 PAYLOAD_TOO_LARGE`: reading stops as soon as the declared length, or the bytes read, exceed the limit.

Change the limit for the whole app with the `bodyLimit` option of the adapter, or for one route with its own `bodyLimit`:

```ts
const app = await createApp({ adapter: expressAdapter({ bodyLimit: 256 * 1024 }) })

defineRoute({
  method: 'post',
  path: '/imports',
  bodyLimit: 20 * 1024 * 1024, // 20 MiB, for this route only
  handler,
})
```

Keep the default limit low, and raise it only on the routes that need it: a large limit everywhere lets any client make the server read large bodies.

## File uploads

`multipart/form-data` bodies are parsed by Dotpress, on every adapter, without Multer or another dependency. Files are Web [`File`](https://developer.mozilla.org/docs/Web/API/File) objects, validated by the `files` schema with Zod:

```ts twoslash
import { defineRoute } from '@dotpress/core'

declare const storage: { put(key: string, bytes: Uint8Array, type: string): Promise<string> }
// ---cut---
defineRoute({
  method: 'post',
  path: '/profile/avatar',
  bodyLimit: 3 * 1024 * 1024,
  schema: (z) => ({
    files: z.object({
      avatar: z.file().max(2 * 1024 * 1024).mime(['image/png', 'image/jpeg']),
    }),
    body: z.object({ alt: z.string().max(200).optional() }),
  }),
  handler: async ({ req }) => {
    const { avatar } = req.files
    const bytes = new Uint8Array(await avatar.arrayBuffer())
    const url = await storage.put(`avatars/${crypto.randomUUID()}`, bytes, avatar.type)
    return { url, alt: req.body.alt }
  },
})
```

- `req.files.avatar` is a `File`: `name`, `type`, `size`, `arrayBuffer()`, `stream()`, `text()`.
- The text fields of the form are in `req.body`, validated by the `body` schema.
- An invalid file gets the standard `400 VALIDATION_FAILED`, with `source: 'files'` issues.
- Files count toward the body limit: raise `bodyLimit` on upload routes.
- Files are kept in memory: for very large files, upload them directly to object storage (a presigned URL) rather than through the API.

:::warning Check what you accept
The `type` of a file and its name are sent by the client: they can lie. Limit the size and the types with the schema, generate the storage name yourself, and never serve uploaded files from the domain of your app without a `Content-Type` you control.
:::

### Several files

A field sent several times gives an array. `arrayOf()` always gives an array, whether the field is sent once or several times:

```ts twoslash
import { arrayOf, defineRoute } from '@dotpress/core'
// ---cut---
defineRoute({
  method: 'post',
  path: '/albums/:id/photos',
  bodyLimit: 50 * 1024 * 1024,
  schema: (z) => ({
    files: z.object({
      photos: arrayOf(z.array(z.file().mime(['image/jpeg'])).max(10)),
    }),
  }),
  handler: ({ req }) => ({ count: req.files.photos.length }),
})
```

## Raw bodies for webhooks

Webhook providers sign the exact bytes they send. Declare `rawBody: true` to receive them in `req.rawBody`, in addition to the parsed `req.body`:

```ts twoslash
import { defineRoute, unauthorizedError } from '@dotpress/core'

declare const verifySignature: (payload: Uint8Array, signature: string | undefined) => Promise<boolean>
// ---cut---
defineRoute({
  method: 'post',
  path: '/webhooks/payments',
  rawBody: true,
  schema: (z) => ({ body: z.object({ type: z.string(), id: z.string() }) }),
  handler: async ({ req }) => {
    if (!(await verifySignature(req.rawBody, req.header('x-signature')))) {
      return unauthorizedError('Invalid signature')
    }
    return { received: req.body.id }
  },
})
```

`req.rawBody` is a `Uint8Array`, typed only on routes declared with `rawBody: true`. With Express, do not register a native body parser (`express.json()`) for these routes: the adapter must read the body itself.

:::tip Coming from v1
Multer is no longer used: the `files` option and `getFile()` are replaced by a `files` schema and `req.files`, with Web `File` objects. The default body limit is 1 MiB (Dotpress 1: 100 KB).
:::
