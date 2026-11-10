import { createRouter } from '@dotpress/core'
import { createTestApp } from '@dotpress/testing'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  createMailer,
  createMemoryProvider,
  defineTemplate,
} from '../src/index.js'
import { mailerPlugin } from '../src/plugin.js'

const invitation = defineTemplate({
  name: 'invitation',
  schema: z.object({ team: z.string() }),
  subject: 'Join {{team}}',
  html: '<p>Join {{team}}</p>',
})

const setup = async (withPlugin = true) => {
  const outbox = createMemoryProvider()
  const mailer = createMailer({ provider: outbox, from: 'noreply@example.com' })
  const router = createRouter()
  router.defineRoute({
    method: 'post',
    path: '/invitations',
    handler: async ({ mailer }) => {
      const { messageId } = await mailer.send(invitation, {
        to: 'ada@example.com',
        data: { team: 'Core' },
      })
      return { messageId }
    },
  })
  const app = await createTestApp({
    routers: [router],
    plugins: withPlugin ? [mailerPlugin(mailer)] : [],
  })
  return { ...app, outbox, mailer }
}

describe('mailerPlugin()', () => {
  it('provides ctx.mailer', async () => {
    const { fetch, outbox, close, app } = await setup()
    const res = await fetch('/invitations', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ messageId: 'memory-1' })
    expect(outbox.last()).toMatchObject({
      to: [{ address: 'ada@example.com' }],
      subject: 'Join Core',
    })
    expect(app.plugins.map((plugin) => plugin.name)).toContain('mailer')
    await close()
  })

  it('logs with the request logger', async () => {
    const { fetch, logger, close } = await setup()
    await fetch('/invitations', { method: 'POST' })
    expect(
      logger.entries.filter(({ args }) => args[1] === 'Mail sent')
    ).toEqual([
      {
        level: 'info',
        args: [
          {
            provider: 'memory',
            template: 'invitation',
            messageId: 'memory-1',
            recipients: 1,
          },
          'Mail sent',
        ],
      },
    ])
    await close()
  })

  it('exposes the mailer on the plugin', () => {
    const mailer = createMailer({
      provider: createMemoryProvider(),
      from: 'noreply@example.com',
    })
    const plugin = mailerPlugin(mailer)
    expect(plugin.name).toBe('mailer')
    expect(plugin.mailer).toBe(mailer)
  })

  it('fails clearly when the plugin is not installed', async () => {
    const { fetch, logger, close } = await setup(false)
    const res = await fetch('/invitations', { method: 'POST' })
    expect(res.status).toBe(500)
    const [error] = logger.entries.find(({ level }) => level === 'error')
      ?.args as [Error]
    expect(error.message).toContain('mailerPlugin')
    await close()
  })

  it('rejects a value that is not a mailer', () => {
    expect(() => mailerPlugin({} as never)).toThrow(
      new TypeError(
        'mailerPlugin(): expected a mailer created by createMailer().'
      )
    )
    expect(() => mailerPlugin(undefined as never)).toThrow(TypeError)
  })
})
