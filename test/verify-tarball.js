'use strict'

/**
 * Verify a packed tarball end to end, WITHOUT publishing and WITHOUT touching a real profile.
 *
 * Installs the tarball into a scratch npm project, then inspects the INSTALLED copy — the bytes a
 * user would actually get, not the working tree. That distinction matters here: the package's whole
 * value is behavioural (does it refuse, does it leak a path), and "it works in the repo" has already
 * been wrong once in this project's history.
 *
 * Usage: node test/verify-tarball.js <path-to-tgz>
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const tgz = process.argv[2]
if (tgz === undefined) {
  console.error('usage: node test/verify-tarball.js <path-to-tgz>')
  process.exit(2)
}

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + (detail ? ' | ' + detail : ''))
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-verify-'))
try {
  fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ name: 'scratch', version: '1.0.0', private: true }, null, 2))
  console.log('scratch project: ' + scratch)

  // Copy the tarball into the scratch directory first, then install by BARE FILENAME.
  //
  // Not cosmetic: the source path routinely contains a space (`D:\DeepSeek Harness\...`), and npm on
  // Windows is invoked through a shell here, which re-splits an unquoted path into separate
  // arguments. Installing by relative name sidesteps the whole class of problem — the same one that
  // made the package's own installer refuse spacey paths rather than guess.
  const localTgz = path.join(scratch, 'package-under-test.tgz')
  fs.copyFileSync(path.resolve(tgz), localTgz)

  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund', path.basename(localTgz)], {
      cwd: scratch, stdio: 'inherit', shell: process.platform === 'win32',
    })
  } catch (error) {
    check('tarball installs', false, String(error.message).split('\n')[0])
  }

  const installed = path.join(scratch, 'node_modules', 'dsh-plugin-permission-guard')
  const installedManifest = path.join(installed, 'package.json')
  const present = fs.existsSync(installedManifest)
  check('the package is installed', present, installed)
  if (!present) { throw new Error('nothing further can be checked') }

  const manifest = JSON.parse(fs.readFileSync(installedManifest, 'utf8'))
  check('version is 1.0.1', manifest.version === '1.0.1', manifest.version)
  check('declares dsh.bundle.patch (how the harness learns to apply its patch)',
    manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch === './cordis.patch.yml',
    JSON.stringify(manifest.dsh && manifest.dsh.bundle))
  check('declares dsh.client.platform (so a browser bundle is composed)',
    manifest.dsh && manifest.dsh.client && manifest.dsh.client.platform === 'web',
    JSON.stringify(manifest.dsh && manifest.dsh.client))

  const binShim = path.join(scratch, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh-permission-guard.cmd' : 'dsh-permission-guard')
  const shimExists = fs.existsSync(binShim)
  check('the CLI shim was created', shimExists, binShim)
  if (shimExists) {
    let out = ''
    try {
      out = execFileSync(binShim, ['--help'], { encoding: 'utf8', shell: process.platform === 'win32' })
    } catch (error) {
      out = 'THREW: ' + String(error.message)
    }
    check('the CLI runs and prints usage', /Usage:/.test(out) && /install/.test(out), out.split('\n')[0])
  }

  // The two behaviours a static analysis service raised. Both are asserted on the INSTALLED bytes.
  const installedSource = fs.readFileSync(path.join(installed, 'index.js'), 'utf8')

  check('fail-closed branch present: the tool refuses when tools.guard is missing',
    /refused: true/.test(installedSource), 'looking for the refusal in permission_mode')

  // Locate the ACTUAL response payload, not the surrounding prose. The first attempt sliced from the
  // route path to the registration log, which swept in the comments explaining what was removed —
  // and a comment mentioning a field is not a disclosure. Match the JSON.stringify call instead.
  const payloadMatch = /const payload = JSON\.stringify\(\{([\s\S]{0,400}?)\}\)/.exec(installedSource)
  const payloadFields = payloadMatch === null ? null : payloadMatch[1]
  check('the HTTP payload was located', payloadFields !== null)

  if (payloadFields !== null) {
    const fields = payloadFields.split(',').map(function (f) { return String(f).split(':')[0].trim() }).filter(Boolean)
    console.log('    payload fields: ' + JSON.stringify(fields))
    check('the HTTP payload returns NO workspace or filesystem path',
      fields.indexOf('fallbackWorkspace') === -1 && fields.indexOf('workspace') === -1
        && fields.indexOf('stateFile') === -1,
      JSON.stringify(fields))
    check('the HTTP payload returns only mode identity',
      fields.length > 0 && fields.every(function (f) { return ['id', 'name', 'summary'].indexOf(f) !== -1 }),
      JSON.stringify(fields))
  }

  // And drive it: mount the INSTALLED copy and confirm a switch is refused with no guard.
  delete require.cache[require.resolve(installedManifest.replace(/package\.json$/, 'index.js'))]
  const plugin = (function (m) { return m.default || m })(require(path.join(installed, 'index.js')))
  const tools = []
  const svc = {
    tools: { register: function (t) { tools.push(t) }, get: function () { return {} }, schemas: function () { return [] } },
    systemPrompt: { section: function () {} },
    webServer: { register: function () { return function () {} } },
    sessions: { list: function () { return [] }, get: function () { return undefined } },
    approval: { setPolicy: function () {}, request: function () { return Promise.resolve('u') } },
    web: { fetch: async function () {}, search: async function () {} },
  }
  const ctx = {
    on: function () { return function () {} },
    effect: function (fn) { try { fn() } catch (e) {} return function () {} },
    get: function (n) { return svc[n] },
    provide: function () { return function () {} },
    inject: function (deps, cb) {
      const scoped = Object.assign({}, svc)
      scoped.get = function (n) { return svc[n] }
      scoped.effect = ctx.effect
      scoped.on = function () { return function () {} }
      scoped.inject = function () { return function () {} }
      scoped.provide = function () { return function () {} }
      if (typeof cb === 'function') cb(scoped)
      return function () {}
    },
  }
  plugin.apply(ctx)
  const set = tools.find(function (t) { return t.name === 'permission_mode' })
  check('the installed copy registers permission_mode', set !== undefined)
  if (set !== undefined) {
    const attempt = set.execute({ mode: 4 }, {})
    check('the installed copy REFUSES a switch with no tools.guard (fail-closed)',
      attempt && attempt.refused === true, JSON.stringify(attempt).slice(0, 120))
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log('')
console.log(failures === 0 ? 'TARBALL VERIFY OK' : failures + ' FAILURES')
process.exitCode = failures === 0 ? 0 : 1
