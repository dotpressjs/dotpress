import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  defineLayout,
  defineTemplate,
  MailDataError,
  MailerError,
  MailRenderError,
  renderMail,
} from '../src/index.js'

const html = (
  options: Partial<Parameters<typeof defineTemplate>[0]> & {
    html?: Parameters<typeof defineTemplate>[0]['html']
  } = {}
) =>
  defineTemplate({
    name: 'test',
    subject: 'Subject',
    html: '<p>Hello</p>',
    ...options,
  } as never)

const localized = defineTemplate({
  name: 'localized',
  subject: { en: 'Hello', fr: 'Bonjour', 'pt-BR': 'Olá' },
  translations: {
    body: { en: 'Body', fr: 'Corps', 'pt-BR': 'Corpo' },
  },
  html: ({ t, locale }) => `<p>${locale}: ${t('body')}</p>`,
})

describe('renderMail()', () => {
  it('renders a template without translations or data', async () => {
    const mail = await renderMail(html(), {})
    expect(mail).toEqual({
      template: 'test',
      locale: undefined,
      subject: 'Subject',
      html: '<p>Hello</p>',
      text: 'Hello',
    })
  })

  it('accepts missing options', async () => {
    const mail = await renderMail(html(), undefined as never)
    expect(mail.subject).toBe('Subject')
  })

  it('ignores the locale of a template without translations', async () => {
    const mail = await renderMail(html(), { locale: 'fr', defaultLocale: 'en' })
    expect(mail.locale).toBeUndefined()
  })

  it('rejects a value that is not a template', async () => {
    const error = new TypeError(
      'renderMail(): expected a template created by defineTemplate().'
    )
    await expect(
      renderMail({ name: 'x', format: 'html', locales: [] }, {} as never)
    ).rejects.toThrow(error)
    await expect(renderMail(null as never, {} as never)).rejects.toThrow(error)
    await expect(renderMail('x' as never, {} as never)).rejects.toThrow(error)
  })

  describe('locales', () => {
    it.each([
      ['fr', undefined, 'fr', 'Bonjour', '<p>fr: Corps</p>'],
      ['FR', undefined, 'fr', 'Bonjour', '<p>fr: Corps</p>'],
      ['fr-CA', undefined, 'fr', 'Bonjour', '<p>fr: Corps</p>'],
      ['fr_CA', undefined, 'fr', 'Bonjour', '<p>fr: Corps</p>'],
      ['pt-br', undefined, 'pt-BR', 'Olá', '<p>pt-BR: Corpo</p>'],
      ['de', 'en', 'en', 'Hello', '<p>en: Body</p>'],
      ['de-CH', 'fr-CA', 'fr', 'Bonjour', '<p>fr: Corps</p>'],
      [undefined, 'fr', 'fr', 'Bonjour', '<p>fr: Corps</p>'],
      ['', 'fr', 'fr', 'Bonjour', '<p>fr: Corps</p>'],
    ])(
      'renders %s (default %s) in %s',
      async (locale, defaultLocale, expected, subject, body) => {
        const mail = await renderMail(localized, { locale, defaultLocale })
        expect(mail).toMatchObject({ locale: expected, subject, html: body })
      }
    )

    it('fails when no locale is available', async () => {
      await expect(
        renderMail(localized, { locale: 'de', defaultLocale: 'it' })
      ).rejects.toThrow(
        new MailRenderError(
          'localized',
          'no translations for de or it (available: en, fr, pt-BR).'
        )
      )
      await expect(renderMail(localized, { locale: 'de' })).rejects.toThrow(
        'Cannot render mail template "localized": no translations for de (available: en, fr, pt-BR).'
      )
    })

    it('fails without locale nor default locale', async () => {
      await expect(renderMail(localized, {})).rejects.toThrow(
        'Cannot render mail template "localized": no locale requested and no default locale (available: en, fr, pt-BR).'
      )
    })

    it('renders the locales of the layout', async () => {
      const layout = defineLayout({
        translations: { footer: { en: 'Footer', fr: 'Pied de page' } },
        html: ({ t, content, locale }) =>
          `<main>${content}</main><footer>${locale} ${t('footer')}</footer>`,
      })
      const template = defineTemplate({
        name: 'inherit',
        layout,
        subject: 'Hi',
        html: ({ locale }) => `<p>${locale}</p>`,
      })
      const mail = await renderMail(template, { locale: 'fr-BE' })
      expect(mail.locale).toBe('fr')
      expect(mail.html).toBe(
        '<main><p>fr</p></main><footer>fr Pied de page</footer>'
      )
    })
  })

  describe('translations', () => {
    it('fails for an unknown key', async () => {
      const template = defineTemplate({
        name: 'unknown',
        subject: { en: 'Hi' },
        translations: { a: { en: 'A' } },
        html: ({ t }) => t('b'),
      })
      const promise = renderMail(template, { locale: 'en' })
      await expect(promise).rejects.toBeInstanceOf(MailRenderError)
      await expect(promise).rejects.toThrow(
        'Cannot render mail template "unknown": unknown translation key "b" in the template.'
      )
    })

    it('only reads own keys', async () => {
      const template = defineTemplate({
        name: 'proto',
        subject: { en: 'Hi' },
        html: ({ t }) => t('toString'),
      })
      await expect(renderMail(template, { locale: 'en' })).rejects.toThrow(
        'unknown translation key "toString" in the template.'
      )
    })

    it('ignores inherited keys', async () => {
      const translations = Object.create(
        { inherited: { en: 'Inherited' } },
        { own: { value: { en: 'Own' }, enumerable: true } }
      ) as Record<string, { en: string }>
      const template = defineTemplate({
        name: 'inherited',
        subject: { en: 'Hi' },
        translations,
        html: ({ t }) => `${t('own')} ${t('inherited')}`,
      })
      await expect(renderMail(template, { locale: 'en' })).rejects.toThrow(
        'unknown translation key "inherited" in the template.'
      )
    })

    it('fails in a layout without translations', async () => {
      const template = html({
        layout: defineLayout({ html: ({ t }) => t('footer') }),
      })
      const error = await renderMail(template, {}).catch((e: unknown) => e)
      expect(error).toMatchObject({
        name: 'MailRenderError',
        message:
          'Cannot render mail template "test": unknown translation key "footer" in the layout.',
      })
    })

    it('fails without translations', async () => {
      const template = html({ html: ({ t }) => t('a') })
      await expect(renderMail(template, {})).rejects.toThrow(
        'Cannot render mail template "test": unknown translation key "a" in the template.'
      )
    })

    it('separates the translations of the layout and of the template', async () => {
      const layout = defineLayout({
        translations: { footer: { en: 'Footer' } },
        html: ({ t, content }) => `${content}${t('body')}`,
      })
      const template = defineTemplate({
        name: 'scoped',
        layout,
        subject: 'Hi',
        translations: { body: { en: 'Body' } },
        html: ({ t }) => t('footer'),
      })
      await expect(renderMail(template, { locale: 'en' })).rejects.toThrow(
        'unknown translation key "footer" in the template.'
      )

      const layoutOnly = defineTemplate({
        name: 'scoped',
        layout,
        subject: 'Hi',
        translations: { body: { en: 'Body' } },
        html: ({ t }) => t('body'),
      })
      await expect(renderMail(layoutOnly, { locale: 'en' })).rejects.toThrow(
        'unknown translation key "body" in the layout.'
      )
    })

    it('keeps Mustache tags of the translations', async () => {
      const template = defineTemplate({
        name: 'greeting',
        schema: z.object({ name: z.string() }),
        subject: { en: 'Hi' },
        translations: { hello: { en: 'Hello {{name}}' } },
        html: ({ t }) => `<p>${t('hello')}</p>`,
      })
      const mail = await renderMail(template, {
        locale: 'en',
        data: { name: 'Ada' },
      })
      expect(mail.html).toBe('<p>Hello Ada</p>')
    })
  })

  describe('source functions', () => {
    it('wraps their errors', async () => {
      const failure = new Error('boom')
      const template = html({
        html: () => {
          throw failure
        },
      })
      const error = await renderMail(template, {}).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(MailRenderError)
      expect(error).toMatchObject({
        message:
          'Cannot render mail template "test": the template source function failed.',
        template: 'test',
        cause: failure,
      })
    })

    it('wraps errors of the layout', async () => {
      const layout = defineLayout({
        html: () => {
          throw new Error('boom')
        },
      })
      const template = html({ layout })
      await expect(renderMail(template, {})).rejects.toThrow(
        'Cannot render mail template "test": the layout source function failed.'
      )
    })

    it('must return a string', async () => {
      await expect(
        renderMail(html({ html: (() => 1) as never }), {})
      ).rejects.toThrow(
        new MailRenderError(
          'test',
          'the template source function must return a string.'
        )
      )
      await expect(
        renderMail(html({ text: (() => undefined) as never }), {})
      ).rejects.toThrow(
        new MailRenderError(
          'test',
          'the text source function must return a string.'
        )
      )
    })

    it('runs once by locale (cache)', async () => {
      const source = vi.fn(({ locale }) => `<p>${locale}</p>`)
      const layoutSource = vi.fn(({ content }) => content)
      const template = defineTemplate({
        name: 'cached',
        layout: defineLayout({ html: layoutSource }),
        subject: { en: 'Hi', fr: 'Salut' },
        html: source,
      })
      const renders = await Promise.all([
        renderMail(template, { locale: 'en' }),
        renderMail(template, { locale: 'en' }),
        renderMail(template, { locale: 'fr' }),
      ])
      await renderMail(template, { locale: 'en-GB' })
      expect(renders.map((mail) => mail.html)).toEqual([
        '<p>en</p>',
        '<p>en</p>',
        '<p>fr</p>',
      ])
      expect(source).toHaveBeenCalledTimes(2)
      expect(layoutSource).toHaveBeenCalledTimes(2)
    })

    it('runs again after a failure', async () => {
      const source = vi
        .fn<() => string>()
        .mockImplementationOnce(() => {
          throw new Error('boom')
        })
        .mockReturnValue('<p>ok</p>')
      const template = html({ html: source })
      await expect(renderMail(template, {})).rejects.toThrow(MailRenderError)
      expect((await renderMail(template, {})).html).toBe('<p>ok</p>')
      await renderMail(template, {})
      expect(source).toHaveBeenCalledTimes(2)
    })
  })

  describe('data', () => {
    const schema = z.object({
      name: z.string().trim(),
      count: z.number().int(),
      items: z.array(z.string()).default([]),
    })
    const template = defineTemplate({
      name: 'data',
      schema,
      subject: '{{name}} ({{count}})',
      html: '<p>{{name}}: {{count}}</p><ul>{{#items}}<li>{{.}}</li>{{/items}}</ul>',
    })

    it('inserts the parsed data', async () => {
      const mail = await renderMail(template, {
        data: { name: '  Ada  ', count: 0, items: ['a', 'b'] },
      })
      expect(mail.subject).toBe('Ada (0)')
      expect(mail.html).toBe('<p>Ada: 0</p><ul><li>a</li><li>b</li></ul>')
    })

    it('rejects invalid data', async () => {
      const error = await renderMail(template, {
        data: { name: 1, count: 1.5 } as never,
      }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(MailDataError)
      expect(error).toBeInstanceOf(MailerError)
      expect(error).toMatchObject({
        name: 'MailDataError',
        template: 'data',
        issues: [
          { path: ['name'], message: expect.any(String) },
          { path: ['count'], message: expect.any(String) },
        ],
      })
      expect((error as Error).message).toMatch(
        /^Invalid data for mail template "data": name: .+; count: .+$/
      )
    })

    it('reports an issue on the data itself', async () => {
      await expect(
        renderMail(template, { data: undefined as never })
      ).rejects.toThrow(
        'Invalid data for mail template "data": Invalid input: expected object, received undefined'
      )
    })

    it('reports symbol keys of paths', async () => {
      const key = Symbol('key')
      const symbolic = defineTemplate({
        name: 'symbol',
        schema: z.object({}).superRefine((_, ctx) => {
          ctx.addIssue({ code: 'custom', message: 'bad', path: [key, 0] })
        }),
        subject: 'Hi',
        html: '',
      })
      await expect(renderMail(symbolic, { data: {} })).rejects.toMatchObject({
        issues: [{ path: ['Symbol(key)', 0], message: 'bad' }],
      })
    })

    it('rejects data without schema', async () => {
      const error = await renderMail(html(), { data: {} as never }).catch(
        (e: unknown) => e
      )
      expect(error).toBeInstanceOf(MailDataError)
      expect((error as Error).message).toBe(
        'Invalid data for mail template "test": the template has no schema and accepts no data'
      )
    })

    it.each([
      ['a string', z.string()],
      ['null', z.null()],
      ['an array', z.array(z.string())],
    ])('rejects a schema that produces %s', async (_, schema) => {
      const template = defineTemplate({
        name: 'scalar',
        schema: schema as z.ZodType,
        subject: 'Hi',
        html: '',
      })
      await expect(
        renderMail(template, {
          data: (schema instanceof z.ZodString
            ? 'a'
            : schema instanceof z.ZodNull
              ? null
              : []) as never,
        })
      ).rejects.toThrow(
        'Invalid data for mail template "scalar": the schema must produce an object'
      )
    })

    it('supports async refinements', async () => {
      const template = defineTemplate({
        name: 'async',
        schema: z.object({ a: z.string().refine(async (v) => v === 'ok') }),
        subject: 'Hi',
        html: '{{a}}',
      })
      expect((await renderMail(template, { data: { a: 'ok' } })).html).toBe(
        'ok'
      )
      await expect(
        renderMail(template, { data: { a: 'ko' } })
      ).rejects.toBeInstanceOf(MailDataError)
    })
  })

  describe('escaping', () => {
    const template = defineTemplate({
      name: 'escape',
      schema: z.object({ value: z.string() }),
      subject: 'Subject {{value}} {{{value}}}',
      html: '<a href="{{value}}">{{value}}</a><a href="{{{value}}}">{{{value}}}</a>',
      text: 'Text {{value}} {{{value}}}',
    })
    const value = `https://a.example/p?x=1&y=<2>"'\`/=`

    it('escapes & < > " \' in the HTML version only', async () => {
      const mail = await renderMail(template, { data: { value } })
      const escaped = 'https://a.example/p?x=1&amp;y=&lt;2&gt;&quot;&#39;`/='
      expect(mail.html).toBe(
        `<a href="${escaped}">${escaped}</a><a href="${value}">${value}</a>`
      )
      expect(mail.subject).toBe(`Subject ${value} ${value}`)
      expect(mail.text).toBe(`Text ${value} ${value}`)
    })

    it('keeps links readable by email clients', async () => {
      const mail = await renderMail(template, {
        data: { value: 'https://app.example.com/reset?token=a1/b2=&lang=fr' },
      })
      expect(mail.html).toContain(
        'href="https://app.example.com/reset?token=a1/b2=&amp;lang=fr"'
      )
    })

    it('does not change the default escaping of Mustache', async () => {
      const { default: mustache } = await import('mustache')
      await renderMail(template, { data: { value } })
      expect(mustache.render('{{v}}', { v: '/=' })).toBe('&#x2F;&#x3D;')
    })

    it('reports invalid Mustache', async () => {
      const broken = (part: 'html' | 'subject' | 'text') =>
        html({ [part]: '{{#open}}' })
      for (const [part, label] of [
        ['html', 'HTML'],
        ['subject', 'subject'],
        ['text', 'text'],
      ] as const) {
        const error = await renderMail(broken(part), {}).catch(
          (e: unknown) => e
        )
        expect(error).toBeInstanceOf(MailRenderError)
        expect((error as Error).message).toMatch(
          new RegExp(
            `^Cannot render mail template "test": invalid Mustache in the ${label}: Unclosed section "open"`
          )
        )
        expect((error as Error).cause).toBeInstanceOf(Error)
      }
    })

    it('ignores partials', async () => {
      expect(
        (await renderMail(html({ html: '<p>{{> footer}}</p>' }), {})).html
      ).toBe('<p></p>')
    })
  })

  describe('subject', () => {
    it('is a single line', async () => {
      const template = defineTemplate({
        name: 'lines',
        schema: z.object({ value: z.string() }),
        subject: '  Hello\n {{value}}  ',
        html: '',
      })
      const mail = await renderMail(template, {
        data: { value: 'a\r\nb\n\nc \r d' },
      })
      expect(mail.subject).toBe('Hello a b c d')
    })
  })

  describe('text version', () => {
    it('uses the text source with translations', async () => {
      const template = defineTemplate({
        name: 'text',
        schema: z.object({ url: z.string() }),
        subject: { en: 'Hi', fr: 'Salut' },
        translations: { cta: { en: 'Open', fr: 'Ouvrir' } },
        html: '<p>HTML</p>',
        text: ({ t, locale }) => `${locale} ${t('cta')}: {{url}}`,
      })
      const mail = await renderMail(template, {
        locale: 'fr',
        data: { url: 'https://a.example/?a=1&b=2' },
      })
      expect(mail.text).toBe('fr Ouvrir: https://a.example/?a=1&b=2')
    })

    it('fails for an unknown key of the text source', async () => {
      const template = html({ text: ({ t }) => t('missing') })
      await expect(renderMail(template, {})).rejects.toThrow(
        'unknown translation key "missing" in the template.'
      )
    })

    it('converts the HTML version by default', async () => {
      const template = defineTemplate({
        name: 'convert',
        schema: z.object({ url: z.string() }),
        subject: 'Hi',
        html: `<html><head><title>Title</title><style>p { color: red }</style></head><body>
<div style="display:none;font-size:1px">Preview</div>
<div style="display: none">Hidden</div>
<img src="https://a.example/logo.png" alt="Logo">
<h1>Welcome</h1>
<p>Click <a href="{{url}}">this link</a>, or open <a href="{{url}}">{{url}}</a>.</p>
<p>${'word '.repeat(30).trim()}</p>
</body></html>`,
      })
      const mail = await renderMail(template, {
        data: { url: 'https://a.example/?a=1&b=2' },
      })
      expect(mail.text).toBe(
        [
          'WELCOME',
          '',
          'Click this link [https://a.example/?a=1&b=2], or open',
          'https://a.example/?a=1&b=2.',
          '',
          `${'word '.repeat(15).trim()}`,
          `${'word '.repeat(15).trim()}`,
        ].join('\n')
      )
    })

    it('converts data tables in columns, and layout tables as blocks', async () => {
      const template = html({
        html: `<table role="presentation"><tr><td>
<p>Your receipt</p>
<table><tr><td>Plan</td><td>29.00</td></tr><tr><td>Storage</td><td>4.50</td></tr></table>
</td></tr><tr><td><p>Thanks</p></td></tr></table>`,
      })
      const mail = await renderMail(template, {})
      expect(mail.text).toBe(
        [
          'Your receipt',
          '',
          'Plan      29.00',
          'Storage   4.50',
          '',
          'Thanks',
        ].join('\n')
      )
    })
  })
})
