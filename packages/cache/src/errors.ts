/** Base class of the errors thrown by `@dotpress/cache`. */
export class CacheError extends Error {
  override name = 'CacheError'
}

/**
 * The `batch` function of a memo returned a result that does not match
 * the keys: every call of the batch fails with this error.
 */
export class MemoBatchError extends CacheError {
  override name = 'MemoBatchError'

  constructor(
    /** Name of the memo. */
    readonly memo: string,
    message: string
  ) {
    super(`Memo "${memo}": ${message}`)
  }
}

/** Operation of a cache store. */
export type StoreOperation = 'get' | 'set' | 'delete'

/** A cache store failed or did not answer in time (`failOpen: false`). */
export class CacheStoreError extends CacheError {
  override name = 'CacheStoreError'

  constructor(
    /** Name of the store. */
    readonly store: string,
    readonly operation: StoreOperation,
    /** Key of the store. */
    readonly key: string,
    options: { cause: unknown }
  ) {
    super(
      `Cache store "${store}" failed to ${operation} "${key}": ${options.cause instanceof Error ? options.cause.message : String(options.cause)}`,
      options
    )
  }
}
