import type { z } from 'zod'
import {
  collectLocales,
  translationEntries,
  type Localized,
  type Translations,
} from './locales.js'

/** Source format of a template or layout. */
export type MailFormat = 'mjml' | 'html'

/** Context of the functions that produce a template or layout source. */
export interface TranslateContext {
  /** Locale being rendered; undefined for a template without translations. */
  readonly locale: string | undefined
  /** Text of a translation key in this locale. Throws for an unknown key. */
  t(key: string): string
}

/** Context of a layout: its translations, and the content of the template. */
export interface LayoutContext extends TranslateContext {
  /** Source of the template, in the format of the layout. */
  readonly content: string
}

/** A source, or a function that produces it in the rendered locale. */
export type TemplateSource = string | ((context: TranslateContext) => string)

type LayoutBody =
  | { mjml: (context: LayoutContext) => string; html?: never }
  | { html: (context: LayoutContext) => string; mjml?: never }

/** Options of `defineLayout()`. */
export type LayoutOptions<L extends string = string> = {
  /** Texts of the layout, read with `t()`. */
  translations?: Translations<L>
} & LayoutBody

/** Layout created by `defineLayout()`. */
export interface MailLayout<L extends string = string> {
  readonly format: MailFormat
  /** Locales of the layout translations; empty without translations. */
  readonly locales: readonly string[]
  /**
   * Type-level only: the locales the layout can render.
   * @internal
   */
  readonly __locales?: (locale: L) => void
}

type TemplateBody =
  | { mjml: TemplateSource; html?: never }
  | { html: TemplateSource; mjml?: never }

/** Options of `defineTemplate()`. */
export type TemplateOptions<
  S extends z.ZodType | undefined = undefined,
  L extends string = string,
> = {
  /** Name of the template, used in errors and logs. */
  name: string
  /**
   * Layout that receives the template source as `content`. It must have
   * translations in the template locales.
   */
  layout?: MailLayout<NoInfer<string extends L ? never : L>>
  /** Schema of the data. Without it, the template accepts no data. */
  schema?: S
  /**
   * Subject, by locale or the same for all. Rendered by Mustache without
   * HTML escaping: `'Welcome {{firstName}}'`.
   */
  subject: string | Localized<L>
  /** Texts of the template, read with `t()`. */
  translations?: Translations<L>
  /**
   * Text version, rendered by Mustache without HTML escaping. Defaults to a
   * conversion of the HTML version.
   */
  text?: TemplateSource
} & TemplateBody

/** Data accepted by a template, given its schema. */
export type DataOf<S> = S extends z.ZodType ? z.input<S> : undefined

/** Template created by `defineTemplate()`. */
export interface MailTemplate<TData = undefined> {
  readonly name: string
  readonly format: MailFormat
  /** Locales of the template; empty for a template without translations. */
  readonly locales: readonly string[]
  /**
   * Type-level only: the data of the template.
   * @internal
   */
  readonly __data?: TData
}

/** Data accepted by a template. */
export type TemplateData<T> = T extends MailTemplate<infer D> ? D : never

/** Definition of a layout, used by the renderer. */
export interface LayoutDefinition {
  readonly format: MailFormat
  readonly translations: Translations
  readonly render: (context: LayoutContext) => string
}

/** Definition of a template, used by the renderer. */
export interface TemplateDefinition {
  readonly name: string
  readonly format: MailFormat
  readonly locales: readonly string[]
  readonly source: TemplateSource
  readonly layout: LayoutDefinition | undefined
  readonly schema: z.ZodType | undefined
  readonly subject: string | Localized
  readonly translations: Translations
  readonly text: TemplateSource | undefined
  /** Compiled HTML by locale, before Mustache (see `render.ts`). */
  readonly cache: Map<string, Promise<string>>
}

const layouts = new WeakMap<object, LayoutDefinition>()
const templates = new WeakMap<object, TemplateDefinition>()

/** Definition of a template, or undefined for another value. */
export const definitionOf = (template: unknown) =>
  templates.get(template as object)

const LAYOUT_OPTIONS = new Set(['translations', 'mjml', 'html'])
const TEMPLATE_OPTIONS = new Set([
  'name',
  'layout',
  'schema',
  'subject',
  'translations',
  'text',
  'mjml',
  'html',
])

