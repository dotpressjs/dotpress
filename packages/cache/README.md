# @dotpress/cache

Caching for [Dotpress](https://dotpress.dev), at two levels:

- **memo**: values loaded once per request, event message or job, with single flight and batching (no N+1 queries);
- **cache**: values kept across requests and instances, with tags, a grace period when the source fails, and stores for Redis, Valkey, Upstash and Cloudflare Workers KV. It fails open when the store is down.

Works without a Dotpress app: in a script, a worker or a Lambda function.

> 🚧 Dotpress V2 is in alpha (`2.0.0-alpha`): the API may still change before 2.0.0.

```sh
npm install @dotpress/cache
```

```ts
import { createCache, createMemo, createMemoryStore, defineCacheEntry, defineMemo } from '@dotpress/cache'

// Memo: loaded once per unit of work
export const loadUser = defineMemo({ name: 'user', load: (id: string) => db.users.findById(id) })

const memo = createMemo() // one per request, message or job
const user = await memo(loadUser, '42') // loads; the next calls are memoized

// Cache: kept across requests
export const planCache = defineCacheEntry({ name: 'plan', key: (id: string) => id, ttl: '1h' })

const cache = createCache({ store: createMemoryStore(), prefix: 'app' })
const plan = await cache.getOrSet(planCache, user.planId, () => billing.getPlan(user.planId))
```

With `cachePlugin()` of `@dotpress/cache/plugin`, every request gets `ctx.memo` and `ctx.cache`.

## Documentation

- [Cache and memoization](https://dotpress.dev/services/cache): memo and batching, cache, invalidation and tags, resilience, store failures, stores
- [Cache reference](https://dotpress.dev/reference/cache): every option, the stores and their limits, errors

## License

MIT
