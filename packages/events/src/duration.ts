// The durations of @dotpress/core (`Duration`, `parseDuration()`), copied:
// the core is an optional peer of this package, which runs in workers
// without it. A test keeps both in sync.

/**
 * A duration: a number of seconds, fractions allowed (`0.5`), or a string
 * with a unit: `'500ms'`, `'30s'`, `'10m'`, `'1h'`, `'7d'`. The `Duration`
 * type of `@dotpress/core`.
 */
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`

const UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

const PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/

/** A duration in whole milliseconds, or a `TypeError` naming the option. */
export const toMilliseconds = (value: unknown, label: string): number => {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= 0) return Math.round(value * 1000)
  } else if (typeof value === 'string') {
    const match = PATTERN.exec(value)
    if (match) return Math.round(Number(match[1]) * UNITS[match[2]!]!)
  }
  throw new TypeError(
    `${label} must be a number of seconds, or a duration like '500ms', '30s', '10m', '1h' or '7d'.`
  )
}

/** An optional duration in milliseconds, or its default. */
export const optionalMilliseconds = (
  value: unknown,
  label: string,
  fallback: number
): number => (value === undefined ? fallback : toMilliseconds(value, label))

/** A duration in whole seconds, rounded up: never earlier than asked. */
export const toSeconds = (value: unknown, label: string): number =>
  Math.ceil(toMilliseconds(value, label) / 1000)

/** Delay of a retry, from a `retryDelay` option, in milliseconds. */
export const retryDelayOf = (
  label: string,
  retryDelay: (attempt: number) => Duration,
  attempt: number
): number =>
  toMilliseconds(retryDelay(attempt), `${label}: retryDelay(${attempt})`)
