/**
 * A duration: a number of seconds, fractions allowed (`0.5`), or a string
 * with a unit: `'500ms'`, `'30s'`, `'10m'`, `'1h'`, `'7d'`.
 */
export type Duration = number | `${number}${DurationUnit}`

/** Units of a `Duration` string: milliseconds to days. */
export type DurationUnit = 'ms' | 's' | 'm' | 'h' | 'd'

const UNITS: Readonly<Record<DurationUnit, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

const PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/

/**
 * Converts a `Duration` to whole milliseconds. Throws a `TypeError` naming
 * the option (`label`) for anything else, including negative numbers.
 *
 * @example
 * parseDuration(1.5) // 1500
 * parseDuration('10m') // 600000
 */
export const parseDuration = (value: unknown, label = 'Duration'): number => {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= 0) return Math.round(value * 1000)
  } else if (typeof value === 'string') {
    const match = PATTERN.exec(value)
    if (match) {
      return Math.round(Number(match[1]) * UNITS[match[2] as DurationUnit])
    }
  }
  throw new TypeError(
    `${label} must be a number of seconds, or a duration like '500ms', '30s', '10m', '1h' or '7d'.`
  )
}
