/**
 * A duration: a number of seconds, or a string with a unit: `'500ms'`,
 * `'30s'`, `'10m'`, `'1h'`, `'7d'`.
 */
export type Duration = number | `${number}${DurationUnit}`

type DurationUnit = 'ms' | 's' | 'm' | 'h' | 'd'

const UNITS: Readonly<Record<DurationUnit, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

const PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/

/**
 * Converts a duration to whole milliseconds, or throws a `TypeError` that
 * names the option.
 */
export const toMilliseconds = (label: string, value: unknown): number => {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= 0) return Math.round(value * 1000)
  } else if (typeof value === 'string') {
    const match = PATTERN.exec(value)
    if (match) {
      return Math.round(Number(match[1]) * UNITS[match[2] as DurationUnit])
    }
  }
  throw new TypeError(
    `${label} must be a number of seconds, or a duration like '30s', '10m', '1h' or '7d'.`
  )
}
