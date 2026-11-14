# Cache

The options, stores and errors of `@dotpress/cache`. For a guide, see [Cache and memoization](/services/cache).

## defineMemo()

```ts
defineMemo({ name: 'user', load: (id: string) => db.users.findById(id) })
defineMemo({ name: 'author', batch: (ids: readonly string[]) => loadAuthors(ids), maxBatchSize: 100 })
```

| Option | Description |
| --- | --- |
| `name` | Used in errors and logs. |
| `load` | Loads one value from its arguments. |
| `batch` | Instead of `load`: loads the values of every key requested in the same tick, in one call. |
| `key` | Optional: a string from the arguments, for arguments not compared by value (`key: (user) => user.id`). |
| `maxBatchSize` | With `batch`: the maximum number of keys per call. |
| `schedule` | With `batch`: when the batch runs, `setTimeout(run, 0)` by default. |

- **Keys**: the arguments, compared by value: strings, numbers, booleans, `null`, `undefined`, bigints, dates, arrays and plain objects, whatever the order of their properties.
- **Single flight**: calls made while a value loads share the load. A failed load fails the calls in progress, and is not kept: the next call loads again.
- **Values** are the objects returned by `load`, not copies: a caller that mutates one changes it for the others.
- **`batch`** receives the keys without duplicates, and returns a `Map` by key (missing keys give `undefined`), or an array in the order of the keys, where an `Error` fails its key only. An array of the wrong length fails every key with a `MemoBatchError`. Keys requested before the batch runs join it, awaits included; keys requested once it started go to the next one.

### The memo

`createMemo()` creates a memo: one per request, event message or job, never one per process.

| Call | Description |
| --- | --- |
| `memo(loader, ...args)` | The value, loaded once. |
| `memo.set(loader, ...args, value)` | Replaces a value, after an update. |
| `memo.delete(loader, ...args)` | The next call loads again. |
| `memo.clear(loader)`, `memo.clear()` | Forgets the values of a loader, or every value. |

## defineCacheEntry()

```ts
defineCacheEntry({
  name: 'user',
  key: (id: string) => id,
  schema: z.object({ id: z.string(), name: z.string() }),
  ttl: '1h',
  tags: (id: string) => [`user:${id}`],
})
```

