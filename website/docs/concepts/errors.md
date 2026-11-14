# Returned errors

In Dotpress, an error is a value: a handler or a middleware **returns** it, like any other result.

```ts twoslash
import { defineRoute, conflictError, notFoundError } from '@dotpress/core'

declare const invoices: {
  find(id: string): Promise<{ id: string; status: 'draft' | 'paid' } | undefined>
  markAsPaid(id: string): Promise<{ id: string; status: 'paid' }>
}
// ---cut---
defineRoute({
  method: 'post',
  path: '/invoices/:id/pay',
  handler: async ({ req }) => {
    const invoice = await invoices.find(req.params.id)
    if (!invoice) return notFoundError('Invoice not found')
    if (invoice.status === 'paid') return conflictError('Invoice already paid')
    return invoices.markAsPaid(invoice.id)
  },
})
```

The control flow stays visible: every way out of the handler is a `return`, readable from top to bottom. There is no exception to catch elsewhere, and no error class to declare.

## One format for every error

Every error response has the same shape, whoever produced it: your handler, a middleware, the validation, the router or an unexpected exception.

```json
{
  "status": 404,
  "error": "NOT_FOUND",
  "message": "Invoice not found"
}
```

| Field | Content |
| --- | --- |
| `status` | The HTTP status, also the status of the response |
| `error` | A stable code, for the clients to test |
| `message` | A message for humans |
| `data` | Optional details, such as the issues of a failed validation |

Clients handle every error of the API with one piece of code.

## The helpers

| Helper | Status | Code |
| --- | --- | --- |
| `badRequestError()` | 400 | `BAD_REQUEST` |
| `unauthorizedError()` | 401 | `UNAUTHORIZED` |
| `forbiddenError()` | 403 | `FORBIDDEN` |
| `notFoundError()` | 404 | `NOT_FOUND` |
| `conflictError()` | 409 | `CONFLICT` |
| `unprocessableError()` | 422 | `UNPROCESSABLE_ENTITY` |
| `tooManyRequestsError()` | 429 | `TOO_MANY_REQUESTS` |
| `internalError()` | 500 | `INTERNAL_ERROR` |

Each takes an optional message, and options: `data`, details added to the body, and `cause`, the original error. For any other case, `errorResponse()` takes a status, a code, a message and the same options:

```ts
return errorResponse(422, 'INVALID_TRANSITION', 'A paid invoice cannot be cancelled', {
  data: { status: 'paid' },
})
```

## Thrown errors work too

Returning is the convention, but a thrown `HttpError` gives the same response, from a handler, a middleware or a helper of the routes.

Services do not throw `HttpError`: they throw their own business errors, and the handler translates them into the HTTP error the client receives. See [Errors of your services](/routing/errors#errors-of-your-services).

## Unexpected errors

Anything else that is thrown, a bug or a database failure, is an unexpected error:

- the client gets a `500 INTERNAL_ERROR`, without details, so that nothing internal leaks;
- the error is logged with the request ID, and passed to the `onError` hook of the app and of the plugins, to report it (Sentry, for instance).

In development, `createApp({ exposeErrors: true })` adds the message and the stack of the error to the `500` responses. Never enable it in production.

See [Errors](/routing/errors) for the errors produced by Dotpress itself (`404`, `405`, `413`…) and for error reporting, and [the design decision](/reference/design-decisions/returned-errors) for the reasons behind this choice.
