# @dotpress/cache

Caching for [Dotpress](https://dotpress.dev), at two levels:

- **memo**: values loaded once per unit of work (an HTTP request, an event message, a job), shared by every function that needs them, with single flight and batching;
- **cache**: values kept across requests and instances, in interchangeable stores (coming next).

Works without a Dotpress app: in a script, a worker or a Lambda function.

> 🚧 Dotpress V2 is under active development and not published yet.

```sh
pnpm add @dotpress/cache
```

## Memo

A middleware, a route handler and a service all need the current user: with a memo, it is loaded once per request.

```ts
import { createMemo, defineMemo } from '@dotpress/cache'

export const loadUser = defineMemo({
  name: 'user',
  load: (id: string) => db.users.findById(id),
})

const memo = createMemo() // one per request, message or job
const user = await memo(loadUser, id) // loads
const same = await memo(loadUser, id) // memoized
```

- **Single flight**: calls made while a value loads share the same load. Three parallel calls with the same id make one query.
- **Failures are shared, not kept**: the calls in progress fail together, and the next call loads again.
- **Keys**: the arguments are compared by value (strings, numbers, booleans, `null`, `undefined`, bigints, dates, arrays, plain objects; the order of object properties does not matter). For other arguments, add a `key` option that returns a string: `key: (user) => user.id`.
- **Updates**: `memo.set(loadUser, id, user)` after an update, `memo.delete(loadUser, id)` to load again, `memo.clear(loadUser)` or `memo.clear()`.

A memo lives as long as its unit of work: create one per request, per event message, per job, never one per process (it would grow forever and serve old values). Values shared across requests belong in the cache.

Values are the objects returned by `load`, not copies: a caller that mutates one changes it for the others.

### Batching

With `batch` instead of `load`, the keys requested in the same tick are loaded in one call: no N+1 queries when a list renders the author of each item.

```ts
export const loadAuthor = defineMemo({
  name: 'author',
  // A Map by id: missing ids give undefined.
  batch: async (ids: readonly string[]) => {
    const users = await db.users.findManyById(ids)
    return new Map(users.map((user) => [user.id, user]))
  },
  maxBatchSize: 100, // optional: keys per call
})

const authors = await Promise.all(posts.map((post) => memo(loadAuthor, post.authorId))) // one query
```

`batch` receives the keys without duplicates, and returns either a `Map` by key, or an array of values in the order of the keys, where an `Error` fails its key only. An array of the wrong length fails every key with a `MemoBatchError`.

Keys requested before the batch runs join it: it runs on a timer (`setTimeout(run, 0)`), after the code that requested them, awaits included. Replace it with `schedule: (run) => …`. Keys requested once it has started go to the next batch.

## Errors

| Error | Thrown when |
| --- | --- |
| `CacheError` | Base class of the errors of the package |
| `MemoBatchError` | `batch` returned values that do not match the keys (`memo`: name of the memo) |

Invalid options and arguments throw a `TypeError` that names the option.

## License

MIT