| Option | Default | Description |
| --- | --- | --- |
| `name` | required | Part of the key. |
| `key` | the arguments | A string, a number, or a value compared like the arguments of a memo. |
| `schema` | — | Validates every value read, and every value written. Types the value. |
| `version` | `1` | Part of the key: increase it when the shape of the values changes. |
| `tags` | — | A function of the arguments, returning the tags of the value. |
| `ttl` | the `ttl` of the cache | How long a value is fresh. |
| `grace`, `graceBackoff`, `staleWhileRevalidate`, `timeout`, `hardTimeout`, `lock` | the policy of the cache | See [Resilience](#resilience). |

Keys are `prefix:name:vVersion:key`, like `app:user:v1:42`. Keys longer than the store accepts are hashed (SHA-256). Durations are a number of seconds, or a string: `'500ms'`, `'30s'`, `'10m'`, `'1h'`, `'7d'` (the `Duration` type of `@dotpress/core`, see [Options and durations](/concepts/options#durations)).

Without a `schema`, `getOrSet` returns the type of the loader, and `get` returns `unknown`: `defineCacheEntry<[id: string], User>({ … })` declares the type.

## createCache()

| Option | Default | Description |
| --- | --- | --- |
| `store` | required | See [Stores](#stores). |
| `prefix` | — | Prefix of every key, like the name of the app. |
| `ttl` | 1 hour | Default lifetime of the values. |
| `grace`… `lock` | — | The default [resilience](#resilience) policy of the entries. |
| `serializer` | JSON | `{ serialize, deserialize }`, such as superjson. |
| `logger` | — | Logs store failures, stale values and events. |
| `storeTimeout` | — | A slower store operation counts as a failure. Set it: a reconnecting client makes commands wait. |
| `failOpen` | `true` | `false` throws a `CacheStoreError` when the store fails. |
| `onError(error, { operation, key, entry })` | — | Every store failure; `operation` is `get`, `set`, `delete` or `invalidate`. Its own errors are logged and ignored. |
| `onEvent(event)` | — | Each result of `get` and `getOrSet`, for metrics. See [Events](#events). |

| Method | Description |
| --- | --- |
| `getOrSet(entry, ...args, loader)` | The value, or loads, caches and returns it. Concurrent calls share the load. A failed load, or a load returning `undefined`, is not cached. |
| `get(entry, ...args)` | A fresh value, or `undefined` when missing, expired or invalidated. |
| `set(entry, ...args, value)` | Writes a value. |
| `delete(entry, ...args)` | Removes a value for good. |
| `invalidateTags(tags)` | Expires every value of these tags. |
| `withLogger(logger)` | The same cache, with another logger: the logger of a request. |

### Values

Values are serialized with the `serializer`. `undefined` is not cached; `null` is. With a `schema`, a value read that no longer matches (written by an older version of the app) is a miss, not a crash. Values are checked when written too, as they will read back: JSON turns dates into strings, so `z.date()` fails and the value is not cached, with a warning, while `z.coerce.date()` works. `getOrSet` returns the value as it reads back: a hit and a miss return the same thing. The memory store serializes too, so that a caller cannot change a cached object.

### Resilience

| Option | Default | Effect, once the `ttl` is over |
| --- | --- | --- |
| `grace` | disabled | During this time, when the loader fails or times out, the expired value is returned instead of the error, with a `warn` log. |
| `graceBackoff` | `'10s'` | After such a failure, the loader is not called again during this delay: the expired value is served directly. A successful load ends it. |
| `staleWhileRevalidate` | disabled | During this time, the expired value is returned at once, and reloaded in the background, once per key. Failed refreshes are logged. |
| `timeout` | none | With an expired value in its grace period, a slower load returns that value; the load goes on and caches its result. |
| `hardTimeout` | none | A slower load fails with a `CacheTimeoutError`, or returns the expired value of the grace period. The load goes on and caches its result. |
| `lock` | none | Distributed single flight, on stores with locks (Redis): one instance loads a missing value, under a lock held at most this long; the others read the value every 50 ms, and load it themselves if the lock was not released. Set it above the duration of the loader. |

Values stay in the store for `ttl` plus the longer of `grace` and `staleWhileRevalidate`. Without a grace period, a failing loader fails the call.

### Tags

Each tag has a random token in the store (`prefix:_tag:name`, kept 30 days or longer). A value records the tokens of its tags when written; `invalidateTags()` replaces them. Reading a value with tags reads their tokens too: one more round trip, grouped with `getMany` when the store has it.

- A value whose token changed or vanished is expired: `get` returns `undefined`, and `getOrSet` reloads it. With a `grace` period, it can still be served when the loader fails, never by `staleWhileRevalidate`: the data changed.
- When the tokens cannot be read, values with tags count as invalidated, and new values are not cached.

### Events

`onEvent(event)` receives `{ type, reason?, entry, key }`: `type` is `hit`, `miss` or `stale`, and `reason` (for a stale value) is `revalidate`, `error`, `timeout` or `backoff`. The same events are logged at the `debug` level.

### Store failures

By default, the cache fails open: a failed read is a miss (the loader runs), a failed write is skipped. Every failure is logged, `warn` for reads and writes, `error` for deletions and invalidations (they may leave outdated values), and passed to `onError`.

## Stores

| Store | Import | Use |
| --- | --- | --- |
| `createMemoryStore({ maxEntries })` | `@dotpress/cache` | The memory of the process: one instance, development, tests. The least recently used entries are removed beyond `maxEntries` (10,000 by default). |
| `createRedisStore({ client })` | `@dotpress/cache/redis` | Redis or Valkey, with a node-redis or ioredis client. |
| `createUpstashStore({ url, token })` | `@dotpress/cache/upstash` | Upstash Redis over its REST API: every runtime, edge included. |
| `createCloudflareKvStore({ kv })` | `@dotpress/cache/cloudflare-kv` | Workers KV, from a Worker. |

### Redis and Valkey

```ts
import { createClient } from 'redis' // or: import { Redis } from 'ioredis'
import { createRedisStore } from '@dotpress/cache/redis'

const client = createClient({ url: process.env.REDIS_URL })
client.on('error', (error) => logger.error({ error }, 'Redis error'))
await client.connect()

const cache = createCache({ store: createRedisStore({ client }), prefix: 'app', storeTimeout: '200ms' })
// On shutdown: await client.close() (node-redis 5 or later; quit() with node-redis 4 and ioredis)
```

- The store uses the client of the app, which connects and closes it: [node-redis](https://github.com/redis/node-redis) (`redis`, v4 or later) or [ioredis](https://github.com/redis/ioredis).
- It works with Redis, Valkey, managed services (ElastiCache, Memorystore…) and servers of the same protocol (Dragonfly, KeyDB…).
- Commands: `GET`, `MGET` (tags), `SET … PX`, `DEL`, and for `lock`, `SET … NX PX` and a Lua script that releases a lock with its token only.
- Cluster clients (`createCluster()`, `new Cluster()`) are refused for now: use a standalone server, or the primary of a replicated one.
- A Redis used as a cache only can evict the least recently used keys (`maxmemory-policy allkeys-lru`); a Redis shared with BullMQ needs `noeviction`.

### Upstash

```ts
import { createUpstashStore } from '@dotpress/cache/upstash'

const store = createUpstashStore({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN, // the standard token: the read-only one cannot write
})
const cache = createCache({ store, prefix: 'app', storeTimeout: '500ms' })
```

The store calls the [REST API](https://upstash.com/docs/redis/features/restapi) of Upstash Redis with `fetch`: no dependency, no connection to open or close. It runs on Cloudflare Workers, Vercel, Deno, Bun and Node.js. Each operation is one HTTPS request. Errors of the API (`401`, `400 ERR …`) are store failures. A request is limited to 10 MB on the free and pay-as-you-go plans. The `fetch` option replaces the global `fetch`.

The `@upstash/redis` SDK is not needed: by default, it applies `JSON.parse` to every reply, which would change the cached values.

### Cloudflare Workers KV

```jsonc
// wrangler.jsonc
{ "kv_namespaces": [{ "binding": "CACHE", "id": "<namespace id>" }] }
```

```ts
import { env } from 'cloudflare:workers'
import { createCloudflareKvStore } from '@dotpress/cache/cloudflare-kv'

const cache = createCache({ store: createCloudflareKvStore({ kv: () => env.CACHE }), prefix: 'app' })
```

`kv` is the binding, or a function that returns it. [Workers KV](https://developers.cloudflare.com/kv) suits values read often and changed rarely: configuration, catalogs, rendered pages.

| Limit | Effect |
| --- | --- |
| Eventual consistency | A write, deletion or invalidation can take 60 seconds or more to reach other locations, which serve the previous value meanwhile. |
| Expiration of 60 seconds at least | Shorter `ttl` are kept in the value: the cache expires them on time, KV removes them after 60 seconds. |
| One write per second per key | Faster writes fail with a `429`: a store failure. `invalidateTags()` writes a token per tag. |
| Keys of 512 bytes | Longer keys are hashed. |
| No locks | The `lock` option is ignored. |
| Free plan: 1,000 writes per day | Cache misses write: count them before choosing KV. |

`cacheTtl` (30 seconds at least) keeps the values read in the cache of the location for longer: faster reads, but changes are seen even later. The tokens of tags are read in bulk, 100 keys per read.

### Custom stores

A store implements `CacheStore`: `name`, `get(key)`, `set(key, value, ttl)` (strings, `ttl` in milliseconds) and `delete(key)`, and optionally `getMany(keys)` (one round trip for the tokens of tags), `lock(key, ttl)` and `unlock(key, token)` (the `lock` option), and `maxKeyLength` (in bytes).

## cachePlugin()

```ts
import { cachePlugin } from '@dotpress/cache/plugin'

await createApp({ adapter, plugins: [cachePlugin({ cache, memoScope: asyncLocalMemo })] })
```

| Option | Description |
| --- | --- |
| `cache` | Optional: provides `ctx.cache`, the cache with the request logger. Without it, using `ctx.cache` throws. |
| `memoScope` | Optional: `asyncLocalMemo` runs each request in the scope of its memo. |

The plugin, named `cache`, provides `ctx.memo`: a new memo for each request, created on first use.

### @dotpress/cache/als

With [`AsyncLocalStorage`](https://nodejs.org/api/async_context.html): Node.js, Bun, Deno, and Cloudflare Workers with the `nodejs_compat` flag.

| Export | Description |
| --- | --- |
| `asyncLocalMemo` | The `memoScope` of the plugin. |
| `memoized(loader)` | A function that reads the memo of the current scope. |
| `runWithMemo(fn)` | Runs `fn` in the scope of a new memo: one per event message or job. |
| `currentMemo()` | The memo of the scope, for `set` and `delete`. |

Outside a scope, `currentMemo()` and the `memoized()` functions throw an explicit error: there is no global memo.

## Errors

| Error | When |
| --- | --- |
| `TypeError` | Invalid options and arguments; the message names the option. |
| `MemoBatchError` | `batch` returned values that do not match the keys. Field: `memo`. |
| `CacheTimeoutError` | A load exceeded `hardTimeout`, without a stale value to serve. Fields: `entry`, `key`, `timeout`. |
| `CacheStoreError` | The store failed or timed out, with `failOpen: false`. Fields: `store`, `operation`, `key`, `cause`. Also passed to `onError`. |

The error classes extend `CacheError`.
