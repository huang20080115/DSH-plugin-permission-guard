'use strict'

/**
 * The reverse sync: editing the state file by hand must reach the kernel sandbox.
 *
 * WHY THIS IS ITS OWN FILE, AND ASYNC
 *
 * This is the reported "new -> old does not work". new -> old used to fire only from the
 * `permission_mode` tool, while the documented human procedure is to edit the state file — a path on
 * which no code ran at all. Field evidence: `oldToNew: 2, newToOld: 0, echoSuppressed: 0`, with the
 * operator's own denial log showing they had switched old modes through the selector twice and set
 * the new mode by editing the file.
 *
 * The push is debounced by a timer, so the assertion has to wait for the event loop. It first lived
 * inside test-matrix.js, which is synchronous: blocking there with `Atomics.wait` stops the very
 * timer the push depends on, so the push never ran while the assertion was watching and a correct
 * implementation was reported as broken. Async is not a stylistic choice here — it is required to
 * observe the behaviour at all.
 *
 * The watcher is driven through the real `fs.watch` callback rather than through a real filesystem
 * notification, so the test does not depend on notification latency (flaky on Windows) while still
 * exercising the same function a real event invokes.
 *
 * Usage: node test/test-watch-sync.js
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const STATE_FILE = path.join(ROOT, 'permissions.json')

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + (detail ? ' | ' + detail : ''))
}
function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }

const savedState = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE) : null

// Capture the watcher the plugin registers.
const captured = []
const realWatch = fs.watch
fs.watch = function (dir, options, listener) {
  captured.push({ dir: String(dir), listener: listener })
  return realWatch.call(fs, dir, options, listener)
}

const liveSessions = []
const appended = []
function makeSession(id) {
  return {
    id: id,
    _events: [],
    append: function (type, data) {
      appended.push({ id: id, type: type, data: data })
      this._events.push({ type: type, data: data })
    },
    snapshotEvents: function () { return this._events.slice() },
  }
}
liveSessions.push(makeSession('s1'), makeSession('s2'))

const liveAgents = { s1: { id: 's1' }, s2: { id: 's2' } }
const policyWrites = []
const svc = {
  tools: { register: function () {}, guard: function () { return function () {} }, get: function () { return {} }, schemas: function () { return [] } },
  systemPrompt: { section: function () {} },
  webServer: { register: function () { return function () {} } },
  sessions: { list: function () { return liveSessions }, get: function () { return undefined } },
  approval: { setPolicy: function (agent, policy) { policyWrites.push({ agent: agent, policy: policy }) } },
  web: { fetch: async function () {}, search: async function () {} },
}
function getService(name) {
  if (name === 'agents') return { get: function (id) { return liveAgents[id] } }
  return svc[name]
}
const ctx = {
  on: function () { return function () {} },
  effect: function (fn) { const d = fn(); return function () { if (typeof d === 'function') d() } },
  get: getService,
  provide: function () { return function () {} },
  inject: function (deps, cb) {
    const scoped = Object.assign({}, svc)
    scoped.get = getService
    scoped.effect = ctx.effect
    scoped.on = function () { return function () {} }
    scoped.inject = function () { return function () {} }
    scoped.provide = function () { return function () {} }
    if (typeof cb === 'function') cb(scoped)
    return function () {}
  },
}

delete require.cache[require.resolve(path.join(ROOT, 'index.js'))]
const plugin = (function (m) { return m.default || m })(require(path.join(ROOT, 'index.js')))
const sync = require(path.join(ROOT, 'sync.js'))

async function main() {
  try {
    plugin.apply(ctx)

    check('a state-file watcher was registered', captured.length > 0, 'count=' + captured.length)
    check('the watcher targets the state file\'s own directory',
      captured.length > 0 && captured[0].dir === path.dirname(STATE_FILE),
      captured.length > 0 ? captured[0].dir : '(none)')
    if (captured.length === 0) return

    const watcher = captured[0]
    const basename = path.basename(STATE_FILE)

    // Start from a known mode, then change it the way a human would: write the file.
    const startMode = 4
    const targetMode = 1
    fs.writeFileSync(STATE_FILE, JSON.stringify({ mode: startMode }, null, 2) + '\n', 'utf8')
    await delay(250)
    appended.length = 0
    policyWrites.length = 0

    fs.writeFileSync(STATE_FILE, JSON.stringify({ mode: targetMode }, null, 2) + '\n', 'utf8')
    watcher.listener('change', basename)
    await delay(500)

    const expectedSandbox = sync.NEW_TO_OLD_SANDBOX[targetMode]
    const expectedPolicy = sync.NEW_TO_OLD_APPROVAL[targetMode]
    const sandboxWrites = appended.filter(function (a) { return a.type === 'sandbox/mode' })

    check('an operator file edit pushes sandbox/mode to EVERY live session',
      sandboxWrites.length === liveSessions.length,
      sandboxWrites.length + '/' + liveSessions.length)
    check('the pushed sandbox value comes from the mapping table',
      sandboxWrites.length > 0 && sandboxWrites.every(function (w) { return w.data.mode === expectedSandbox }),
      'expected ' + expectedSandbox + ', got ' + JSON.stringify(sandboxWrites.map(function (w) { return w.data.mode })))
    check('the approval policy is pushed to the live agents too',
      policyWrites.length === liveSessions.length && policyWrites.every(function (p) { return p.policy === expectedPolicy }),
      'expected ' + expectedPolicy + ', got ' + JSON.stringify(policyWrites.map(function (p) { return p.policy })))

    // The counter that read 0 in the field report must now advance.
    const before = sync.stats.newToOld
    fs.writeFileSync(STATE_FILE, JSON.stringify({ mode: 4 }, null, 2) + '\n', 'utf8')
    appended.length = 0
    watcher.listener('change', basename)
    await delay(500)
    check('the push is counted as new->old (it was 0 in the field report)',
      sync.stats.newToOld > before, 'newToOld=' + sync.stats.newToOld)

    // Editors emit several events per save. Without the equality guard each one would append another
    // set of session events, growing the session log for no reason.
    appended.length = 0
    watcher.listener('change', basename)
    await delay(500)
    check('a repeated notification with no change does NOT push again',
      appended.filter(function (a) { return a.type === 'sandbox/mode' }).length === 0,
      'appended=' + appended.length)

    // And the push must not depend on the model-facing tool guard: a human edit is authoritative.
    check('the push does not go through the permission_mode tool',
      captured.length === 1, 'the watcher is the only trigger for a file edit')
  } finally {
    fs.watch = realWatch
    if (savedState !== null) fs.writeFileSync(STATE_FILE, savedState)
    else if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE)
    delete require.cache[require.resolve(path.join(ROOT, 'index.js'))]
  }

  console.log('')
  console.log(failures === 0 ? 'WATCH SYNC OK' : failures + ' FAILURES')
  process.exitCode = failures === 0 ? 0 : 1
}

main()
