import { describe, expect, it } from 'vitest'
import { parseDuration } from '../src/index.js'

describe('parseDuration()', () => {
  it('reads seconds and durations with a unit', () => {
    const cases: [unknown, number][] = [
      [0, 0],
      [30, 30_000],
      [0.5, 500],
      [0.0004, 0],
      ['500ms', 500],
      ['1.5s', 1500],
      ['30s', 30_000],
      ['10m', 600_000],
      ['1h', 3_600_000],
      ['7d', 604_800_000],
      ['0.0015s', 2],
    ]
    for (const [value, expected] of cases) {
      expect(parseDuration(value)).toBe(expected)
    }
  })

  it('names the option in its errors', () => {
    expect(() => parseDuration('soon')).toThrow(
      /^Duration must be a number of seconds/
    )
  })

  it('refuses other values', () => {
    for (const value of [
      -1,
      Infinity,
      NaN,
      '10',
      '10 m',
      ' 10m',
      '10m ',
      '1w',
      '-5s',
      '.5s',
      '1x5s',
      'm',
      null,
      undefined,
      [1],
    ]) {
      expect(() => parseDuration(value, 'options.ttl')).toThrow(
        new TypeError(
          `options.ttl must be a number of seconds, or a duration like '500ms', '30s', '10m', '1h' or '7d'.`
        )
      )
    }
  })
})
