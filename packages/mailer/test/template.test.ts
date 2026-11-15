import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineLayout, defineTemplate } from '../src/index.js'

const content = ({ content }: { content: string }) => content

describe('defineLayout()', () => {
  it('returns a frozen layout with its format and sorted locales', () => {
    const layout = defineLayout({
      translations: {
        footer: { fr: 'Pied', en: 'Footer' },
        title: { en: 'Title', fr: 'Titre' },
      },
      mjml: content,
    })
    expect(layout).toEqual({ format: 'mjml', locales: ['en', 'fr'] })
    expect(Object.isFrozen(layout)).toBe(true)
    expect(Object.isFrozen(layout.locales)).toBe(true)
    expect(defineLayout({ html: content })).toEqual({
      format: 'html',
      locales: [],
    })
  })

  it.each([
    ['not an object', null, 'expected an object.'],
    ['an array', [], 'expected an object.'],
    ['a string', 'x', 'expected an object.'],
    [
      'an unknown option',
      { html: content, name: 'x' },
      'unknown option "name".',
    ],
    ['no source', {}, 'set exactly one of mjml and html.'],
    [
      'both sources',
      { html: content, mjml: content },
      'set exactly one of mjml and html.',
    ],
    [
      'a string source',
      { mjml: '<mjml></mjml>' },
      'mjml must be a function that receives the template content.',
    ],
    [
      'translations that are not an object',
      { html: content, translations: [] },
      'translations must be an object.',
    ],
    [
      'a translation that is not an object',
      { html: content, translations: { a: 'text' } },
      'translations.a must be an object of texts by locale.',
    ],
    [
      'a translation without locale',
      { html: content, translations: { a: {} } },
      'translations.a has no locale.',
    ],
    [
      'a translation that is not a string',
      { html: content, translations: { a: { en: 1 } } },
      'translations.a.en must be a string.',
    ],
    [
      'translations with different locales',
      {
        html: content,
        translations: { a: { en: 'A', fr: 'A' }, b: { en: 'B' } },
      },
      'translations.b has the locales en, but translations.a has en, fr. Every text needs the same locales.',
    ],
  ])('rejects %s', (_, options, message) => {
    expect(() => defineLayout(options as never)).toThrow(
      new TypeError(`defineLayout(): ${message}`)
    )
  })
})

