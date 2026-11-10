/**
 * Translations of a template or layout: one entry per key, with a text for
 * each locale. Every entry must have the same locales.
 *
 * ```ts
 * { greeting: { en: 'Hello', fr: 'Bonjour' } }
 * ```
 */
export type Translations<L extends string = string> = Readonly<
  Record<string, Readonly<Record<L, string>>>
>

/** A text for each locale, like `{ en: 'Welcome', fr: 'Bienvenue' }`. */
export type Localized<L extends string = string> = Readonly<Record<L, string>>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Locales of a set of localized texts, checked: each entry must be an object
 * of strings, with the same locales as the others. Throws a `TypeError`
 * prefixed with `prefix`.
 */
export const collectLocales = (
  prefix: string,
  entries: readonly (readonly [label: string, value: unknown])[]
): string[] => {
  let locales: string[] | undefined
  let reference = ''

  for (const [label, value] of entries) {
    if (!isRecord(value)) {
      throw new TypeError(
        `${prefix}: ${label} must be an object of texts by locale.`
      )
    }
    const keys = Object.keys(value).sort()
    if (keys.length === 0) {
      throw new TypeError(`${prefix}: ${label} has no locale.`)
    }
    for (const key of keys) {
      if (typeof value[key] !== 'string') {
        throw new TypeError(`${prefix}: ${label}.${key} must be a string.`)
      }
    }

    if (locales === undefined) {
      locales = keys
      reference = label
    } else if (keys.join() !== locales.join()) {
      throw new TypeError(
        `${prefix}: ${label} has the locales ${keys.join(', ')}, but ${reference} has ${locales.join(', ')}. Every text needs the same locales.`
      )
    }
  }
  return locales ?? []
}

/** Entries of a translations object, for `collectLocales`. */
export const translationEntries = (
  prefix: string,
  translations: unknown
): [string, unknown][] => {
  if (translations === undefined) return []
  if (!isRecord(translations)) {
    throw new TypeError(`${prefix}: translations must be an object.`)
  }
  return Object.entries(translations).map(([key, value]) => [
    `translations.${key}`,
    value,
  ])
}

/** `fr` for `fr-CA` or `fr_CA`. */
const baseOf = (locale: string) => locale.split(/[-_]/)[0] ?? locale

/**
 * Locale to render: the requested one, its base language (`fr-CA` → `fr`),
 * then the default locale and its base language. Locales are compared
 * case-insensitively. Undefined if no candidate is available.
 */
export const resolveLocale = (
  available: readonly string[],
  requested: string | undefined,
  defaultLocale: string | undefined
): string | undefined => {
  const candidates = [requested, defaultLocale].flatMap((locale) =>
    locale ? [locale, baseOf(locale)] : []
  )
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase()
    const match = available.find((locale) => locale.toLowerCase() === lower)
    if (match !== undefined) return match
  }
  return undefined
}
