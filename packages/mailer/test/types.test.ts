import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  createMailer,
  createMemoryProvider,
  defineLayout,
  defineTemplate,
  renderMail,
  type MailLayout,
  type MailTemplate,
  type TemplateData,
} from '../src/index.js'

// Type-level tests, checked by `tsc -p tsconfig.test.json`.
describe('types', () => {
  it('infers the data from the schema', () => {
    const template = defineTemplate({
      name: 'welcome',
      schema: z.object({ name: z.string(), count: z.number().default(1) }),
      subject: 'Hi',
      html: '',
    })
    expectTypeOf(template).toEqualTypeOf<
      MailTemplate<{ name: string; count?: number | undefined }>
    >()
    expectTypeOf<TemplateData<typeof template>>().toEqualTypeOf<{
      name: string
      count?: number | undefined
    }>()

    void (() => {
      void renderMail(template, { data: { name: 'Ada' } })
      // @ts-expect-error: data is required
      void renderMail(template, {})
      // @ts-expect-error: wrong type
      void renderMail(template, { data: { name: 1 } })
    })
  })

  it('accepts no data without schema', () => {
    const template = defineTemplate({ name: 'plain', subject: 'Hi', html: '' })
    expectTypeOf(template).toEqualTypeOf<MailTemplate<undefined>>()

    void (() => {
      void renderMail(template, {})
      void renderMail(template, { locale: 'fr' })
      // @ts-expect-error: no data
      void renderMail(template, { data: { a: 1 } })
    })
  })

  it('requires every locale in every text', () => {
    defineTemplate({
      name: 'ok',
      subject: { en: 'Hi', fr: 'Salut' },
      translations: { a: { en: 'A', fr: 'A' } },
      html: '',
    })
    void (() =>
      defineTemplate({
        name: 'missing',
        subject: { en: 'Hi', fr: 'Salut' },
        // @ts-expect-error: fr is missing
        translations: { a: { en: 'A' } },
        html: '',
      }))
  })

  it('requires a layout that covers the template locales', () => {
    const layout = defineLayout({
      translations: { footer: { en: 'Footer', fr: 'Pied' } },
      mjml: ({ content }) => content,
    })
    expectTypeOf(layout).toEqualTypeOf<MailLayout<'en' | 'fr'>>()

    defineTemplate({ name: 'a', layout, subject: { en: 'Hi' }, mjml: '' })
    defineTemplate({ name: 'b', layout, subject: 'Hi', mjml: '' })
    defineTemplate({
      name: 'c',
      layout: defineLayout({ mjml: ({ content }) => content }),
      subject: { de: 'Hallo' },
      mjml: '',
    })
    void (() =>
      defineTemplate({
        name: 'd',
        // @ts-expect-error: the layout has no de translations
        layout,
        subject: { de: 'Hallo' },
        mjml: '',
      }))
  })

  it('types the options of mailer.send()', () => {
    const mailer = createMailer({
      provider: createMemoryProvider(),
      from: 'noreply@example.com',
    })
    const template = defineTemplate({
      name: 'welcome',
      schema: z.object({ name: z.string() }),
      subject: 'Hi',
      html: '',
    })
    const plain = defineTemplate({ name: 'plain', subject: 'Hi', html: '' })

    void (async () => {
      const result = await mailer.send(template, {
        to: ['a@example.com', { name: 'B', address: 'b@example.com' }],
        data: { name: 'Ada' },
      })
      expectTypeOf(result.messageId).toEqualTypeOf<string | undefined>()
      await mailer.send(plain, { to: 'a@example.com' })
      // @ts-expect-error: to is required
      await mailer.send(plain, {})
      // @ts-expect-error: data is required
      await mailer.send(template, { to: 'a@example.com' })
      // @ts-expect-error: wrong data
      await mailer.send(template, { to: 'a@example.com', data: { name: 1 } })
      // @ts-expect-error: V1 option
      await mailer.send(plain, { to: 'a@example.com', recipient: 'a' })
      await mailer.send(plain, {
        to: 'a@example.com',
        tags: ['welcome'],
        metadata: { userId: '42' },
      })
      // @ts-expect-error: metadata values are strings
      await mailer.send(plain, { to: 'a@example.com', metadata: { id: 42 } })
      // @ts-expect-error: subject is required
      await mailer.sendMessage({ to: 'a@example.com', text: 'Hi' })
    })
  })

  it('requires exactly one source', () => {
    void (() => {
      // @ts-expect-error: no source
      defineTemplate({ name: 'none', subject: 'Hi' })
      // @ts-expect-error: two sources
      defineTemplate({ name: 'both', subject: 'Hi', html: '', mjml: '' })
      // @ts-expect-error: a layout source is a function
      defineLayout({ mjml: '<mjml></mjml>' })
    })
  })
})
