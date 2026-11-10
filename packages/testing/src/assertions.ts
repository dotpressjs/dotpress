import { expect } from 'vitest'

/** Error of a failed assertion, shown by the test runner. */
export class ExpectationError extends Error {
  override name = 'AssertionError'
}

/**
 * Whether a value matches an expected value: objects partially (like
 * `toMatchObject`), other values exactly (like `toEqual`); asymmetric
 * matchers (`expect.any()`, `expect.stringContaining()`…) are accepted.
 */
export const matches = (actual: unknown, expected: unknown): boolean => {
  try {
    if (
      typeof expected === 'object' &&
      expected !== null &&
      typeof actual === 'object' &&
      actual !== null
    ) {
      expect(actual).toMatchObject(expected)
    } else {
      expect(actual).toEqual(expected)
    }
    return true
  } catch {
    return false
  }
}

/** Short JSON of a value, for messages. */
export const show = (value: unknown): string => {
  let json: string | undefined
  try {
    // Asymmetric matchers are shown as in vitest: Any<String>.
    json = JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'object' && item !== null && 'asymmetricMatch' in item
        ? ((
            item as { toAsymmetricMatcher?: () => string }
          ).toAsymmetricMatcher?.() ?? String(item))
        : item
    )
  } catch {
    json = undefined
  }
  json ??= String(value)
  return json.length > 300 ? `${json.slice(0, 297)}...` : json
}

/** Checks the `times` option of an assertion. */
export const checkTimes = (label: string, times: unknown): void => {
  if (
    times !== undefined &&
    (!Number.isInteger(times) || (times as number) < 0)
  ) {
    throw new TypeError(`${label}: times must be a non-negative integer.`)
  }
}

/**
 * Throws unless `found` is `times`, or at least 1 without `times`.
 * `description` names what was expected, with the phrase for none;
 * `recorded` lists what was found.
 */
export const assertCount = (
  description: { readonly some: string; readonly none: string },
  found: number,
  times: number | undefined,
  recorded: string
): void => {
  if (times === undefined ? found > 0 : found === times) return
  const expected =
    times === undefined
      ? description.some
      : times === 0
        ? description.none
        : `${description.some} ${times === 1 ? 'once' : `${times} times`}`
  throw new ExpectationError(
    `Expected ${expected}, found ${found}.\n${recorded}`
  )
}
