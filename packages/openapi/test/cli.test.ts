import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { main, USAGE } from '../src/cli.js'
import type { OpenApiDocument } from '../src/index.js'
import { expectValid } from './support.js'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))

/** Runs the command in the fixtures directory. */
const run = async (args: string[], cwd = fixtures) => {
  let stdout = ''
  let stderr = ''
  const code = await main(args, {
    cwd,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  })
  return { code, stdout, stderr }
}

const temporary: string[] = []
afterEach(async () => {
  for (const dir of temporary.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('dotpress-openapi', () => {
  it('prints the usage', async () => {
    expect(await run(['--help'])).toEqual({
      code: 0,
      stdout: USAGE,
      stderr: '',
    })
    expect(await run([])).toEqual({ code: 1, stdout: '', stderr: USAGE })
    expect(await run(['a.mjs', 'b.mjs'])).toEqual({
      code: 1,
      stdout: '',
      stderr: USAGE,
    })

    const unknown = await run(['app.mjs', '--port', '3000'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("Unknown option '--port'")
  })

  it('prints the document of openapiPlugin(), and closes the app', async () => {
    const global = globalThis as { fixtureClosed?: boolean }
    global.fixtureClosed = false

    const { code, stdout, stderr } = await run(['with-plugin.mjs'])

    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(stdout.endsWith('}\n')).toBe(true)
    const document = JSON.parse(stdout) as OpenApiDocument
    expect(document.info).toEqual({ title: 'Plugin API', version: '9.0.0' })
    expect(Object.keys(document.paths)).toEqual(['/users/{id}'])
    expect(stdout).toBe(`${JSON.stringify(document, null, 2)}\n`)
    expect(global.fixtureClosed).toBe(true)
  })

  it('ignores --title and --api-version with openapiPlugin()', async () => {
    const { code, stdout, stderr } = await run([
      'with-plugin.mjs',
      '--title',
      'Other',
    ])

    expect(code).toBe(0)
    expect(JSON.parse(stdout).info.title).toBe('Plugin API')
    expect(stderr).toBe(
      'Warning: --title and --api-version are ignored, the document of openapiPlugin() is used.\n'
    )
  })

  it('generates the document of an app created by a factory', async () => {
    const { code, stdout, stderr } = await run([
      'factory.ts',
      '--export',
      'createApp',
    ])

    expect(code).toBe(0)
    const document = JSON.parse(stdout) as OpenApiDocument
    // From the package.json of the directory.
    expect(document.info).toEqual({ title: 'fixture-api', version: '3.2.1' })
    expect(Object.keys(document.paths)).toEqual(['/items', '/big'])
    await expectValid(document)
    expect(stderr).toBe(
      'Warning: GET /big (response): bigint cannot be represented in JSON Schema, documented as any value.\n'
    )
  })

  it('takes the title and the version from the options', async () => {
    const options = ['--title', 'My API', '--api-version', '2.0.0']
    const { stdout } = await run([
      'factory.ts',
      '--export',
      'createApp',
      ...options,
    ])
    expect(JSON.parse(stdout).info).toEqual({
      title: 'My API',
      version: '2.0.0',
    })

    // Without package.json: the options are required.
    const dir = await mkdtemp(join(tmpdir(), 'dotpress-openapi-'))
    temporary.push(dir)
    const module = join(fixtures, 'factory.ts')
    const failed = await run([module, '--export', 'createApp'], dir)
    expect(failed).toEqual({
      code: 1,
      stdout: '',
      stderr:
        'dotpress-openapi: Without openapiPlugin(), the document needs --title and --api-version, or a package.json with a name and a version in the current directory.\n',
    })
    const partial = await run(
      [module, '--export', 'createApp', '--title', 'My API'],
      dir
    )
    expect(partial.code).toBe(1)
    const complete = await run(
      [module, '--export', 'createApp', ...options],
      dir
    )
    expect(complete.code).toBe(0)
  })

  it('writes the document to a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dotpress-openapi-'))
    temporary.push(dir)
    const out = join(dir, 'openapi.json')

    const { code, stdout, stderr } = await run([
      'with-plugin.mjs',
      '--out',
      out,
    ])

    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toBe(`OpenAPI document written to ${out} (1 path).\n`)
    expect(JSON.parse(await readFile(out, 'utf8')).info.title).toBe(
      'Plugin API'
    )
  })

  it('reports modules that cannot be used', async () => {
    const cases: [string[], string][] = [
      [['missing.mjs'], `Module not found: ${join(fixtures, 'missing.mjs')}`],
      [
        ['factory.ts'],
        'factory.ts has no "default" export (exports: createApp, failing, leaky, notAnApp). Choose one with --export.',
      ],
      [
        ['factory.ts', '--export', 'notAnApp'],
        'The "notAnApp" export of factory.ts is not a Dotpress app: export the result of createApp(), or a function returning it.',
      ],
    ]

    for (const [args, message] of cases) {
      expect(await run(args)).toEqual({
        code: 1,
        stdout: '',
        stderr: `dotpress-openapi: ${message}\n`,
      })
    }
  })

  it('explains how to load TypeScript modules when the import fails', async () => {
    const { code, stderr } = await run(['broken.ts'])

    expect(code).toBe(1)
    expect(stderr).toContain(`Cannot load ${join(fixtures, 'broken.ts')}: `)
    expect(stderr).toContain(
      'TypeScript modules require Node.js 22.18 or later'
    )
  })

  it('reports unexpected errors with their stack', async () => {
    const { code, stderr } = await run(['factory.ts', '--export', 'failing'])

    expect(code).toBe(1)
    expect(stderr).toMatch(
      /^dotpress-openapi: Error: Database unavailable\n {4}at /
    )
  })

  const bin = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

  // The CI builds the packages before testing them.
  it.skipIf(!existsSync(bin))(
    'runs as a Node.js binary, with TypeScript modules',
    async () => {
      const source = await readFile(bin, 'utf8')
      expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true)

      const { stdout } = await promisify(execFile)(
        process.execPath,
        [bin, 'factory.ts', '--export', 'createApp'],
        { cwd: fixtures }
      )

      expect(JSON.parse(stdout).info).toEqual({
        title: 'fixture-api',
        version: '3.2.1',
      })
    }
  )

  it.skipIf(!existsSync(bin))(
    'exits even when the app leaves handles open',
    async () => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [bin, 'factory.ts', '--export', 'leaky'],
        { cwd: fixtures, timeout: 10_000 }
      )

      expect(JSON.parse(stdout)).toHaveProperty('paths')
    }
  )
})