const checkOptions = (
  prefix: string,
  options: unknown,
  allowed: ReadonlySet<string>
): Record<string, unknown> => {
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new TypeError(`${prefix}: expected an object.`)
  }
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${prefix}: unknown option "${key}".`)
    }
  }
  return options as Record<string, unknown>
}

/** Format of a source: exactly one of `mjml` and `html`. */
const formatOf = (
  prefix: string,
  options: Record<string, unknown>,
  isValid: (source: unknown) => boolean,
  expected: string
): MailFormat => {
  const formats = (['mjml', 'html'] as const).filter(
    (format) => options[format] !== undefined
  )
  const [format] = formats
  if (format === undefined || formats.length > 1) {
    throw new TypeError(`${prefix}: set exactly one of mjml and html.`)
  }
  if (!isValid(options[format])) {
    throw new TypeError(`${prefix}: ${format} must be ${expected}.`)
  }
  return format
}

const isSource = (source: unknown) =>
  typeof source === 'string' || typeof source === 'function'

/**
 * Defines a layout: the structure shared by templates (head, header,
 * footer). The layout function receives the template source as `content`,
 * and its own translations through `t()`.
 *
 * ```ts
 * const baseLayout = defineLayout({
 *   translations: { footer: { en: 'Sent by Acme', fr: 'Envoyé par Acme' } },
 *   mjml: ({ t, content }) => `<mjml><mj-body>${content}…${t('footer')}…</mj-body></mjml>`,
 * })
 * ```
 */
export const defineLayout = <L extends string = string>(
  options: LayoutOptions<L>
): MailLayout<L> => {
  const prefix = 'defineLayout()'
  const values = checkOptions(prefix, options, LAYOUT_OPTIONS)
  const format = formatOf(
    prefix,
    values,
    (source) => typeof source === 'function',
    'a function that receives the template content'
  )
  const locales = collectLocales(
    prefix,
    translationEntries(prefix, values.translations)
  )

  const layout: MailLayout<L> = Object.freeze({
    format,
    locales: Object.freeze(locales),
  })
  layouts.set(layout, {
    format,
    translations: (values.translations ?? {}) as Translations,
    render: values[format] as LayoutDefinition['render'],
  })
  return layout
}

/**
 * Defines an email template. The source (`mjml` or `html`) is rendered in
 * three steps: `t()` inserts the translations, MJML compiles the result
 * (cached by locale), then Mustache inserts the data.
 *
 * ```ts
 * const welcome = defineTemplate({
 *   name: 'welcome',
 *   layout: baseLayout,
 *   schema: z.object({ firstName: z.string(), url: z.url() }),
 *   subject: { en: 'Welcome {{firstName}}', fr: 'Bienvenue {{firstName}}' },
 *   translations: { cta: { en: 'Get started', fr: 'Commencer' } },
 *   mjml: ({ t }) => `<mj-section>…<mj-button href="{{{ url }}}">${t('cta')}</mj-button>…</mj-section>`,
 * })
 * ```
 */
export const defineTemplate = <
  S extends z.ZodType | undefined = undefined,
  L extends string = string,
>(
  options: TemplateOptions<S, L>
): MailTemplate<DataOf<S>> => {
  const name = (options as { name?: unknown } | null)?.name
  const prefix =
    typeof name === 'string' && name !== ''
      ? `defineTemplate("${name}")`
      : 'defineTemplate()'
  const values = checkOptions(prefix, options, TEMPLATE_OPTIONS)
  if (typeof name !== 'string' || name === '') {
    throw new TypeError(`${prefix}: name must be a non-empty string.`)
  }

  const format = formatOf(prefix, values, isSource, 'a string or a function')

  const { layout, schema, subject, text } = values
  let layoutDefinition: LayoutDefinition | undefined
  if (layout !== undefined) {
    // WeakMap.get() returns undefined for any other value.
    layoutDefinition = layouts.get(layout as object)
    if (!layoutDefinition) {
      throw new TypeError(
        `${prefix}: layout must be created by defineLayout().`
      )
    }
    if (layoutDefinition.format !== format) {
      throw new TypeError(
        `${prefix}: the template is in ${format}, but its layout is in ${layoutDefinition.format}.`
      )
    }
  }
  if (
    schema !== undefined &&
    typeof (schema as { safeParseAsync?: unknown } | null)?.safeParseAsync !==
      'function'
  ) {
    throw new TypeError(`${prefix}: schema must be a Zod schema.`)
  }
  if (typeof subject !== 'string' && typeof subject !== 'object') {
    throw new TypeError(
      `${prefix}: subject must be a string or an object of texts by locale.`
    )
  }
  if (text !== undefined && !isSource(text)) {
    throw new TypeError(`${prefix}: text must be a string or a function.`)
  }

  const own = collectLocales(prefix, [
    ...(typeof subject === 'object' ? [['subject', subject] as const] : []),
    ...translationEntries(prefix, values.translations),
  ])
  const layoutLocales = layout ? (layout as MailLayout).locales : []
  if (own.length > 0 && layoutLocales.length > 0) {
    const missing = own.filter((locale) => !layoutLocales.includes(locale))
    if (missing.length > 0) {
      throw new TypeError(
        `${prefix}: its layout has no translations in ${missing.join(', ')}.`
      )
    }
  }
  const locales = own.length > 0 ? own : [...layoutLocales]

  const template: MailTemplate<DataOf<S>> = Object.freeze({
    name,
    format,
    locales: Object.freeze(locales),
  })
  templates.set(template, {
    name,
    format,
    locales,
    source: values[format] as TemplateSource,
    layout: layoutDefinition,
    schema: schema as z.ZodType | undefined,
    subject: subject as string | Localized,
    translations: (values.translations ?? {}) as Translations,
    text: text as TemplateSource | undefined,
    cache: new Map(),
  })
  return template
}
