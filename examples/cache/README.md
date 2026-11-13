# Dotpress cache

An articles API with [Dotpress](https://dotpress.dev) and `@dotpress/cache`, on [Express](https://expressjs.com), at the two levels of the package:

- **memo** (`ctx.memo`): a value loaded once per request. The middleware and the handler share the current user, and a list loads the authors of its articles with one query, not one per article (no N+1 queries);
- **cache** (`ctx.cache`): values kept across requests and instances. Articles are cached for 10 minutes; editing an article expires it, and renaming a user expires every article at once (tags);
- **grace period**: when the database fails, an expired article is still served for one more day, instead of an error;
- Redis with `REDIS_URL`, the memory of the process otherwise.

A fake database (`src/db.ts`) records its queries: the tests count them, as you would watch the queries of your database.

## Run it

Requires Node.js 22.18 or later: Node.js runs the TypeScript sources directly.

```sh
npx degit dotpressjs/dotpress/examples/cache my-api
cd my-api
npm install
npm run dev
```

```sh
curl localhost:3000/articles # loads, then caches for 1 minute
curl localhost:3000/articles/a1 # cached for 10 minutes
curl -X PATCH localhost:3000/articles/a1 -H 'x-user-id: u1' \
  -H 'content-type: application/json' -d '{"title":"Caching 102"}' # expires it
curl -X PATCH localhost:3000/users/me -H 'x-user-id: u1' \
  -H 'content-type: application/json' -d '{"name":"Alice Martin"}' # expires every article
```

The `x-user-id` header stands in for authentication: see the auth example for the real thing.

### With Redis

```sh
docker compose up -d # Redis, from compose.yaml
REDIS_URL=redis://localhost:6379 npm run dev
```

The cache now survives restarts, and is shared by every instance of the API. `npm test` runs the tests; with `REDIS_URL`, the cache tests also run on Redis. `npm run typecheck` checks the types.

## Deploy

| Variable | Content |
| --- | --- |
| `REDIS_URL` | `redis://` or `rediss://` (TLS) URL. Without it, each instance has its own cache in memory |
| `PORT` | Defaults to `3000` |

With several instances, use Redis: with caches in memory, an instance that edits an article only expires its own copy. A Redis used as a cache only can evict the least recently used keys (`maxmemory-policy allkeys-lru`, as in `compose.yaml`); a Redis shared with BullMQ needs `noeviction`.

The cache fails open: when Redis is down or slower than 200 ms (`storeTimeout`), requests go to the database, and the failures are logged.

## Files

| File | Content |
| --- | --- |
| `src/loaders.ts` | The memo of the users (batched), and the cache entries of the articles (ttl, grace period, tags, schema) |
| `src/routes.ts` | The routes: lists, reads, updates and their invalidations |
| `src/db.ts` | A fake database recording its queries, to replace with yours |
| `src/store.ts` | The store: Redis (node-redis) or memory |
| `src/app.ts` | The cache and the app, with the cache plugin |
| `src/server.ts` | The Express server |
| `compose.yaml` | Redis, for development |
| `test/memo.test.ts` | One query per request, one query for the authors of a list |
| `test/cache.test.ts` | Cache hits, invalidation by tags, on memory and on Redis |
| `test/grace.test.ts` | The grace period, with a failing database and a simulated clock |
| `test/server.test.ts` | Tests over HTTP |

The [cache guide](https://dotpress.dev/services/cache) covers the other stores (Upstash, Cloudflare Workers KV), the distributed lock, stale-while-revalidate, timeouts, and memos without `ctx` (`asyncLocalMemo`).
