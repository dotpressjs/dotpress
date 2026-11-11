// Checks the examples (examples/*), run after `pnpm install`:
// - a private package named `@dotpress-examples/<directory>`, with a README,
//   and `typecheck` and `test` scripts (run by `pnpm typecheck` and
//   `pnpm test`);
// - each `@dotpress/*` dependency declares the current version of the
//   package (`^2.0.0-alpha.1`, kept up to date by `changeset version`), not
//   `workspace:`, so that a copy of the example installs as is;
// - each one is linked to the package of the workspace (linkWorkspacePackages):
//   otherwise pnpm installs the published version, and the example no longer
//   tests the sources.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

const packages = new Map()
for (const dir of readdirSync(join(root, 'packages'))) {
  const file = join(root, 'packages', dir, 'package.json')
  if (!existsSync(file)) continue
  const { name, version } = readJson(file)
  packages.set(name, { dir: join(root, 'packages', dir), version })
}

let failed = false
let count = 0
for (const dir of readdirSync(join(root, 'examples')).sort()) {
  const exampleDir = join(root, 'examples', dir)
  const file = join(exampleDir, 'package.json')
  if (!existsSync(file)) continue
  count++

  const pkg = readJson(file)
  const errors = []
  if (pkg.name !== `@dotpress-examples/${dir}`) {
    errors.push(`name is "${pkg.name}", expected "@dotpress-examples/${dir}".`)
  }
  if (pkg.private !== true) errors.push('must be private.')
  if (!existsSync(join(exampleDir, 'README.md'))) {
    errors.push('README.md is missing.')
  }
  for (const script of ['typecheck', 'test']) {
    if (!pkg.scripts?.[script]) errors.push(`"${script}" script is missing.`)
  }

  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies }
  for (const [name, range] of Object.entries(dependencies)) {
    if (!name.startsWith('@dotpress/')) continue
    const local = packages.get(name)
    if (!local) {
      errors.push(`${name} is not a package of the workspace.`)
      continue
    }
    if (range !== `^${local.version}`) {
      errors.push(`${name} is "${range}", expected "^${local.version}".`)
    }
    const installed = join(exampleDir, 'node_modules', name)
    if (!existsSync(installed)) {
      errors.push(`${name} is not installed (run pnpm install).`)
    } else if (realpathSync(installed) !== realpathSync(local.dir)) {
      errors.push(
        `${name} is not linked to the workspace (installed from the registry?).`
      )
    }
  }

  if (errors.length > 0) {
    failed = true
    console.error(`✗ ${pkg.name ?? dir}`)
    for (const error of errors) console.error(`  - ${error}`)
  } else {
    console.log(`✓ ${pkg.name}`)
  }
}

if (count === 0) {
  console.error('No example found.')
  failed = true
}
if (failed) process.exitCode = 1
