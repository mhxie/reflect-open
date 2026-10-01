// Install the local flavor (`pnpm tauri:build:local`) as /Applications/Reflect.app:
// quit the running copy, swap the new bundle in, and relaunch it. Settings,
// recent graphs, and downloaded models live outside the bundle, so they carry
// over. Run through `pnpm tauri:install:local`, which builds first.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const IDENTIFIER = 'app.reflect.desktop.local'
const INSTALLED = '/Applications/Reflect.app'
const STAGED = `${INSTALLED}.installing`
const BUILT = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'target',
  'release',
  'bundle',
  'macos',
  'Reflect.app',
)
const QUIT_TIMEOUT_MS = 15_000

function bundleIdentifier(app) {
  return execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleIdentifier', join(app, 'Contents', 'Info.plist')],
    { encoding: 'utf8' },
  ).trim()
}

function isRunning() {
  return spawnSync('pgrep', ['-f', `${INSTALLED}/Contents/MacOS/`]).status === 0
}

if (!existsSync(BUILT) || bundleIdentifier(BUILT) !== IDENTIFIER) {
  throw new Error(`install-local: no local-flavor build at ${BUILT}`)
}
// Never replace an official build or another app that happens to share the name.
if (existsSync(INSTALLED) && bundleIdentifier(INSTALLED) !== IDENTIFIER) {
  throw new Error(`install-local: ${INSTALLED} is not the local flavor; move it aside first`)
}

rmSync(STAGED, { recursive: true, force: true })
execFileSync('ditto', [BUILT, STAGED])

// Ask, never kill: a forced exit could drop an unsaved edit.
spawnSync('osascript', [
  '-e',
  `if application id "${IDENTIFIER}" is running then tell application id "${IDENTIFIER}" to quit`,
])
const deadline = Date.now() + QUIT_TIMEOUT_MS
while (isRunning()) {
  if (Date.now() > deadline) {
    rmSync(STAGED, { recursive: true, force: true })
    throw new Error('install-local: Reflect is still running; quit it and run this again')
  }
  spawnSync('sleep', ['0.5'])
}

rmSync(INSTALLED, { recursive: true, force: true })
renameSync(STAGED, INSTALLED)
execFileSync('open', [INSTALLED])
console.log(`install-local: installed and relaunched ${INSTALLED}`)
