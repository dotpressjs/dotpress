/**
 * Logger of the bus and the workers. A Dotpress or Pino logger fits;
 * `eventsPlugin` uses the logger of the request.
 */
export interface EventsLogger {
  debug?(data: object, message: string): void
  info(data: object, message: string): void
  warn(data: object, message: string): void
  error(data: object, message: string): void
}

const noop = () => undefined

/** Logger that discards everything. */
export const silentLogger: EventsLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
}

const toConsole =
  (level: 'info' | 'warn' | 'error') => (data: object, message: string) => {
    const fields = Object.keys(data).length > 0 ? [data] : []
    console[level](message, ...fields)
  }

/**
 * Default logger of the workers and the queue handlers: the global
 * `console`, from the `info` level. A failing listener is never silent.
 */
export const consoleLogger: EventsLogger = {
  info: toConsole('info'),
  warn: toConsole('warn'),
  error: toConsole('error'),
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
  return logger as EventsLogger
}
