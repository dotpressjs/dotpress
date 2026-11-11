// Sets the npm dist-tags of the versions just published (Release workflow,
// after `changeset publish`), whatever tag changesets chose:
//
// - prerelease mode (.changeset/pre.json), package without stable version:
//   `latest` is the new version, and no prerelease tag remains;
// - prerelease mode, package with a stable version: `latest` is kept, and
//   the tag of the mode (`alpha`, `beta`, `rc`) is the new version;
// - stable release: `latest` is the new version, and the prerelease tags of
//   older versions are removed.
//
// npm authenticates with trusted publishing in CI (npm 11.21 or later, with
// "Allow npm dist-tag" on the trusted publisher), or with the npmrc of the
// environment (release dry run). DRY_RUN=1 only prints the changes.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const dryRun = Boolean(process.env.DRY_RUN)

const npm = (args) =>
  execFileSync('npm', args, { cwd: root, encoding: 'utf8' }).trim()

/** [major, minor, patch] of a version, and whether it is a prerelease. */
const parse = (version) => {
  const [core, pre] = version.split('+')[0].split(/-(.*)/s)
  return { core: core.split('.').map(Number), prerelease: pre !== undefined }
}
const compareCore = (a, b) =>
  a.core.reduce((result, part, index) => result || part - b.core[index], 0)

const pre = existsSync(join(root, '.changeset/pre.json'))
  ? JSON.parse(readFileSync(join(root, '.changeset/pre.json'), 'utf8'))
  : undefined
const preTag = pre?.mode === 'pre' ? pre.tag : undefined

let failed = false
for (const dir of readdirSync(join(root, 'packages')).sort()) {
  const file = join(root, 'packages', dir, 'package.json')
  if (!existsSync(file)) continue
  const {
    name,
    version,
    private: isPrivate,
  } = JSON.parse(readFileSync(file, 'utf8'))
  if (isPrivate) continue

  const info = JSON.parse(
    npm(['view', name, 'versions', 'dist-tags', '--json'])
  )
  const versions = [].concat(info.versions ?? [])
  const tags = info['dist-tags'] ?? {}
  if (!versions.includes(version)) {
    console.log(`${name}@${version}: not published, skipped`)
    continue
  }
  const hasStable = versions.some((value) => !parse(value).prerelease)

  const add = {}
  const remove = []
  if (preTag && !hasStable) {
    add.latest = version
    for (const [tag, value] of Object.entries(tags)) {
      if (tag !== 'latest' && parse(value).prerelease) remove.push(tag)
    }
  } else if (preTag) {
    add[preTag] = version
  } else {
    add.latest = version
    for (const [tag, value] of Object.entries(tags)) {
      const tagged = parse(value)
      if (
        tag !== 'latest' &&
        tagged.prerelease &&
        compareCore(tagged, parse(version)) <= 0
      ) {
        remove.push(tag)
      }
    }
  }

  const changes = [
    ...Object.entries(add)
      .filter(([tag, value]) => tags[tag] !== value)
      .map(([tag, value]) => ['add', `${name}@${value}`, tag]),
    ...remove.map((tag) => ['rm', name, tag]),
  ]
  if (changes.length === 0) {
    console.log(`${name}@${version}: ${JSON.stringify(tags)}`)
    continue
  }
  for (const change of changes) {
    console.log(`${name}@${version}: npm dist-tag ${change.join(' ')}`)
    if (dryRun) continue
    try {
      npm(['dist-tag', ...change])
    } catch (error) {
      // After a stable release, an old prerelease tag left behind is only
      // cosmetic: a package without "Allow npm dist-tag" keeps it.
      const cosmetic = !preTag && change[0] === 'rm'
      if (!cosmetic) failed = true
      console.error(
        `  ${cosmetic ? 'warning' : 'failed'}: ${error.stderr || error.message}`
      )
    }
  }
}

if (failed) process.exitCode = 1
