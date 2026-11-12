# Validation

Any input of an API must be checked: it comes from clients you do not control. In Dotpress, each route declares the [Zod](https://zod.dev) schemas of its inputs, and the framework:

- parses and validates the request before the handler runs;
- answers `400` with every issue found, when the request is invalid;
- gives the handler the parsed values, typed from the schemas.

```ts twoslash
import { defineRoute } from '@dotpress/core'
// ---cut---
defineRoute({
  method: 'post',
  path: '/members',
  schema: (z) => ({
    body: z.object({
      name: z.string().trim().min(1),
      age: z.number().int().min(13),
      location: z.string().optional(),
    }),
  }),
  handler: ({ req }) => ({ received: req.body }),
})
```

## What can be validated

| Schema | Validates | Typed as |
| --- | --- | --- |
| `params` | Path parameters (strings) | `req.params` |
| `query` | Query string | `req.query` |
| `body` | Request body: JSON, form fields, text | `req.body` |
| `files` | Uploaded files, `multipart/form-data` | `req.files` |
| `response` | The value returned by the handler | the return type of the handler |

```ts twoslash
import { defineRoute } from '@dotpress/core'
// ---cut---
defineRoute({
  method: 'put',
  path: '/orgs/:orgId/users/:userId',
  schema: (z) => ({
    params: z.object({ orgId: z.uuid(), userId: z.uuid() }),
    query: z.object({ notify: z.stringbool().default(false) }),
    body: z.object({ email: z.email(), name: z.string() }),
  }),
  handler: ({ req }) => ({ ...req.params, ...req.body, notify: req.query.notify }),
})
```

Without a `params` schema, path parameters are still typed, as strings, [from the path](/concepts/typing#path-parameters-come-from-the-path). Without a `query` schema, `req.query` holds the raw strings (arrays for repeated keys); without a `body` schema, `req.body` is `unknown`: check it before use.

## When validation fails

The request never reaches the handler. The client gets a `400` with every issue, each with its source:

```json
{
  "status": 400,
  "error": "VALIDATION_FAILED",
  "message": "Validation failed",
  "data": {
    "issues": [
      {
        "source": "query",
        "path": ["notify"],
        "code": "invalid_value",
        "message": "Invalid option: expected one of \"true\"|\"1\"|\"yes\"|\"on\"|\"y\"|\"enabled\"|\"false\"|\"0\"|\"no\"|\"off\"|\"n\"|\"disabled\""
      },
      {
        "source": "body",
        "path": ["age"],
        "code": "too_small",
        "message": "Too small: expected number to be >=13"
      }
    ]
  }
}
```

The `code` and `message` of each issue come from Zod: a client can display them, or map the codes to its own messages.

Validation runs after the [middlewares](./middlewares): a request rejected by the authentication middleware gets its `401`, whatever its body.

## Query strings and forms

A query string only carries strings, and a key sent several times gives an array. Coerce the values with Zod:

| Query | Schema | Value |
| --- | --- | --- |
| `?page=2` | `z.coerce.number()` | `2` |
| `?done=true` | `z.stringbool()` | `true` (also `1`, `yes`, `on`; `false`, `0`, `no`, `off` for `false`) |
| `?tag=a&tag=b` | `arrayOf(z.string())` | `['a', 'b']` |
| `?tag=a` | `arrayOf(z.string())` | `['a']` |

`arrayOf()`, from `@dotpress/core`, always gives an array, whether the key is sent once or several times:

```ts twoslash
import { arrayOf, defineRoute } from '@dotpress/core'
// ---cut---
defineRoute({
  path: '/articles',
  schema: (z) => ({
    query: z.object({ tag: arrayOf(z.string()).default([]) }),
  }),
  handler: ({ req }) => ({ tags: req.query.tag }),
})
```

Nested keys such as `filter[status]=open` are not expanded into objects: the key is `filter[status]`. URL-encoded form bodies follow the same rules.

## Validating the response

A `response` schema checks the value returned by the handler:

```ts twoslash
import { defineRoute } from '@dotpress/core'
import { z } from 'zod'

declare const users: {
  find(id: string): Promise<{ id: string; email: string; passwordHash: string }>
}
// ---cut---
const User = z.object({ id: z.string(), email: z.email() })

defineRoute({
  path: '/users/:id',
  schema: () => ({ response: User }),
  handler: async ({ req }) => users.find(req.params.id),
})
```

- **At compile time**, the handler must return a value matching the schema, or an error.
- **At runtime**, the value is parsed by the schema: fields that are not in it, such as `passwordHash` here, are removed. The response cannot leak them, even when the database returns more than expected.
- A value that does not match is a bug of the API: the client gets a `500`, and the issues are logged.

The response schema also documents the route in the [OpenAPI document](/services/openapi). Give it an `id` with `.meta({ id: 'User' })` to declare it once in the document and reference it everywhere.

A route that returns nothing answers `204 No Content`. A `response: z.never()` schema makes it explicit, and rejects any returned value.

## Tips

- **Transform while you validate**: `.trim()`, `.toLowerCase()`, `.transform()` and defaults apply before the handler runs. The handler gets the clean value.
- **Cross-field rules** go in `.refine()` or `.superRefine()` on the object schema.
- **Reuse schemas**: declare them once in a module, and use them in several routes and in the tests.
- **Prototype without schemas**, then add them: the types of the handler follow.

:::tip Coming from v1
The `params: ['id']` shorthand is gone: path parameters are typed from the path. Validation errors now use the [standard error format](/concepts/errors#one-format-for-every-error), with one flat list of issues. Dotpress 2 uses Zod 4.
:::
