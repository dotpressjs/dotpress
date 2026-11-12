import { createCache, type CacheStore } from '@dotpress/cache'
import { cachePlugin } from '@dotpress/cache/plugin'
import { createApp, type HttpAdapter, type Logger } from '@dotpress/core'
import { createDatabase, type Database } from './db.ts'
import { userMemo } from './loaders.ts'
import { articlesRouter } from './routes.ts'

export interface ArticlesAppOptions<TAdapter extends HttpAdapter> {
  adapter: TAdapter
  store: CacheStore
  db?: Database
  /** Prefix of the keys in the store. Defaults to `articles`. */
  prefix?: string
  logger?: Logger
}

/**
 * Creates the app on any adapter: Express in `server.ts`, the memory
 * adapter of `@dotpress/testing` in the tests.
 */
export const createArticlesApp = <TAdapter extends HttpAdapter>({
  adapter,
  store,
  db = createDatabase(),
  prefix = 'articles',
  logger,
}: ArticlesAppOptions<TAdapter>) => {
  const cache = createCache({
    store,
    prefix,
    // A slow store counts as a failure: the cache fails open, the request
    // goes on with the database.
    storeTimeout: '200ms',
  })

  return createApp({
    adapter,
    ...(logger && { logger }),
    routers: [articlesRouter(db, userMemo(db))],
    // ctx.memo: a new memo for each request. ctx.cache: the cache, logging
    // with the request logger.
    plugins: [cachePlugin({ cache })],
  })
}
