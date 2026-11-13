# Cache

An articles API with `@dotpress/cache`, on Express, using the two tools of the package:

- **the memo** (`ctx.memo`): a value loaded once per request. The middleware and the handler share the current user, and a list loads the authors of its articles with one query, not one per article;
- **the cache** (`ctx.cache`): values kept across requests and instances. Articles are cached for 10 minutes; editing an article expires it, and renaming a user expires every article at once, with tags;
- **a grace period**: when the database fails, an expired article is still served for one more day, instead of an error;
- Redis with `REDIS_URL`, the memory of the process otherwise.

A fake database records its queries: the tests count them, as you would watch the queries of your database.

Source: [`examples/cache`](https://github.com/dotpressjs/dotpress/tree/main/examples/cache).

## Run it

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

The `x-user-id` header stands in for authentication: see the [Authentication example](./auth) for the real thing.

### With Redis

```sh
docker compose up -d # Redis
REDIS_URL=redis://localhost:6379 npm run dev
```

The cache now survives restarts, and is shared by every instance of the API.

## The memo and the cache entries

```ts file="<root>/../examples/cache/src/loaders.ts"
```

## The routes

The list combines both tools: the cache keeps it for a minute, and on a miss, the memo loads its authors with one query. Updates expire what they change.

```ts file="<root>/../examples/cache/src/routes.ts"
```

## The app

The cache fails open: when Redis is down or slower than 200 ms, requests go to the database, and the failures are logged.

```ts file="<root>/../examples/cache/src/app.ts"
```

## What the tests check

The tests count the queries of the fake database:

```ts file="<root>/../examples/cache/test/memo.test.ts"
```

## Learn more

- [Cache and memoization](/services/cache)
- [Deployment › Several instances](/deployment/node#several-instances)
