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
