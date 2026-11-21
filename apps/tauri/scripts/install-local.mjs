// Build the local flavor (`pnpm tauri:build:local`) and install it as
// /Applications/Reflect.app: quit the running copy, swap the new bundle in, and
// relaunch it. Settings, recent graphs, and downloaded models live outside the
// bundle, so they carry over. Run through `pnpm tauri:install:local`.
//
// macOS grants the microphone and other permissions to an app's designated
// requirement. An ad-hoc signature's requirement is its cdhash, new with every
// build, so each install would ask again. When the login keychain holds a
// code-signing identity named "Reflect Local Signing" (self-signed is fine),
// the build signs with it instead: the requirement then names the identifier
// and certificate, and permissions carry over from build to build.

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
const SIGNING_IDENTITY = 'Reflect Local Signing'

function hasSigningIdentity() {
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  })
  return identities.includes(`"${SIGNING_IDENTITY}"`)
}

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

const signed = hasSigningIdentity()
if (!signed) {
  console.log(`install-local: no "${SIGNING_IDENTITY}" identity, so this build signs ad-hoc`)
}
execFileSync('pnpm', ['tauri:build:local'], {
  cwd: join(import.meta.dirname, '..'),
  stdio: 'inherit',
  env: signed ? { ...process.env, APPLE_SIGNING_IDENTITY: SIGNING_IDENTITY } : process.env,
})

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
