#!/usr/bin/env node
'use strict'

/**
 * Installer for dsh-plugin-permission-guard.
 *
 * WHY THIS EXISTS INSTEAD OF `dsh plugin add`
 *
 * The harness has a supported plugin-install path: `dsh plugin --profile <name> add <pkg>`, which
 * forwards to pnpm in the profile directory and then reconciles `dsh.profile.bundles`. It refuses
 * to touch the profile this package is most often wanted in:
 *
 *     function rejectElectronProfile(program, profile) {
 *       if (profile.toLowerCase() === "desktop")
 *         program.error('error: profile "desktop" is managed exclusively by the Electron application');
 *     }
 *
 * The Desktop profile is an ordinary profile on disk — package.json, pnpm-lock.yaml,
 * pnpm-workspace.yaml and node_modules are all present — so the OPERATIONS are available even
 * though the CLI front door is closed. This script performs the same two operations directly.
 *
 * WHAT IT DOES, AND WHY EACH STEP IS NECESSARY
 *
 *   1. Locate the profile directory.
 *   2. Snapshot package.json + pnpm-lock.yaml (see ROLLBACK below).
 *   3. `pnpm add <this package>@<exact version>` in that directory. pnpm writes node_modules and
 *      updates `dependencies` itself.
 *   4. Verify the INSTALLED manifest declares `dsh.bundle.patch`.
 *      This step is not optional: the harness joins a dependency to the layer stack ONLY when
 *      `dsh.bundle.patch` is present, and a package without it is skipped with a warning that is
 *      easy to miss. Without this check the install could report success while the plugin never
 *      loads — the "silent success" failure mode this package's own README warns about.
 *   5. Add the package name to `dsh.profile.bundles`.
 *   6. Tell the user to restart, because the composition is evaluated only at startup.
 *
 * ROLLBACK
 *
 * Step 3 rewrites files a profile needs in order to BOOT, and step 5 rewrites the bundle list
 * that decides which rows exist. A half-applied install does not degrade the app — it can stop
 * it from starting. Every write after the snapshot is therefore guarded: any failure restores the
 * snapshots before exiting non-zero.
 *
 * Usage:
 *   npx dsh-plugin-permission-guard install [--profile <name>] [--dry-run]
 *   npx dsh-plugin-permission-guard uninstall
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SELF = require('../package.json')
const PACKAGE_NAME = SELF.name
const DESKTOP_PROFILE = 'desktop'

/**
 * The argument to hand pnpm.
 *
 * From a published install it must carry the EXACT version: `npx` runs the package from npm, and
 * pinning the version makes the recorded dependency match the code that actually ran. A bare
 * `pnpm add <name>` would instead resolve `latest` at install time, which can differ from the
 * version that just executed.
 *
 * When the package is NOT inside a `node_modules` tree, it is being run from an extracted tarball
 * or a source checkout, and appending `@<version>` to that spec is invalid. In that mode the
 * directory itself is installed, which is also what makes local end-to-end testing possible
 * without publishing first.
 */
function installSpec() {
  const inNodeModules = __dirname.split(path.sep).indexOf('node_modules') !== -1
  if (inNodeModules) return PACKAGE_NAME + '@' + SELF.version
  return path.resolve(__dirname, '..')
}

function fail(message, code) {
  process.stderr.write('\n' + PACKAGE_NAME + ': ' + message + '\n')
  process.exit(code === undefined ? 1 : code)
}

/**
 * An expected, already-explained failure.
 *
 * Thrown rather than passed to `fail()` for anything that happens AFTER the snapshot, because
 * `fail()` exits immediately and would skip ROLLBACK. Reported by the caller instead.
 */
class CliError extends Error {}

function info(message) {
  process.stdout.write(message + '\n')
}

// ------------------------------------------------------------------ argument parsing

function parseArgs(argv) {
  const options = { command: 'install', profile: DESKTOP_PROFILE, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === 'install' || arg === 'uninstall') { options.command = arg; continue }
    if (arg === '--dry-run') { options.dryRun = true; continue }
    if (arg === '--profile') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) fail('--profile needs a profile name')
      options.profile = value
      i++
      continue
    }
    if (arg === '--help' || arg === '-h') { options.command = 'help'; continue }
    fail('unknown argument: ' + arg + ' (try --help)')
  }
  return options
}

