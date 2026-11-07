export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Log function. The signature is compatible with Pino, so a Pino logger can
 * be passed directly to `createApp()`.
 */
export interface LogFn {
  (message: string, ...args: unknown[]): void
  (data: object, message?: string, ...args: unknown[]): void
}

export interface Logger {
  debug: LogFn
  info: LogFn
  warn: LogFn
  error: LogFn
  child(bindings: Record<string, unknown>): Logger
}

export interface ConsoleLoggerOptions {
  /** Minimum level to output. Defaults to `info`. */
  level?: LogLevel
  /** Fields attached to every log entry. */
  bindings?: Record<string, unknown>
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

/**
 * Default logger, based on the global `console`.
 */
export const createConsoleLogger = (
  options: ConsoleLoggerOptions = {}
): Logger => {
  const level = options.level ?? 'info'
  const bindings = options.bindings ?? {}

  const write =
    (entryLevel: LogLevel): LogFn =>
    (first: unknown, ...rest: unknown[]) => {
      if (LEVEL_RANK[entryLevel] < LEVEL_RANK[level]) {
        return
      }

      let message: unknown
      let fields: Record<string, unknown> = { ...bindings }
      let args: unknown[]

      if (typeof first === 'object' && first !== null) {
        const [maybeMessage, ...others] = rest
        message = maybeMessage ?? ''
        args = others
        fields =
          first instanceof Error
            ? { ...fields, err: first }
            : { ...fields, ...(first as Record<string, unknown>) }
      } else {
        message = first
        args = rest
      }

      const output = Object.keys(fields).length > 0 ? [fields] : []
      console[entryLevel](message, ...args, ...output)
    }

  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: (childBindings) =>
      createConsoleLogger({
        level,
        bindings: { ...bindings, ...childBindings },
      }),
  }
}
