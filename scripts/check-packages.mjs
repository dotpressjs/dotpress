// Checks the manifests of the published packages, then lints what npm would
// publish with publint (exports, files, bins) and Are the Types Wrong?
// (resolution of the types, ESM only). Run after `pnpm build`.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { publint } from 'publint'
import { formatMessage } from 'publint/utils'

const REPOSITORY = 'https://github.com/dotpressjs/dotpress'
const EXPECTED = {
  author: 'Renaud Guyon',
  license: 'MIT',
  homepage: 'https://dotpress.dev',
  bugs: { url: `${REPOSITORY}/issues` },
  type: 'module',
  files: ['dist'],
  engines: { node: '>=22.12' },
}

const root = new URL('../', import.meta.url)
const license = readFileSync(new URL('LICENSE', root), 'utf8')
const attw = new URL('node_modules/.bin/attw', root).pathname
let failed = false

for (const dir of readdirSync(new URL('packages/', root)).sort()) {
  const pkgDir = new URL(`packages/${dir}/`, root)
  if (!existsSync(new URL('package.json', pkgDir))) continue
  const pkg = JSON.parse(readFileSync(new URL('package.json', pkgDir), 'utf8'))
  const errors = []
  const expect = (field, actual, expected) => {
    if (!isDeepStrictEqual(actual, expected)) {
      errors.push(
        `${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}.`
      )
    }
  }

  expect('name', pkg.name, `@dotpress/${dir}`)
  expect('private', pkg.private, undefined)
  for (const [field, value] of Object.entries(EXPECTED)) {
    expect(field, pkg[field], value)
  }
  // The URL npm checks against the repository of the provenance.
  expect('repository', pkg.repository, {
    type: 'git',
    url: `git+${REPOSITORY}.git`,
    directory: `packages/${dir}`,
  })
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (name.startsWith('@dotpress/')) {
        expect(`${field}["${name}"]`, range, 'workspace:^')
      }
    }
  }
  if (!existsSync(new URL('README.md', pkgDir))) {
    errors.push('README.md is missing.')
  }
  if (!existsSync(new URL('LICENSE', pkgDir))) {
    errors.push('LICENSE is missing.')
  } else if (readFileSync(new URL('LICENSE', pkgDir), 'utf8') !== license) {
    errors.push('LICENSE differs from the LICENSE of the repository.')
  }

  // publint packs the package with npm: the files as published.
  const { messages, pkg: packed } = await publint({
    pkgDir: pkgDir.pathname,
    level: 'suggestion',
    pack: 'npm',
  })
  for (const message of messages) {
    errors.push(`publint: ${formatMessage(message, packed, { color: false })}`)
  }

  // ESM only: resolution from CommonJS (`node10`, `node16-cjs`) is ignored.
  const types = spawnSync(
    attw,
    ['--pack', '.', '--profile', 'esm-only', '--format', 'ascii'],
    { cwd: pkgDir, encoding: 'utf8' }
  )
  if (types.status !== 0) {
    errors.push(
      `Are the Types Wrong? failed:\n${types.stdout}${types.stderr ?? ''}${types.error ?? ''}`
    )
  }

  if (errors.length > 0) {
    failed = true
    console.error(`✗ ${pkg.name ?? dir}`)
    for (const error of errors) console.error(`  - ${error}`)
  } else {
    console.log(`✓ ${pkg.name}`)
  }
}

if (failed) process.exitCode = 1