function help() {
  info([
    'dsh-plugin-permission-guard',
    '',
    'Usage:',
    '  npx ' + PACKAGE_NAME + ' install   [--profile <name>] [--dry-run]',
    '  npx ' + PACKAGE_NAME + ' uninstall [--profile <name>]',
    '',
    'Options:',
    '  --profile <name>   profile to install into (default: ' + DESKTOP_PROFILE + ')',
    '  --dry-run          print what would happen, change nothing',
    '',
    'The install writes to the profile and then requires a DSH restart, because the',
    'composition is evaluated only at startup.',
  ].join('\n'))
}

// ------------------------------------------------------------------ profile location

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

function profileDir(profile) {
  return path.join(dshHome(), 'profiles', profile)
}

function readManifest(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// ------------------------------------------------------------------ atomic write + rollback

/**
 * Snapshot, then restore on failure.
 *
 * Deliberately whole-file: these files are small, and a partial write to either one is worse than
 * no write. `restore()` is idempotent and is safe to call when nothing was written yet.
 */
function makeRollback() {
  const snapshots = []
  return {
    capture(file) {
      if (!fs.existsSync(file)) { snapshots.push({ file: file, existed: false, bytes: null }); return }
      snapshots.push({ file: file, existed: true, bytes: fs.readFileSync(file) })
    },
    restore() {
      for (const snap of snapshots) {
        try {
          if (snap.existed) fs.writeFileSync(snap.file, snap.bytes)
          else if (fs.existsSync(snap.file)) fs.unlinkSync(snap.file)
        } catch (error) {
          process.stderr.write(PACKAGE_NAME + ': could not restore ' + snap.file + ': ' + String(error) + '\n')
        }
      }
    },
  }
}

function writeAtomic(file, text) {
  const temporary = file + '.dsh-permission-guard.tmp'
  fs.writeFileSync(temporary, text)
  fs.renameSync(temporary, file)
}

// ------------------------------------------------------------------ pnpm

/**
 * Run pnpm with the most plain form available, and let the SPACE GUARD do the protecting.
 *
 * Three forms were tried and measured, and the notes matter because the wrong one fails in a way
 * that looks like success:
 *
 *   1. `spawnSync('pnpm', argv, { shell: false })` — EINVAL on Windows. Node 20.12+ refuses to
 *      execute a `.cmd`/`.bat` without a shell (the CVE-2024-27980 mitigation), and pnpm on
 *      Windows is `pnpm.cmd`.
 *   2. `spawnSync(cmd.exe, ['/d','/s','/c', selfQuotedLine])` — cmd re-quotes already-quoted
 *      arguments, so the subcommand arrives as `"add"` and pnpm reports
 *      `Command ""add"" not found`.
 *   3. `spawnSync('pnpm', argv, { shell: true })` — works, and is what this uses.
 *
 * Form 3 is chosen precisely because its ONE failure mode is narrow and detectable: Node does not
 * escape arguments on Windows, it only concatenates them, so an argument containing a space is
 * re-split by the shell. For a spec of `<name>@<version>` that can never happen; for a local
 * directory path it can, and `install()` refuses such a path BEFORE reaching here. Detecting and
 * reporting that is more reliable than getting cmd.exe quoting right a fourth time.
 */
function runPnpm(profilePath, args) {
  const result = spawnSync('pnpm', args, {
    cwd: profilePath,
    stdio: 'inherit',
    shell: true,
    windowsHide: true,
  })
  if (result.error !== undefined) {
    if (result.error.code === 'ENOENT') {
      fail('pnpm not found on PATH. Install pnpm (or run this from the DSH Desktop terminal, which'
        + ' puts the bundled pnpm on PATH) and try again.')
    }
    fail('could not run pnpm: ' + String(result.error))
  }
  return result.status === null ? 1 : result.status
}

// ------------------------------------------------------------------ operations

function installedManifestPath(profilePath, packageName) {
  return path.join(profilePath, 'node_modules', ...packageName.split('/'), 'package.json')
}

function assertBundleDeclaration(profilePath) {
  const manifestPath = installedManifestPath(profilePath, PACKAGE_NAME)
  if (!fs.existsSync(manifestPath)) {
    throw new CliError('pnpm reported success but ' + manifestPath + ' does not exist. The install'
      + ' did not actually place the package.')
  }
  let manifest
  try {
    manifest = readManifest(manifestPath)
  } catch (error) {
    throw new CliError('the installed package.json is unreadable: ' + String(error))
  }
  const patch = manifest.dsh && manifest.dsh.bundle ? manifest.dsh.bundle.patch : undefined
  if (patch === undefined) {
    throw new CliError('the installed package does NOT declare `dsh.bundle.patch`, so the harness'
      + ' would treat it as a plain library and never load it. This should be impossible for a'
      + ' released version of ' + PACKAGE_NAME + '; the installed copy may be stale or corrupted.')
  }
  return patch
}

function addToBundles(profilePath, rollback) {
  const manifestPath = path.join(profilePath, 'package.json')
  const manifest = readManifest(manifestPath)
  const dsh = manifest.dsh === undefined ? {} : manifest.dsh
  const profileSection = dsh.profile === undefined ? {} : dsh.profile
  const bundles = Array.isArray(profileSection.bundles) ? profileSection.bundles.slice() : []

  if (bundles.indexOf(PACKAGE_NAME) !== -1) {
    info('  already listed in dsh.profile.bundles')
    return false
  }

  bundles.push(PACKAGE_NAME)
  manifest.dsh = Object.assign({}, dsh, {
    profile: Object.assign({}, profileSection, { bundles: bundles }),
  })

  // Captured IMMEDIATELY before the write, not at the start of the command. The snapshot must be
  // of the file's state at the moment of the write: capturing earlier would restore a version
  // that predates any other change made in between.
  rollback.capture(manifestPath)
  writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  info('  added ' + PACKAGE_NAME + ' to dsh.profile.bundles')
  return true
}

function removeFromBundles(profilePath, rollback) {
  const manifestPath = path.join(profilePath, 'package.json')
  const manifest = readManifest(manifestPath)
  const bundles = manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)
    ? manifest.dsh.profile.bundles
    : []
  const at = bundles.indexOf(PACKAGE_NAME)
  if (at === -1) {
    info('  not listed in dsh.profile.bundles')
    return false
  }
  bundles.splice(at, 1)
  // Captured immediately before the write: see the note in `install()`. Capturing earlier would
  // restore a snapshot that a concurrent edit had already superseded.
  rollback.capture(manifestPath)
  writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  info('  removed ' + PACKAGE_NAME + ' from dsh.profile.bundles')
  return true
}

