# Errors are returned

## Context

An API spends much of its code on refusals: the resource does not exist, the user may not see it, the input conflicts with the data. These are not exceptional: they are expected outcomes of a request, as much as a success.

With exceptions as the only way out, the control flow of a handler is hidden: a `throw` deep in a service ends the request, and nothing in the handler shows it. HTTP frameworks also disagree on what happens next: Express 4 loses errors thrown by `async` handlers unless they are passed to `next()`, each framework has its own error handlers, and each app ends up with its own error format.

## Decision

- **An error is a value.** `notFoundError()`, `forbiddenError()` and the other helpers return an `HttpError`, and a handler or a middleware returns it: `return notFoundError('Task not found')`.
- **Throwing gives the same response.** An `HttpError` thrown by a handler, a middleware or a helper of the HTTP layer is answered exactly like a returned one.
- **Services never throw an `HttpError`.** An HTTP error belongs to the HTTP layer. Services throw their own business errors, and the handler translates them into the response.
- **Anything else thrown is a bug.** It is answered `500 INTERNAL_ERROR`, logged, and passed to `onError`. Its details stay out of the response, unless `exposeErrors` is enabled.
- **One format for every error**: `{ status, error, message, data? }`, whether it comes from the handler, the validation, the router (`404`, `405`) or the body parser.

```ts
handler: async ({ req, user }) => {
  const task = await tasks.find(req.params.id)
  if (!task) return notFoundError('Task not found')
  if (task.ownerId !== user.id) return forbiddenError()
  return task
}
```

## Business errors and HTTP errors

A failed request can involve three different errors, and Dotpress keeps them apart:

| Error | Example | Raised by | Becomes |
| --- | --- | --- | --- |
| **Business error** | the task is already completed, the balance is insufficient | the service, as its own error class | the HTTP error the handler chooses |
| **Process error** | the database is down, a timeout, a bug | anything | `500 INTERNAL_ERROR`, logged, passed to `onError` |
| **HTTP error** | `409 CONFLICT`, `Task already completed` | the handler, or a middleware | the response the client receives |

A service knows the rules of the domain, not HTTP. It signals an expected outcome by its return value (`undefined` when nothing is found), and a broken rule by a business error:

```ts twoslash
import { conflictError, defineRoute, notFoundError } from '@dotpress/core'

interface Task {
  id: string
  completedAt: Date | null
}
declare const db: {
  tasks: {
    find(id: string): Promise<Task | undefined>
    update(id: string, changes: Partial<Task>): Promise<Task>
  }
}
// ---cut---
// services/tasks.ts: no HTTP here
export class TaskAlreadyCompletedError extends Error {}

export const completeTask = async (id: string) => {
  const task = await db.tasks.find(id)
  if (!task) return undefined
  if (task.completedAt) throw new TaskAlreadyCompletedError(id)
  return db.tasks.update(id, { completedAt: new Date() })
}

// routes/tasks.ts: the HTTP translation
defineRoute({
  method: 'post',
  path: '/tasks/:id/complete',
  handler: async ({ req }) => {
    try {
      const task = await completeTask(req.params.id)
      return task ?? notFoundError('Task not found')
    } catch (error) {
      if (error instanceof TaskAlreadyCompletedError) return conflictError('Task already completed')
      throw error // a process error: 500, reported by onError
    }
  },
})
```

Returning the HTTP error is what makes the separation visible: the handler is the one place where a business error becomes a response, with a status, a stable code, and a message chosen to be shown to the client.

## Alternatives considered

- **Exceptions only**, with exception filters, as in NestJS. Familiar, but the exits of a handler are invisible, and a middleware cannot stop a request without throwing.
- **A `Result` type** (`ok(value)` / `err(error)`), as in functional libraries. Explicit, but every call must be unwrapped, and it spreads to every service. Returning an `HttpError` gets the readability without the ceremony: a value is a success, an `HttpError` is a refusal.
- **The error handlers of the HTTP server.** They differ from one server to another, and would tie the app to one of them.

## Consequences

- Handlers read as guard clauses: each refusal is an early `return`, visible where it happens.
- A middleware stops a request the same way: by returning an error, or a response such as `redirect()`.
- Services stay free of HTTP: they run unchanged in a worker, a script or a test, and their errors describe the domain, not a status.
- The client only sees messages chosen for it: the message of a business or process error never reaches the response by accident.
- A business error the handler does not translate is a `500`, reported by `onError`: a forgotten case is treated as the bug it is, without leaking anything.
- The translation is written in the handlers: a `try`/`catch`, or a function shared by the routes of a feature. Dotpress has no global mapping from business errors to HTTP errors.
- Clients parse one error format, and the `error` code is stable: they can rely on it rather than on messages.
- The return type of a handler does not list its errors, and a returned error skips the response schema. Document the errors of a route in `meta.responses`, for [OpenAPI](/services/openapi).

See [Errors](/concepts/errors), [Errors of your services](/routing/errors#errors-of-your-services) and the [error reference](../responses#error-helpers).