describe('defineTemplate()', () => {
  const layout = defineLayout({
    translations: { footer: { en: 'Footer', fr: 'Pied', de: 'Fuß' } },
    html: content,
  })

  it('returns a frozen template with its name, format and locales', () => {
    const template = defineTemplate({
      name: 'welcome',
      subject: { fr: 'Bienvenue', en: 'Welcome' },
      translations: { hello: { en: 'Hello', fr: 'Bonjour' } },
      mjml: '<mj-section></mj-section>',
    })
    expect(template).toEqual({
      name: 'welcome',
      format: 'mjml',
      locales: ['en', 'fr'],
    })
    expect(Object.isFrozen(template)).toBe(true)
    expect(Object.isFrozen(template.locales)).toBe(true)
  })

  it('has no locale without translations', () => {
    const template = defineTemplate({
      name: 'plain',
      subject: 'Hello',
      html: () => '<p>Hello</p>',
    })
    expect(template).toEqual({ name: 'plain', format: 'html', locales: [] })
  })

  it('takes the locales of the subject', () => {
    expect(
      defineTemplate({
        name: 'subject',
        subject: { en: 'Hello', fr: 'Bonjour' },
        html: '<p></p>',
      }).locales
    ).toEqual(['en', 'fr'])
  })

  it('takes the locales of its layout without its own translations', () => {
    expect(
      defineTemplate({ name: 'inherit', layout, subject: 'Hi', html: '' })
        .locales
    ).toEqual(['de', 'en', 'fr'])
  })

  it('keeps its own locales when the layout has more', () => {
    expect(
      defineTemplate({
        name: 'own',
        layout,
        subject: { en: 'Hi', fr: 'Salut' },
        html: '',
      }).locales
    ).toEqual(['en', 'fr'])
  })

  it('accepts a layout without translations', () => {
    expect(
      defineTemplate({
        name: 'own',
        layout: defineLayout({ html: content }),
        subject: { en: 'Hi', fr: 'Salut' },
        html: '',
      }).locales
    ).toEqual(['en', 'fr'])
  })

  it('accepts a schema, a text source and an empty source', () => {
    const template = defineTemplate({
      name: 'full',
      schema: z.object({ a: z.string() }),
      subject: 'Hi',
      text: () => 'text',
      html: '',
    })
    expect(template.name).toBe('full')
    expect(
      defineTemplate({ name: 'text', subject: 'Hi', text: 'Hi', html: '' })
        .format
    ).toBe('html')
  })

  it.each([
    ['not an object', null, 'defineTemplate(): expected an object.'],
    ['an array', [], 'defineTemplate(): expected an object.'],
    [
      'no name',
      { subject: 'Hi', html: '' },
      'defineTemplate(): name must be a non-empty string.',
    ],
    [
      'an empty name',
      { name: '', subject: 'Hi', html: '' },
      'defineTemplate(): name must be a non-empty string.',
    ],
    [
      'a name that is not a string',
      { name: 1, subject: 'Hi', html: '' },
      'defineTemplate(): name must be a non-empty string.',
    ],
    [
      'an unknown option',
      { name: 'x', subject: 'Hi', html: '', variables: [] },
      'defineTemplate("x"): unknown option "variables".',
    ],
    [
      'no source',
      { name: 'x', subject: 'Hi' },
      'defineTemplate("x"): set exactly one of mjml and html.',
    ],
    [
      'both sources',
      { name: 'x', subject: 'Hi', html: '', mjml: '' },
      'defineTemplate("x"): set exactly one of mjml and html.',
    ],
    [
      'an invalid source',
      { name: 'x', subject: 'Hi', mjml: 1 },
      'defineTemplate("x"): mjml must be a string or a function.',
    ],
    [
      'a layout that is not from defineLayout()',
      { name: 'x', subject: 'Hi', html: '', layout: { format: 'html' } },
      'defineTemplate("x"): layout must be created by defineLayout().',
    ],
    [
      'a null layout',
      { name: 'x', subject: 'Hi', html: '', layout: null },
      'defineTemplate("x"): layout must be created by defineLayout().',
    ],
    [
      'a layout in another format',
      { name: 'x', subject: 'Hi', mjml: '', layout },
      'defineTemplate("x"): the template is in mjml, but its layout is in html.',
    ],
    [
      'a schema that is not a Zod schema',
      { name: 'x', subject: 'Hi', html: '', schema: { parse: () => ({}) } },
      'defineTemplate("x"): schema must be a Zod schema.',
    ],
    [
      'a null schema',
      { name: 'x', subject: 'Hi', html: '', schema: null },
      'defineTemplate("x"): schema must be a Zod schema.',
    ],
    [
      'no subject',
      { name: 'x', html: '' },
      'defineTemplate("x"): subject must be a string or an object of texts by locale.',
    ],
    [
      'a null subject',
      { name: 'x', subject: null, html: '' },
      'defineTemplate("x"): subject must be an object of texts by locale.',
    ],
    [
      'a subject without locale',
      { name: 'x', subject: {}, html: '' },
      'defineTemplate("x"): subject has no locale.',
    ],
    [
      'a text that is not a string or a function',
      { name: 'x', subject: 'Hi', html: '', text: 1 },
      'defineTemplate("x"): text must be a string or a function.',
    ],
    [
      'invalid translations',
      { name: 'x', subject: 'Hi', html: '', translations: 'a' },
      'defineTemplate("x"): translations must be an object.',
    ],
    [
      'a subject in other locales than the translations',
      {
        name: 'x',
        subject: { en: 'Hi', fr: 'Salut' },
        html: '',
        translations: { a: { en: 'A' } },
      },
      'defineTemplate("x"): translations.a has the locales en, but subject has en, fr. Every text needs the same locales.',
    ],
    [
      'locales missing in the layout',
      {
        name: 'x',
        subject: { en: 'Hi', es: 'Hola', it: 'Ciao' },
        html: '',
        layout,
      },
      'defineTemplate("x"): its layout has no translations in es, it.',
    ],
  ])('rejects %s', (_, options, message) => {
    expect(() => defineTemplate(options as never)).toThrow(
      new TypeError(message)
    )
  })
})