function preflight(profilePath) {
  if (!fs.existsSync(profilePath)) {
    fail('profile directory not found: ' + profilePath
      + '\n  Start DSH once with that profile, or pass --profile <name>.')
  }
  const manifestPath = path.join(profilePath, 'package.json')
  if (!fs.existsSync(manifestPath)) {
    fail('no package.json in ' + profilePath
      + '\n  This does not look like an initialised DSH profile. Start DSH once with that profile first.')
  }
}

function install(options) {
  const profilePath = profileDir(options.profile)
  info(PACKAGE_NAME + ' -> profile "' + options.profile + '"')
  // Bracketed: the path usually contains spaces, and an unquoted display of it reads as though
  // part of it were dropped. (That hazard is real — the same one broke the pnpm invocation; see
  // `runPnpm`.)
  info('  profile directory: [' + profilePath + ']')
  preflight(profilePath)

  const manifestPath = path.join(profilePath, 'package.json')
  const lockPath = path.join(profilePath, 'pnpm-lock.yaml')
  const alreadyInstalled = fs.existsSync(installedManifestPath(profilePath, PACKAGE_NAME))

  if (options.dryRun) {
    info('  --dry-run: would run `pnpm add ' + installSpec() + '` here')
    info('  --dry-run: would then ensure ' + PACKAGE_NAME + ' is listed in dsh.profile.bundles')
    return
  }

  // GUARD, verified by experiment. With `shell: true` (required, because pnpm is a .cmd shim that
  // Node refuses to exec directly), Node does NOT quote arguments on Windows — it only
  // concatenates them. A spec containing a space is therefore re-split by the shell, and pnpm
  // silently installs the FRAGMENTS as separate dependencies while exiting 0. That was observed:
  // installing from `D:\DeepSeek Harness\...` added a bogus `DeepSeek@0.0.0` dependency.
  //
  // This affects the LOCAL-DIRECTORY path only. The published path uses `<name>@<version>`, which
  // contains no space. Failing loudly here is deliberate: silent success that installs the wrong
  // thing is the exact failure mode this package's README warns about, and there is no way to
  // report it after the fact.
  const spec = installSpec()
  if (spec.indexOf(' ') !== -1) {
    fail('refusing to install from a path containing a space:\n  ' + spec
      + '\n  pnpm is invoked through a shell here, and a spacey path would be split into separate'
      + ' dependencies (silently, with exit code 0).\n  Copy this package to a space-free directory'
      + ' (for example C:\\tmp\\pg) and run the installer from there, or install it from npm so the'
      + ' spec is a bare package name.')
  }

  const rollback = makeRollback()
  // Capture BOTH profile files up front. pnpm itself rewrites them, and if pnpm fails partway the
  // package manager may already have touched the lockfile; those are the two files whose damage
  // can prevent a later boot. The bundle-list write captures its own snapshot at write time.
  rollback.capture(manifestPath)
  rollback.capture(lockPath)

  // 1. Let pnpm place the package and record the dependency.
  info(alreadyInstalled
    ? '  package already present; refreshing to ' + SELF.version
    : '  installing with pnpm...')
  const status = runPnpm(profilePath, [
    'add',
    installSpec(),
    '--config.minimumReleaseAge=0',
  ])
  if (status !== 0) {
    rollback.restore()
    fail('pnpm exited with code ' + status + '. Profile files were restored; nothing changed.')
  }

  try {
    // 2. Refuse to continue if the installed package cannot actually load.
    const patch = assertBundleDeclaration(profilePath)
    info('  installed manifest declares dsh.bundle.patch -> ' + patch)

    // 3. Join the layer stack.
    addToBundles(profilePath, rollback)
  } catch (error) {
    // Roll back BEFORE reporting: a half-applied install can stop the profile from booting, so
    // restoring is more urgent than the message. `CliError` carries a message already written for
    // a human; anything else is unexpected and gets its raw text.
    rollback.restore()
    const message = error instanceof CliError ? error.message : String(error && error.message ? error.message : error)
    fail(message + '\n\nProfile files were restored (`package.json` and `pnpm-lock.yaml`); the'
      + ' profile is in the state it had before this command ran.')
  }

  info('')
  info('Installed. RESTART DSH for it to take effect — the composition is evaluated only at')
  info('startup, so the plugin will not appear until then.')
  info('')
  info('After restarting you should see a permission indicator in the composer, and the')
  info('permission_mode tool becomes available. The initial mode is 2 (workspace write),')
  info('matching the harness default. Change it with the indicator or by editing')
  info('permissions.json next to the installed plugin.')
}

