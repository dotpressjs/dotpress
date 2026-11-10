import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { main, USAGE } from '../src/cli.js'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const globals = globalThis as {
  fixtureResult?: unknown
  fixtureLogged?: boolean
}

/** Runs the command in the fixtures directory, stopped by `stop()`. */
const start = (args: string[], cwd = fixtures) => {
  let stdout = ''
  let stderr = ''
  const controller = new AbortController()
  const watch = vi.fn(async () => 7)
  const code = main(args, {
    cwd,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    signal: controller.signal,
    watch,
  })
  return {
    code,
    watch,
    stop: () => controller.abort(),
    output: () => ({ stdout, stderr }),
  }
}

const run = async (args: string[]) => {
  const command = start(args)
  const code = await command.code
  return { code, ...command.output() }
}

describe('dotpress-events', () => {
  it('prints the usage', async () => {
    expect(await run(['--help'])).toEqual({
      code: 0,
      stdout: USAGE,
      stderr: '',
    })
    expect(await run([])).toEqual({ code: 1, stdout: '', stderr: USAGE })
    expect(await run(['work'])).toEqual({ code: 1, stdout: '', stderr: USAGE })
    expect(await run(['listen', 'worker.mjs'])).toEqual({
      code: 1,
      stdout: '',
      stderr: USAGE,
    })
    expect(await run(['work', 'a.mjs', 'b.mjs'])).toEqual({
      code: 1,
      stdout: '',
      stderr: USAGE,
    })
    const unknown = await run(['work', 'worker.mjs', '--port', '3000'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("Unknown option '--port'")
    expect(unknown.stderr).toContain(USAGE)
  })

  it('runs the worker until stopped', async () => {
    globals.fixtureResult = undefined
    const command = start(['work', 'worker.mjs'])
    await vi.waitFor(() => expect(globals.fixtureResult).toBeDefined())
    expect(globals.fixtureResult).toEqual({ status: 'success' })
    command.stop()
    expect(await command.code).toBe(0)

    const lines = command
      .output()
      .stderr.trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toEqual([
      {
        level: 'info',
        time: expect.any(String),
        message: 'Event worker started',
        source: 'fixture',
        listeners: ['fixture'],
      },
      {
        level: 'info',
        time: expect.any(String),
        message: 'Fixture source consuming',
        step: 'consuming',
      },
      {
        level: 'info',
        time: expect.any(String),
        message: 'Event worker stopped',
        source: 'fixture',
      },
    ])
    expect(command.output().stdout).toBe('')
  })

  it('uses a factory export and the logger of the entry', async () => {
    globals.fixtureLogged = false
    const command = start(['work', 'worker.mjs', '--export', 'factory'])
    await vi.waitFor(() =>
      expect(command.output().stderr).toContain('Event worker started')
    )
    command.stop()
    expect(await command.code).toBe(0)

    const withLogger = start(['work', 'worker.mjs', '--export', 'withLogger'])
    await vi.waitFor(() => expect(globals.fixtureLogged).toBe(true))
    withLogger.stop()
    expect(await withLogger.code).toBe(0)
    expect(withLogger.output().stderr).toBe('')
  })

  it('restarts under node --watch', async () => {
    const command = start(['work', 'worker.mjs', '--watch', '--export', 'x'])
    expect(await command.code).toBe(7)
    expect(command.watch).toHaveBeenCalledWith([
      'work',
      'worker.mjs',
      '--export',
      'x',
    ])
  })

  it.each([
    [
      'a missing module',
      ['work', 'missing.mjs'],
      `Module not found: ${fixtures}missing.mjs\n`,
    ],
    [
      'a missing export',
      ['work', 'worker.mjs', '--export', 'nope'],
      'worker.mjs has no "nope" export (exports: default, factory, failing, failingWithText, invalid, withLogger). Choose one with --export.\n',
    ],
    [
      'an export that is not an entry',
      ['work', 'worker.mjs', '--export', 'invalid'],
      'The "invalid" export of worker.mjs must be { worker, source }: a worker created by createWorker() and the source of a transport, or a function returning them.\n',
    ],
  ])('reports %s', async (_, args, message) => {
    expect(await run(args)).toEqual({ code: 1, stdout: '', stderr: message })
  })

  it('reports a module that cannot be loaded', async () => {
    const { code, stderr } = await run(['work', 'broken.mjs'])
    expect(code).toBe(1)
    expect(stderr).toBe(
      `Cannot load ${fixtures}broken.mjs: syntax is fine, but this module throws\n`
    )
  })

  it('suggests how to load TypeScript modules', async () => {
    const { code, stderr } = await run(['work', 'broken.ts'])
    expect(code).toBe(1)
    expect(stderr).toContain('TypeScript modules require Node.js 22.18')
  })

  it('reports a failing source', async () => {
    const { code, stderr } = await run([
      'work',
      'worker.mjs',
      '--export',
      'failing',
    ])
    expect(code).toBe(1)
    expect(stderr).toMatch(/Worker failed: Error: connection refused\n {4}at /)

    const text = await run([
      'work',
      'worker.mjs',
      '--export',
      'failingWithText',
    ])
    expect(text.stderr).toContain('Worker failed: connection refused\n')
  })

  it('runs as a binary', async () => {
    const bin = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
    if (!existsSync(bin)) return
    const output = await new Promise<{ code: number | null; stdout: string }>(
      (resolve) => {
        execFile(process.execPath, [bin, '--help'], (error, stdout) =>
          resolve({ code: error ? (error.code as number) : 0, stdout })
        )
      }
    )
    expect(output).toEqual({ code: 0, stdout: USAGE })
  })
})
