// Build the Meowdown fork (~/repos/meowdown, or the first argument), pack
// @meowdown/core and @meowdown/react into vendor/meowdown/ named with the fork
// commit, and repoint the pnpm-workspace.yaml overrides; then `pnpm install`.
// `pnpm pack` rewrites `workspace:*` deps to versions, so the rest stay on npm.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const PACKAGES = ['markdown', 'core', 'react']

const here = import.meta.dirname
const repoRoot = join(here, '..', '..', '..')
const vendorDir = join(repoRoot, 'vendor', 'meowdown')
const workspaceFile = join(repoRoot, 'pnpm-workspace.yaml')
const snapshot = process.argv.includes('--snapshot')
const forkDir = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) ??
    join(homedir(), 'repos', 'meowdown'),
)

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim()
}

if (!snapshot && run('git', ['status', '--porcelain'], forkDir) !== '') {
  throw new Error(`vendor-meowdown: commit the changes in ${forkDir} first`)
}
const sourceCommit = run('git', ['rev-parse', 'HEAD'], forkDir)
const sourceHash = createHash('sha256')
for (const file of run(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  forkDir,
)
  .split('\0')
  .filter(Boolean)
  .sort()) {
  sourceHash
    .update(file)
    .update('\0')
    .update(readFileSync(join(forkDir, file)))
    .update('\0')
}
const snapshotHash = sourceHash.digest('hex')
const commit = sourceCommit.slice(0, 12) + (snapshot ? `-local-${snapshotHash.slice(0, 12)}` : '')

console.log(`vendor-meowdown: building ${forkDir} at ${commit}`)
if (!snapshot) run('pnpm', ['install', '--frozen-lockfile'], forkDir)
run(
  'pnpm',
  ['--config.verify-deps-before-run=false', '--filter', '@meowdown/react...', 'run', 'build'],
  forkDir,
)

mkdirSync(vendorDir, { recursive: true })

let workspace = readFileSync(workspaceFile, 'utf8')
const missing = []
const provenance = []
for (const name of PACKAGES) {
  const packageDir = join(forkDir, 'packages', name)
  const { version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  run('pnpm', ['pack', '--pack-destination', vendorDir], packageDir)
  const tarball = `meowdown-${name}-${version}-${commit}.tgz`
  renameSync(join(vendorDir, `meowdown-${name}-${version}.tgz`), join(vendorDir, tarball))
  const sha256 = createHash('sha256')
    .update(readFileSync(join(vendorDir, tarball)))
    .digest('hex')
  provenance.push(`| ${tarball} | \`${sha256}\` |`)

  const entry = new RegExp(String.raw`('@meowdown/${name}': )file:vendor/meowdown/\S+`)
  const spec = `file:vendor/meowdown/${tarball}`
  if (entry.test(workspace)) {
    workspace = workspace.replace(entry, `$1${spec}`)
  } else {
    missing.push(`  '@meowdown/${name}': ${spec}`)
  }
  console.log(`vendor-meowdown: wrote vendor/meowdown/${tarball}`)
}
if (missing.length > 0)
  workspace = workspace.replace(/^overrides:\s*$/m, `overrides:\n${missing.join('\n')}`)
writeFileSync(workspaceFile, workspace)
writeFileSync(
  join(vendorDir, 'README.md'),
  `# Vendored Meowdown packages\n\n${snapshot ? 'Local review snapshot, with uncommitted changes on top of' : 'Built from'} Meowdown fork commit \`${sourceCommit}\`. Source file SHA-256: \`${snapshotHash}\`. The lockfile pins each archive's integrity.\n\n| Package | SHA-256 |\n| --- | --- |\n${provenance.join('\n')}\n\nTo refresh, run \`node apps/desktop/scripts/vendor-meowdown.mjs /path/to/meowdown${snapshot ? ' --snapshot' : ''}\`, then \`pnpm install\`. Snapshot mode records local source content without creating a commit.\n`,
)

console.log('vendor-meowdown: now run `pnpm install`')
