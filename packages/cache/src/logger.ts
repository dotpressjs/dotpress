/**
 * Logger of the cache. A Dotpress or Pino logger fits; `cachePlugin` uses
 * the logger of the request.
 */
export interface CacheLogger {
  debug?(data: object, message: string): void
  info(data: object, message: string): void
  warn(data: object, message: string): void
  error(data: object, message: string): void
}

const noop = () => undefined

/** Logger that discards everything. */
export const silentLogger: CacheLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
}

/** Checks a logger option. */
export const checkLogger = (label: string, logger: unknown) => {
  for (const level of ['info', 'warn', 'error'] as const) {
    if (
      typeof (logger as Record<string, unknown> | null)?.[level] !== 'function'
    ) {
      throw new TypeError(
        `${label}: logger must have info(), warn() and error() methods.`
      )
    }
  }
  return logger as CacheLogger
}
