'use strict'

/**
 * Boot-safety check: apply the plugin in an environment that has NO dynamic-plugin
 * builtins.
 *
 * This exists because the plugin failed the real load twice with
 *   ReferenceError: harness is not defined
 * after calls to `harness.handle` were added. `harness` is injected only by the
 * dynamic evaluator; a profile plugin never has it. A test double that provides
 * `harness` (as test-matrix.js does, to exercise the tool path) would MASK exactly
 * that failure, so this check deliberately runs the opposite way: it asserts the
 * module applies with `harness` absent.
 *
 * Run standalone: `node test-boot-safety.js`
 */

const fs = require('node:fs')
const path = require('node:path')

/**
 * The package root, which is this file's parent. The suite lives in `test/` so it can be published
 * and excluded from the package by a single `files` entry, which means everything it exercises
 * belongs to the package root rather than to the test directory.
 */
const ROOT = path.join(__dirname, '..')

const GLOBALS_THAT_MUST_NOT_BE_USED = ['harness']

let failures = 0

// 1. No dynamic-only builtin may be referenced anywhere in the module text.
const source = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8')
const executable = source
  .split('\n')
  .filter(function (line) {
    const t = line.trim()
    return t !== '' && t.indexOf('*') !== 0 && t.indexOf('//') !== 0
  })
  .join('\n')

for (const name of GLOBALS_THAT_MUST_NOT_BE_USED) {
  const pattern = new RegExp('(^|[^.\\w])' + name + '\\s*\\.', 'm')
  const used = pattern.test(executable)
  if (used) failures += 1
  console.log((used ? 'FAIL' : 'PASS') + ' | profile plugin never dereferences `' + name + '`')
}

// 2. Applying with no dynamic builtins present must not throw.
const ctx = {
  on: function () { return function () {} },
  inject: function () { throw new Error('inject called; this simple ctx does not provide services') },
  effect: function () { return function () {} },
}

let applyError = null
try {
  // Ensure the dynamic builtins truly are absent.
  delete globalThis.harness
  const plugin = require(path.join(ROOT, 'index.js'))
  plugin.apply(ctx)
} catch (error) {
  // `inject` intentionally throws here; only a ReferenceError naming a dynamic
  // builtin is a boot-safety failure.
  applyError = error
}

const bootstrap = {
  on: function (name, fn) { if (name) { /* record nothing */ } return function () {} },
  inject: function (deps, cb) {
    // Provide every service the plugin injects, so apply() runs to completion.
    // A MISSING entry here surfaces as a TypeError rather than a false pass, which
    // is how this file caught its own gap when the mode route and the old/new sync
    // were added.
    const services = {
      // The sync injection reads syncCtx.effect and syncCtx.get as well as the two
      // services, so the scoped context object mirrors the outer context's helpers.
      // Real ctx.effect(callback) EXECUTES the callback and keeps the returned
      // disposer; state a plugin assigns inside its effect depends on that.
      effect: function (fn) { fn(); return function () {} },
      get: function () { return undefined },
      on: function () { return function () {} },
      inject: function () { return function () {} },
    }
    if (deps.indexOf('systemPrompt') !== -1) services.systemPrompt = { section: function () {} }
    if (deps.indexOf('tools') !== -1) {
      services.tools = {
        register: function () {},
        // Present, so apply() does not take its "tools.guard unavailable" branch. Without it
        // this check still passed, but it printed a misleading error line claiming the
        // mode-switch control was missing when only the stub was incomplete.
        guard: function () { return function () {} },
      }
    }
    if (deps.indexOf('webServer') !== -1) services.webServer = { register: function () { return function () {} } }
    if (deps.indexOf('sessions') !== -1) {
      services.sessions = {
        list: function () { return [] },
        get: function () { return undefined },
      }
    }
    if (deps.indexOf('approval') !== -1) {
      services.approval = { setPolicy: function () {}, request: function () { return Promise.resolve('unavailable') } }
    }
    cb(services)
  },
  effect: function (fn) { fn(); return function () {} },
  get: function () { return undefined },
}

let realError = null
try {
  delete require.cache[require.resolve(path.join(ROOT, 'index.js'))]
  const fresh = require(path.join(ROOT, 'index.js'))
  fresh.apply(bootstrap)
} catch (error) {
  realError = error
}

const applied = realError === null
if (!applied) failures += 1
console.log((applied ? 'PASS' : 'FAIL') + ' | apply() completes with no dynamic builtins'
  + (realError ? ' | threw: ' + realError.message : ''))
if (applyError !== null && realError === null) {
  console.log('note: first probe threw as designed (' + applyError.message + ')')
}

console.log(failures === 0 ? 'BOOT SAFE' : failures + ' BOOT-SAFETY FAILURES')
process.exitCode = failures === 0 ? 0 : 1