function uninstall(options) {
  const profilePath = profileDir(options.profile)
  info(PACKAGE_NAME + ' <- profile "' + options.profile + '"')
  info('  profile directory: ' + profilePath)
  preflight(profilePath)

  if (options.dryRun) {
    info('  --dry-run: would remove it from dsh.profile.bundles and run `pnpm remove`')
    return
  }

  const rollback = makeRollback()
  try {
    // Remove from the layer list FIRST: leaving the row while the package is gone would make the
    // next boot fail to resolve the row.
    removeFromBundles(profilePath)
  } catch (error) {
    rollback.restore()
    fail('could not update dsh.profile.bundles: ' + String(error))
  }

  const status = runPnpm(profilePath, ['remove', PACKAGE_NAME])
  if (status !== 0) {
    info('  note: pnpm remove exited with code ' + status + '; the package may still be present,')
    info('  but it is no longer in dsh.profile.bundles, so it will not load.')
  }

  info('')
  info('Removed. RESTART DSH to apply.')
  info('')
  // Documented because it silently changes the starting mode of a future install.
  info('Note: the mode state file is left in place. It lives beside the installed plugin and')
  info('holds your chosen mode; a future reinstall will reuse it. Delete permissions.json')
  info('inside the removed package directory if you want a fresh install to start at mode 2.')
}

// ------------------------------------------------------------------ entry

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'help') { help(); return }
  if (options.command === 'install') { install(options); return }
  uninstall(options)
}

main()
