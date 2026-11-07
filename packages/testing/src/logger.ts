import type { Logger } from '@dotpress/core'

export interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly args: readonly unknown[]
}

export interface MemoryLogger extends Logger {
  /** Entries logged by this logger and its children. */
  readonly entries: LogEntry[]
}

/**
 * Logger that records entries instead of printing them.
 */
export const createMemoryLogger = (): MemoryLogger => {
  const entries: LogEntry[] = []

  const create = (): Logger => ({
    debug: (...args: unknown[]) => void entries.push({ level: 'debug', args }),
    info: (...args: unknown[]) => void entries.push({ level: 'info', args }),
    warn: (...args: unknown[]) => void entries.push({ level: 'warn', args }),
    error: (...args: unknown[]) => void entries.push({ level: 'error', args }),
    child: () => create(),
  })

  return Object.assign(create(), { entries })
}
