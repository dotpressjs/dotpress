import mustache from 'mustache'
import { MailDataError, MailRenderError } from './errors.js'
import { resolveLocale, type Translations } from './locales.js'
import {
  definitionOf,
  type MailTemplate,
  type TemplateDefinition,
  type TranslateContext,
} from './template.js'

/** Options of `renderMail()`. */
export type RenderMailOptions<TData> = {
  /**
   * Locale to render, like `fr-CA`. Falls back to its base language (`fr`),
   * then to `defaultLocale`.
   */
  locale?: string | undefined
  /** Locale used when the requested one is not available. */
  defaultLocale?: string | undefined
} & ([TData] extends [undefined] ? { data?: undefined } : { data: TData })

/** A rendered email. */
export interface RenderedMail {
  /** Name of the template. */
  readonly template: string
  /** Rendered locale; undefined for a template without translations. */
  readonly locale: string | undefined
  readonly subject: string
  readonly html: string
  readonly text: string
}

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * HTML escaping of `{{ }}` values. Unlike the default escaping of Mustache,
 * `/`, `=` and `` ` `` are kept: many email clients do not decode them in
 * links.
 */
const escapeHtml = (value: unknown) =>
  String(value).replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] as string)

const noEscape = (value: unknown) => String(value)

type Mjml = typeof import('mjml')
type HtmlToText = typeof import('html-to-text')

let mjmlModule: Promise<Mjml> | undefined
let htmlToTextModule: Promise<HtmlToText> | undefined

/** MJML, loaded on the first MJML render. */
const loadMjml = () =>
  (mjmlModule ??= import('mjml').then(
    (module) => module.default,
    (error: unknown) => {
      mjmlModule = undefined
      throw error
    }
  ))

/** html-to-text, loaded on the first text conversion. */
const loadHtmlToText = () =>
  (htmlToTextModule ??= import('html-to-text').then(
    (module) => module,
    (error: unknown) => {
      htmlToTextModule = undefined
      throw error
    }
  ))

/** Whether loading failed because the mjml package is missing. */
const isMjmlMissing = (error: unknown): boolean =>
  error instanceof Error &&
  (((error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' &&
    error.message.includes("'mjml'")) ||
    isMjmlMissing(error.cause))

interface MjmlIssue {
  line?: number
  tagName?: string
  message?: string
}

/** Message of an MJML failure, without the file paths of MJML messages. */
const describeMjmlError = (error: unknown) => {
  const issues = (error as { errors?: unknown } | null)?.errors
  if (Array.isArray(issues) && issues.length > 0) {
    return (issues as MjmlIssue[])
      .map(
        ({ line, tagName, message }) => `line ${line} (${tagName}): ${message}`
      )
      .join('; ')
  }
  return error instanceof Error ? error.message : String(error)
}

/** Compiles MJML to HTML, strict validation. */
const compileMjml = async (name: string, source: string) => {
  let mjml: Mjml
  try {
    mjml = await loadMjml()
  } catch (error) {
    throw new MailRenderError(
      name,
      isMjmlMissing(error)
        ? 'MJML is not installed. Install the mjml package, or use html templates.'
        : 'MJML could not be loaded.',
      { cause: error }
    )
  }
  try {
    const { html } = await mjml(source, {
      validationLevel: 'strict',
      ignoreIncludes: true,
    })
    return html
  } catch (error) {
    throw new MailRenderError(
      name,
      `invalid MJML: ${describeMjmlError(error)}`,
      { cause: error }
    )
  }
}

/** Converts the HTML version to text. */
const toText = async (html: string) => {
  const { convert } = await loadHtmlToText()
  return convert(html, {
    wordwrap: 78,
    selectors: [
      { selector: 'img', format: 'skip' },
      // Preview text and other content hidden from readers.
      { selector: '[style*="display:none"]', format: 'skip' },
      { selector: '[style*="display: none"]', format: 'skip' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
    ],
  })
}

/** `t()` of a set of translations, in a locale. */
const translator =
  (
    name: string,
    owner: string,
    translations: Translations,
    locale: string | undefined
  ) =>
  (key: string): string => {
    const entry = Object.hasOwn(translations, key)
      ? translations[key]
      : undefined
    // Without locale, there are no translations: entry is undefined.
    const text = entry?.[locale as string]
    if (text === undefined) {
      throw new MailRenderError(
        name,
        `unknown translation key "${key}" in the ${owner}.`
      )
    }
    return text
  }

/** Calls a source function; errors other than render errors are wrapped. */
const produce = <C>(
  name: string,
  owner: string,
  source: string | ((context: C) => string),
  context: C
): string => {
  if (typeof source === 'string') return source
  let result: unknown
  try {
    result = source(context)
  } catch (error) {
    if (error instanceof MailRenderError) throw error
    throw new MailRenderError(name, `the ${owner} source function failed.`, {
      cause: error,
    })
  }
  if (typeof result !== 'string') {
    throw new MailRenderError(
      name,
      `the ${owner} source function must return a string.`
    )
  }
  return result
}

const contextOf = (
  definition: TemplateDefinition,
  locale: string | undefined
): TranslateContext => ({
  locale,
  t: translator(definition.name, 'template', definition.translations, locale),
})

/** HTML of a template in a locale, before Mustache. */
const compile = async (
  definition: TemplateDefinition,
  locale: string | undefined
) => {
  const { name, layout } = definition
  let source = produce(
    name,
    'template',
    definition.source,
    contextOf(definition, locale)
  )
  if (layout) {
    source = produce(name, 'layout', layout.render, {
      locale,
      t: translator(name, 'layout', layout.translations, locale),
      content: source,
    })
  }
  return definition.format === 'mjml' ? compileMjml(name, source) : source
}

/** Cached `compile()`: the result only depends on the locale. */
const compiled = (
  definition: TemplateDefinition,
  locale: string | undefined
) => {
  const key = locale ?? ''
  let html = definition.cache.get(key)
  if (!html) {
    html = compile(definition, locale)
    definition.cache.set(key, html)
    // A failure is not cached: the next render tries again.
    html.catch(() => definition.cache.delete(key))
  }
  return html
}

const renderMustache = (
  name: string,
  part: string,
  source: string,
  data: object,
  escape: (value: unknown) => string
) => {
  try {
    return mustache.render(source, data, {}, { escape })
  } catch (error) {
    throw new MailRenderError(
      name,
      `invalid Mustache in the ${part}: ${(error as Error).message}`,
      { cause: error }
    )
  }
}

const parseData = async (
  definition: TemplateDefinition,
  data: unknown
): Promise<object> => {
  const { name, schema } = definition
  if (!schema) {
    if (data !== undefined) {
      throw new MailDataError(name, [
        { path: [], message: 'the template has no schema and accepts no data' },
      ])
    }
    return {}
  }

  const result = await schema.safeParseAsync(data)
  if (!result.success) {
    throw new MailDataError(
      name,
      result.error.issues.map(({ path, message }) => ({
        path: path.map((key) => (typeof key === 'symbol' ? String(key) : key)),
        message,
      }))
    )
  }
  const parsed: unknown = result.data
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MailDataError(name, [
      { path: [], message: 'the schema must produce an object' },
    ])
  }
  return parsed
}

const subjectSource = (
  definition: TemplateDefinition,
  locale: string | undefined
) => {
  const { subject } = definition
  if (typeof subject === 'string') return subject
  // The locale is one of the subject locales (checked by defineTemplate).
  return subject[locale as string] as string
}

/**
 * Renders a template: subject, HTML and text versions. The data is
 * validated by the schema of the template.
 *
 * ```ts
 * const { subject, html, text } = await renderMail(welcome, {
 *   locale: 'fr-CA',
 *   defaultLocale: 'en',
 *   data: { firstName: 'Ada', url: 'https://app.example.com' },
 * })
 * ```
 */
export const renderMail = async <TData>(
  template: MailTemplate<TData>,
  options: RenderMailOptions<NoInfer<TData>>
): Promise<RenderedMail> => {
  const definition = definitionOf(template)
  if (!definition) {
    throw new TypeError(
      'renderMail(): expected a template created by defineTemplate().'
    )
  }
  const { name, locales } = definition
  const { locale: requested, defaultLocale } = options ?? {}

  const data = await parseData(definition, options?.data)

  let locale: string | undefined
  if (locales.length > 0) {
    locale = resolveLocale(locales, requested, defaultLocale)
    if (locale === undefined) {
      const asked = [requested, defaultLocale].filter(Boolean)
      throw new MailRenderError(
        name,
        asked.length > 0
          ? `no translations for ${asked.join(' or ')} (available: ${locales.join(', ')}).`
          : `no locale requested and no default locale (available: ${locales.join(', ')}).`
      )
    }
  }

  const html = renderMustache(
    name,
    'HTML',
    await compiled(definition, locale),
    data,
    escapeHtml
  )

  // A subject is a single line.
  const subject = renderMustache(
    name,
    'subject',
    subjectSource(definition, locale),
    data,
    noEscape
  )
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim()

  const text = definition.text
    ? renderMustache(
        name,
        'text',
        produce(name, 'text', definition.text, contextOf(definition, locale)),
        data,
        noEscape
      )
    : await toText(html)

  return { template: name, locale, subject, html, text }
}
