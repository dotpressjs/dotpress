# @dotpress/cache

Caching for [Dotpress](https://dotpress.dev), at two levels:

- **memo**: values loaded once per unit of work (an HTTP request, an event message, a job), shared by every function that needs them, with single flight and batching;
- **cache**: values kept across requests and instances, in interchangeable stores, failing open when the store is down.

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

## Cache

```ts
import { createCache, createMemoryStore, defineCacheEntry } from '@dotpress/cache'
import { z } from 'zod'

export const userCache = defineCacheEntry({
  name: 'user',
  key: (id: string) => id,
  schema: z.object({ id: z.string(), name: z.string(), createdAt: z.coerce.date() }), // optional
  ttl: '1h',
})

const cache = createCache({ store: createMemoryStore(), prefix: 'app', ttl: '10m', logger })

const user = await cache.getOrSet(userCache, id, () => db.users.findById(id))
await cache.get(userCache, id) // undefined when missing or expired
await cache.set(userCache, id, user)
await cache.delete(userCache, id) // after an update
```

- **`getOrSet`** reads the value, or loads it with the last argument and caches it. Calls made while it loads share the load (single flight, per cache). A failed load is not cached: the error reaches the caller.
- **Keys**: `prefix:name:vVersion:key`, like `app:user:v1:42`. `key` returns a string, a number, or a value compared like the arguments of a memo; without `key`, the argument (or the arguments) is the key. Keys longer than the store accepts are hashed (SHA-256).
- **`version`** (1 by default) is part of the key: increase it when the shape of the values changes, and the values written by the previous version are ignored.
- **Durations**: a number of seconds, or a string: `'500ms'`, `'30s'`, `'10m'`, `'1h'`, `'7d'`. The `ttl` of an entry overrides the `ttl` of the cache (1 hour by default).
- **Types**: with a `schema`, the value type comes from it; without, `getOrSet` returns the type of the loader, and `get` returns `unknown`. `defineCacheEntry<[id: string], User>({ … })` declares it.
- **`withLogger(logger)`** returns the same cache with another logger (the logger of a request).

### Values

Values are serialized with JSON (or `serializer: { serialize, deserialize }`, like superjson). `undefined` is not cached; `null` is.

With a `schema`, every value read is validated: a value written by an older version of the app that no longer matches is a miss, not a crash. Values are also checked when written, as they will read back: JSON turns dates into strings, so `z.date()` fails and the value is not cached (with a warning), while `z.coerce.date()` works. `getOrSet` then returns the value as it reads back, so a cache hit and a miss return the same thing.

The memory store serializes too: it behaves like a shared store, and a caller cannot change a cached object.

### Store failures

The cache is an optimization: by default it **fails open**. When the store fails, a read is a miss (the loader runs), a write is skipped, and the app keeps working. Every failure is reported:

- a log: `warn` for reads and writes, `error` for deletions (a failed deletion may leave an outdated value), with the store, the operation, the key and the entry;
- `onError(error, { operation, key, entry })`, for metrics or alerts (its own errors are logged and ignored).

```ts
const cache = createCache({
  store,
  logger,
  onError: (error, { operation }) => metrics.increment('cache.store_error', { operation }),
  storeTimeout: '200ms', // a slower store counts as a failure
  failOpen: true, // false: throw a CacheStoreError instead
})
```

## Stores

| Store | Import | Use |
| --- | --- | --- |
| `createMemoryStore({ maxEntries })` | `@dotpress/cache` | memory of the process: one instance, development, tests. Least recently used entries are removed beyond `maxEntries` (10,000 by default) |

A store implements `CacheStore`: `name`, `get(key)`, `set(key, value, ttl)` (strings, `ttl` in milliseconds), `delete(key)`, and optionally `maxKeyLength` (bytes).

## Errors

| Error | Thrown when |
| --- | --- |
| `CacheError` | Base class of the errors of the package |
| `MemoBatchError` | `batch` returned values that do not match the keys (`memo`: name of the memo) |
| `CacheStoreError` | The store failed or timed out, with `failOpen: false` (`store`, `operation`, `key`, `cause`); also passed to `onError` |

Invalid options and arguments throw a `TypeError` that names the option.

## License

MIT
