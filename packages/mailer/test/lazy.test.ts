import { afterEach, describe, expect, it, vi } from 'vitest'

// Fresh modules for each test: the loaders keep the loaded modules.
const load = () => import('../src/index.js')

const notFound = (name: string) =>
  Object.assign(
    new Error(`Cannot find package '${name}' imported from /app/index.js`),
    { code: 'ERR_MODULE_NOT_FOUND' }
  )

afterEach(() => {
  vi.doUnmock('mjml')
  vi.doUnmock('html-to-text')
  vi.resetModules()
})

describe('lazy loading', () => {
  it('loads MJML on the first MJML render only, once', async () => {
    const factory = vi.fn(() => vi.importActual('mjml'))
    vi.doMock('mjml', factory)
    const { defineTemplate, renderMail } = await load()

    await renderMail(
      defineTemplate({ name: 'html', subject: 'Hi', html: '<p>Hi</p>' }),
      {}
    )
    expect(factory).not.toHaveBeenCalled()

    const mjml = (name: string) =>
      defineTemplate({
        name,
        subject: 'Hi',
        mjml: '<mjml><mj-body></mj-body></mjml>',
      })
    await Promise.all([renderMail(mjml('a'), {}), renderMail(mjml('b'), {})])
    await renderMail(mjml('c'), {})
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('loads html-to-text when a text version is converted only', async () => {
    const factory = vi.fn(() => vi.importActual('html-to-text'))
    vi.doMock('html-to-text', factory)
    const { defineTemplate, renderMail } = await load()

    await renderMail(
      defineTemplate({
        name: 'text',
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi',
      }),
      {}
    )
    expect(factory).not.toHaveBeenCalled()

    const converted = defineTemplate({
      name: 'html',
      subject: 'Hi',
      html: '<p>Hi</p>',
    })
    await renderMail(converted, {})
    await renderMail(converted, {})
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('reports a missing MJML package, and tries again', async () => {
    let installed = false
    vi.doMock('mjml', () => {
      if (!installed) throw notFound('mjml')
      return vi.importActual('mjml')
    })
    const { defineTemplate, renderMail, MailRenderError } = await load()
    const template = defineTemplate({
      name: 'missing',
      subject: 'Hi',
      mjml: '<mjml><mj-body></mj-body></mjml>',
    })

    const error = await renderMail(template, {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailRenderError)
    expect((error as Error).message).toBe(
      'Cannot render mail template "missing": MJML is not installed. Install the mjml package, or use html templates.'
    )
    expect((error as Error).cause).toBeInstanceOf(Error)

    installed = true
    expect((await renderMail(template, {})).html).toMatch(/^<!doctype html>/i)
  })

  it('reports other loading failures of MJML', async () => {
    vi.doMock('mjml', () => {
      throw notFound('mjml-core')
    })
    const { defineTemplate, renderMail } = await load()
    const template = defineTemplate({
      name: 'broken',
      subject: 'Hi',
      mjml: '<mjml><mj-body></mj-body></mjml>',
    })
    await expect(renderMail(template, {})).rejects.toThrow(
      'Cannot render mail template "broken": MJML could not be loaded.'
    )
  })

  it('reports MJML failures that are not errors', async () => {
    vi.doMock('mjml', () => ({
      default: () => Promise.reject('MJML crashed'),
    }))
    const { defineTemplate, renderMail } = await load()
    const template = defineTemplate({ name: 'crash', subject: 'Hi', mjml: '' })
    await expect(renderMail(template, {})).rejects.toThrow(
      'Cannot render mail template "crash": invalid MJML: MJML crashed'
    )
  })

  it('reports MJML errors with an empty list of issues', async () => {
    vi.doMock('mjml', () => ({
      default: () =>
        Promise.reject(Object.assign(new Error('Failed'), { errors: [] })),
    }))
    const { defineTemplate, renderMail } = await load()
    const template = defineTemplate({ name: 'empty', subject: 'Hi', mjml: '' })
    await expect(renderMail(template, {})).rejects.toThrow(
      'Cannot render mail template "empty": invalid MJML: Failed'
    )
  })

  it('reports other errors that mention mjml as loading failures', async () => {
    vi.doMock('mjml', () => {
      throw new Error("Cannot read the 'mjml' configuration")
    })
    const { defineTemplate, renderMail } = await load()
    const template = defineTemplate({ name: 'config', subject: 'Hi', mjml: '' })
    await expect(renderMail(template, {})).rejects.toThrow(
      'Cannot render mail template "config": MJML could not be loaded.'
    )
  })

  it('reports a loading failure of html-to-text, and tries again', async () => {
    let failing = true
    vi.doMock('html-to-text', () => {
      if (failing) throw new Error('boom')
      return vi.importActual('html-to-text')
    })
    const { defineTemplate, renderMail } = await load()
    const template = defineTemplate({
      name: 'text',
      subject: 'Hi',
      html: '<p>Hi</p>',
    })
    const error = await renderMail(template, {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).cause).toMatchObject({ message: 'boom' })
    failing = false
    expect((await renderMail(template, {})).text).toBe('Hi')
  })
})
