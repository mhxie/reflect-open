// Vendor the Meowdown fork (Plan 25): build the fork checkout
// (~/repos/meowdown, or the path given as the first argument), pack
// @meowdown/core and @meowdown/react, and write the tarballs to
// vendor/meowdown/ named with the fork commit. The `overrides` in
// pnpm-workspace.yaml point at those files and are rewritten to the new names.
//
// Rerun after changing the fork, then `pnpm install` and commit the tarballs.
// `pnpm pack` applies each package's `publishConfig` (exports → dist/) and
// rewrites `workspace:*` dependencies to concrete versions, so
// @meowdown/markdown and @meowdown/embed keep resolving from npm.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const PACKAGES = ['core', 'react']

const here = import.meta.dirname
const repoRoot = join(here, '..', '..', '..')
const vendorDir = join(repoRoot, 'vendor', 'meowdown')
const workspaceFile = join(repoRoot, 'pnpm-workspace.yaml')
const forkDir = resolve(process.argv[2] ?? join(homedir(), 'repos', 'meowdown'))

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim()
}

// A tarball must name a commit that exists, so the fork has to be clean.
if (run('git', ['status', '--porcelain'], forkDir) !== '') {
  throw new Error(`vendor-meowdown: commit the changes in ${forkDir} first`)
}
const commit = run('git', ['rev-parse', '--short=12', 'HEAD'], forkDir)

console.log(`vendor-meowdown: building ${forkDir} at ${commit}`)
run('pnpm', ['install', '--frozen-lockfile'], forkDir)
run('pnpm', ['--filter', '@meowdown/react...', 'run', 'build'], forkDir)

rmSync(vendorDir, { recursive: true, force: true })
mkdirSync(vendorDir, { recursive: true })

let workspace = readFileSync(workspaceFile, 'utf8')
const missing = []
for (const name of PACKAGES) {
  const packageDir = join(forkDir, 'packages', name)
  const { version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  run('pnpm', ['pack', '--pack-destination', vendorDir], packageDir)
  const tarball = `meowdown-${name}-${version}-${commit}.tgz`
  renameSync(join(vendorDir, `meowdown-${name}-${version}.tgz`), join(vendorDir, tarball))

  const entry = new RegExp(String.raw`('@meowdown/${name}': )file:vendor/meowdown/\S+`)
  const spec = `file:vendor/meowdown/${tarball}`
  if (entry.test(workspace)) {
    workspace = workspace.replace(entry, `$1${spec}`)
  } else {
    missing.push(`  '@meowdown/${name}': ${spec}`)
  }
  console.log(`vendor-meowdown: wrote vendor/meowdown/${tarball}`)
}
writeFileSync(workspaceFile, workspace)

if (missing.length > 0) {
  console.log(
    `vendor-meowdown: add to the overrides in pnpm-workspace.yaml:\n${missing.join('\n')}`,
  )
}
console.log('vendor-meowdown: now run `pnpm install` and commit vendor/meowdown/')
