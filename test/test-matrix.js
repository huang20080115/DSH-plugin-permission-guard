'use strict'

/**
 * Enforcement matrix for the permission guard.
 *
 * Each case drives the real plugin through its real `tools/pre-execute`
 * listener, with a fake fs/tools/systemPrompt context, across all four modes and
 * both sides of the workspace boundary. Nothing here re-implements the policy:
 * the matrix is the assertion, the plugin is the implementation under test.
 */

const fs = require('node:fs')
const path = require('node:path')

/**
 * The package root, which is this file's parent.
 *
 * The suite lives in `test/` so that it can be published and excluded from the package by one
 * `files` entry. Everything it exercises — index.js, modes.js, sync.js, and the state file they
 * create — belongs to the PACKAGE ROOT, not to the test directory. Deriving it once here keeps the
 * two from drifting apart.
 */
const ROOT = path.join(__dirname, '..')
const plugin = require(path.join(ROOT, 'index.js'))
const modes = require(path.join(ROOT, 'modes.js'))
const sync = require(path.join(ROOT, 'sync.js'))

/**
 * Derived from the test file's own location, exactly as index.js derives it from
 * its own. Two literals would be two sources of truth and would silently drift the
 * moment the plugin moves — which is what just happened when the state file left
 * the workspace.
 */
const STATE_FILE = path.join(ROOT, 'permissions.json')
/** The state file's former name. Fenced alongside the current one, and the source of the
 *  one-time rename handover, so the suite needs to name it. */
const STATE_FILE_ZH = '权限设置.json'
const WORKSPACE = 'D:\\DeepSeek Harness'
const IN = 'D:\\DeepSeek Harness\\sub\\file.txt'
const OUT = 'C:\\Users\\ASUS\\Desktop\\外.txt'
const OUT2 = 'D:\\另一个目录\\x.txt'
const ESCAPE = '..\\..\\escape.txt'

let listener = null
let agentCreated = null
const registeredTools = []
/** Monotonic tool guards the plugin registered. See `scopedContext` for why this matters. */
const registeredGuards = []
const registeredProjections = []
const registeredCommands = []
const registeredRoutes = []
/** Live sessions the sync is allowed to write; each records appended events. */
const liveSessions = []
/** sessionId -> agent, as ctx.agents.get would answer. */
const liveAgents = {}
/** Every approval.setPolicy call the sync makes. */
const policyWrites = []
/** Session-event listeners registered on the root context. */
const sessionEventListeners = []
/** Disposers returned by executed ctx.effect callbacks. */
const disposers = []
const effects = []
const sections = []

/**
 * Scoped context that mimics the real Cordis Guard: inside an inject callback,
 * reading an UNDECLARED service property throws.
 *
 * The first version of this harness handed the callback `Object.assign({}, ctx, svc)`,
 * so every service stayed reachable and an undeclared `ctx.tools` read succeeded.
 * That is exactly why the suite passed while the real plugin failed to load with
 * `cannot get property "tools" without inject`. A test double that is more
 * permissive than production turns a load failure into a green check.
 */
function scopedContext(deps) {
  const svc = {}
  if (deps.indexOf('tools') !== -1) {
    svc.tools = {
      register: function (t) { registeredTools.push(t) },
      // The monotonic guard seam. It MUST exist here: when it is missing the plugin takes
      // its "tools.guard unavailable" branch and only logs, which is correct behaviour but
      // leaves the mode-switch control completely unverified — the suite went green while
      // the guard was never exercised. A security control that no test drives is the same
      // as one that does not work.
      guard: function (g) { registeredGuards.push(g); return function () {} },
      get: function () { return {} },
      schemas: function () { return [] },
    }
  }
  if (deps.indexOf('systemPrompt') !== -1) {
    svc.systemPrompt = { section: function (s) { sections.push(s) } }
  }
  if (deps.indexOf('sessionProjections') !== -1) {
    svc.sessionProjections = {
      register: function (d) { registeredProjections.push(d); return function () {} },
    }
  }
  if (deps.indexOf('commands') !== -1) {
    svc.commands = { register: function (d) { registeredCommands.push(d); return function () {} } }
  }
  if (deps.indexOf('webServer') !== -1) {
    svc.webServer = { register: function (r) { registeredRoutes.push(r); return function () {} } }
  }
  if (deps.indexOf('sessions') !== -1) {
    svc.sessions = {
      list: function () { return liveSessions.slice() },
      get: function (id) {
        for (let i = 0; i < liveSessions.length; i++) if (liveSessions[i].id === id) return liveSessions[i]
        return undefined
      },
    }
  }
  if (deps.indexOf('approval') !== -1) {
    svc.approval = { setPolicy: function (agent, policy) { policyWrites.push({ agent: agent, policy: policy }) } }
  }
  return new Proxy(svc, {
    get: function (target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'on') return ctx.on
      if (prop === 'inject') return ctx.inject
      if (prop === 'effect') return ctx.effect
      // `agents` is read through c.get('agents') by the sync helper.
      if (prop === 'get') return function (name) { return name === 'agents' ? { get: function (id) { return liveAgents[id] } } : undefined }
      throw new Error('cannot get property "' + String(prop) + '" without inject')
    },
    has: function (target, prop) { return prop in target },
  })
}

const ctx = {
  on: function (name, fn) {
    if (name === 'tools/pre-execute') listener = fn
    if (name === 'agent/created') agentCreated = fn
    if (name === 'session/event') sessionEventListeners.push(fn)
  },
  inject: function (deps, cb) { cb(scopedContext(deps)) },
  // Real ctx.effect(callback) EXECUTES the callback and keeps the disposer it
  // returns. The earlier stub pushed the callback itself, so a plugin that assigns
  // state inside its effect (the sync's push hook) never got that assignment and the
  // suite silently lost the whole new->old direction. Run it and keep the disposer.
  effect: function (fn) { const disposer = fn(); disposers.push(disposer); return function () {} },
}

// The `harness` builtin is injected by the host at load time. Provide the two
// halves this plugin uses so the suite exercises the real code path instead of
// skipping it, and so a missing handler shows up as a failed assertion.
const handlers = new Map()
globalThis.harness = {
  handle: function (method, fn) { handlers.set(method, fn); return function () {} },
  defineTool: function (d) { return d },
  registerTool: function () { return function () {} },
}

plugin.apply(ctx)
if (listener === null) { console.log('FATAL: no tools/pre-execute listener registered'); process.exit(1) }

const AGENT = { session: { header: { cwd: WORKSPACE } } }

/** Read the mode currently persisted on disk, without trusting the plugin's view. */
function currentOnDisk() {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).mode
}

/** Run one pending call through the listener and report whether it was denied. */
function run(name, args) {
  let passed = false
  const returned = listener({ name: name, arguments: args, agent: AGENT }, function () { passed = true })
  if (passed) return { denied: false }
  if (returned && returned.kind === 'deny') return { denied: true, reason: returned.reason }
  return { denied: false, note: 'listener neither denied nor called next' }
}

const CASES = [
  // mode, tool, args, shouldDeny, label
  [1, 'read', { file_path: IN }, false, 'm1 读工作区内 -> 允许'],
  [1, 'read', { file_path: OUT }, true, 'm1 读工作区外 -> 拒绝'],
  [1, 'write', { file_path: IN, content: 'x' }, true, 'm1 写工作区内 -> 拒绝'],
  [1, 'write', { file_path: OUT, content: 'x' }, true, 'm1 写工作区外 -> 拒绝'],
  [1, 'read', { file_path: ESCAPE }, true, 'm1 相对路径逃逸 -> 拒绝'],

  [2, 'read', { file_path: IN }, false, 'm2 读工作区内 -> 允许'],
  [2, 'read', { file_path: OUT }, true, 'm2 读工作区外 -> 拒绝'],
  [2, 'write', { file_path: IN, content: 'x' }, false, 'm2 写工作区内 -> 允许'],
  [2, 'write', { file_path: OUT, content: 'x' }, true, 'm2 写工作区外 -> 拒绝'],

  [3, 'read', { file_path: IN }, false, 'm3 读工作区内 -> 允许'],
  [3, 'read', { file_path: OUT }, false, 'm3 读工作区外 -> 允许'],
  [3, 'write', { file_path: IN, content: 'x' }, false, 'm3 写工作区内 -> 允许'],
  [3, 'write', { file_path: OUT, content: 'x' }, true, 'm3 写工作区外 -> 拒绝'],

  [4, 'read', { file_path: OUT }, false, 'm4 读工作区外 -> 允许'],
  [4, 'write', { file_path: OUT, content: 'x' }, false, 'm4 写工作区外 -> 允许'],

  // tree reads
  [1, 'grep', { pattern: 'x', path: OUT }, true, 'm1 grep 工作区外 -> 拒绝'],
  [3, 'grep', { pattern: 'x', path: OUT }, false, 'm3 grep 工作区外 -> 允许'],
  [1, 'glob', { pattern: '*', path: IN }, false, 'm1 glob 工作区内 -> 允许'],

  // str_replace_editor
  [1, 'str_replace_editor', { path: IN, old_str: 'a', new_str: 'b' }, true, 'm1 str_replace_editor 工作区内 -> 拒绝（写）'],
  [2, 'str_replace_editor', { path: IN, old_str: 'a', new_str: 'b' }, false, 'm2 str_replace_editor 工作区内 -> 允许'],

  // shell: read outside
  [1, 'pwsh', { command: 'Get-Content "' + OUT + '"' }, true, 'm1 shell 读工作区外 -> 拒绝'],
  [3, 'pwsh', { command: 'Get-Content "' + OUT + '"' }, false, 'm3 shell 读工作区外 -> 允许'],
  [1, 'pwsh', { command: 'Get-Content "' + IN + '"' }, false, 'm1 shell 读工作区内 -> 允许'],
  [1, 'pwsh', { command: 'Get-Content ..\\..\\escape.txt' }, true, 'm1 shell 相对逃逸 -> 拒绝'],
  [2, 'pwsh', { command: 'Set-Content "' + OUT + '" -Value x' }, true, 'm2 shell 写工作区外 -> 拒绝'],
  [3, 'pwsh', { command: 'Set-Content "' + OUT + '" -Value x' }, true, 'm3 shell 写工作区外 -> 拒绝'],
  [4, 'pwsh', { command: 'Set-Content "' + OUT + '" -Value x' }, false, 'm4 shell 写工作区外 -> 允许'],
  [1, 'pwsh', { command: 'rg foo ' + OUT2 }, true, 'm1 shell 裸路径工作区外 -> 拒绝'],

  // unrelated tools must never be touched
  [1, 'todo_write', { todos: [] }, false, 'm1 无关工具 -> 不受影响'],
  [1, 'web_search', { queries: ['x'] }, false, 'm1 网络工具 -> 不受影响'],
]

let failures = 0
const originalState = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE) : null

try {
  for (const [modeId, tool, args, shouldDeny, label] of CASES) {
    const set = registeredTools.find(function (t) { return t.name === 'permission_mode' })
    if (!set) { console.log('FATAL: permission_mode tool not registered'); process.exit(1) }
    set.execute({ mode: modeId })

    const result = run(tool, args)
    const ok = result.denied === shouldDeny
    if (!ok) failures += 1
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | denied=' + result.denied
      + (ok ? '' : ' (expected ' + shouldDeny + ')'))
  }
} finally {
  if (originalState !== null) fs.writeFileSync(STATE_FILE, originalState)
}

console.log('--- registration + hygiene ---')
const cases = [
  ['permission_mode tool registered', registeredTools.some(function (t) { return t.name === 'permission_mode' })],
  ['system-prompt boundary section registered', sections.length === 1 && sections[0].name === 'permission-guard:boundaries'],
  ['four modes available', modes.PERMISSION_MODES.length === 4],
  ['mode ids are 1..4', modes.modeIdList().join(',') === '1,2,3,4'],
]
for (const [label, ok] of cases) {
  if (!ok) failures += 1
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label)
}

// Exercising the prompt callback is the assertion that would have caught the
// `cannot get property "tools" without inject` load failure: registering a
// section is not the same as being able to produce its text.
console.log('--- prompt section callback runs under the scoped guard ---')
{
  let textValue = null
  let thrown = null
  try {
    textValue = sections[0].text({})
  } catch (error) {
    thrown = error
  }
  const ran = thrown === null && typeof textValue === 'string' && textValue.length > 0
  if (!ran) failures += 1
  console.log((ran ? 'PASS' : 'FAIL') + ' | section text() produced output'
    + (thrown ? ' | threw: ' + thrown.message : '')
    + (!thrown && typeof textValue === 'string' ? ' | ' + textValue.slice(0, 48) + '...' : ''))
}

console.log('--- state file round trip ---')
const s = registeredTools.find(function (t) { return t.name === 'permission_mode' })
const switched = s.execute({ mode: 3 })
const onDisk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
const roundTrip = onDisk.mode === 3
if (!roundTrip) failures += 1
console.log((roundTrip ? 'PASS' : 'FAIL') + ' | switching persists mode=' + onDisk.mode)
const reported = s.execute({})
const reportsMode = reported && reported.current && reported.current.id === 3
if (!reportsMode) failures += 1
console.log((reportsMode ? 'PASS' : 'FAIL') + ' | status reports current mode=' + (reported && reported.current ? reported.current.id : 'n/a'))

// The plugin directory's file is the ONLY authority. These assertions state desired
// behaviour, so a future "convenience" fallback cannot be added without turning this suite
// The mode-switch guard is the control that makes "the model cannot raise its own
// permissions" true FOR THE TOOL PATH. The file fence never covered it: `permission_mode`
// calls persistMode() in-process and never traverses tools/pre-execute. Before this guard
// existed, the agent could simply call the tool and move itself to mode 4.
console.log('--- mode-switch guard (a tool call must not widen the model\'s own access) ---')
{
  const guard = registeredGuards[0]
  const hasGuard = typeof guard === 'function'
  if (!hasGuard) failures += 1
  console.log((hasGuard ? 'PASS' : 'FAIL') + ' | the plugin registered a monotonic tools.guard'
    + (hasGuard ? '' : ' | guards=' + registeredGuards.length))

  if (hasGuard) {
    const request = function (id) {
      return guard({ name: 'permission_mode', arguments: id === undefined ? {} : { mode: id }, agent: { id: 's1' } })
    }

    // Report and no-op: not escalations.
    const reportAllowed = request(undefined) === undefined
    if (!reportAllowed) failures += 1
    console.log((reportAllowed ? 'PASS' : 'FAIL') + ' | reporting the mode is allowed')

    // WIDENING from the current mode. The suite runs at whatever mode the state file holds,
    // so escalate from an explicitly narrower one to keep the expectation independent of it.
    const beforeGuardTest = currentOnDisk()
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ mode: 2 }, null, 2) + '\n', 'utf8')
      const widen = request(4)
      const widenDenied = typeof widen === 'string' && widen.length > 0
      if (!widenDenied) failures += 1
      console.log((widenDenied ? 'PASS' : 'FAIL') + ' | WIDENING 2 -> 4 is DENIED'
        + (widenDenied ? ' | ' + widen.slice(0, 60) + '...' : ' | the escalation path is open'))

      const widen3 = request(3)
      const widen3Denied = typeof widen3 === 'string' && widen3.length > 0
      if (!widen3Denied) failures += 1
      console.log((widen3Denied ? 'PASS' : 'FAIL') + ' | WIDENING 2 -> 3 is DENIED')

      const same = request(2) === undefined
      if (!same) failures += 1
      console.log((same ? 'PASS' : 'FAIL') + ' | setting the CURRENT mode is allowed')

      // Narrowing must stay allowed: refusing it would protect nothing and would block a
      // genuine containment action.
      const narrow = request(1) === undefined
      if (!narrow) failures += 1
      console.log((narrow ? 'PASS' : 'FAIL') + ' | NARROWING 2 -> 1 is allowed (giving up access is not escalation)')

      // An unrelated tool must pass through untouched.
      const other = guard({ name: 'write', arguments: { file_path: 'D:\\x.txt', content: 'y' }, agent: { id: 's1' } }) === undefined
      if (!other) failures += 1
      console.log((other ? 'PASS' : 'FAIL') + ' | an unrelated tool call is untouched')
    } finally {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ mode: beforeGuardTest }, null, 2) + '\n', 'utf8')
    }
  }
}

// FAIL-CLOSED WHEN tools.guard IS ABSENT.
//
// This asserts the behaviour that a static analysis service flagged as a material weakening: with
// no guard seam available, `permission_mode` used to still change the mode and merely report that it
// could not stop itself — fail-OPEN for the one operation this plugin exists to prevent.
//
// It needs a SEPARATE plugin instance mounted against a context whose `tools` service has no
// `guard`, which is why it cannot reuse the suite's main instance.
console.log('--- fail-closed: no tools.guard => the tool must REFUSE to switch ---')
{
  const modeBefore = currentOnDisk()
  try {
    // Mount a fresh copy whose tools service deliberately lacks `guard`.
    delete require.cache[require.resolve(path.join(ROOT, 'index.js'))]
    const fresh = require(path.join(ROOT, 'index.js'))
    const tools = []
    const svc = {
      tools: {
        register: function (t) { tools.push(t) },
        get: function () { return {} },
        schemas: function () { return [] },
        // NOTE: no `guard` method. That is the whole point.
      },
      systemPrompt: { section: function () {} },
      webServer: { register: function () { return function () {} } },
      sessions: { list: function () { return [] }, get: function () { return undefined } },
      approval: { setPolicy: function () {}, request: function () { return Promise.resolve('unavailable') } },
      web: { fetch: async function () {}, search: async function () {} },
    }
    const noGuardCtx = {
      on: function () { return function () {} },
      effect: function (fn) { try { fn() } catch (e) {} return function () {} },
      get: function (n) { return svc[n] },
      provide: function () { return function () {} },
      inject: function (deps, cb) {
        const scoped = Object.assign({}, svc)
        scoped.get = function (n) { return svc[n] }
        scoped.effect = noGuardCtx.effect
        scoped.on = function () { return function () {} }
        scoped.inject = function () { return function () {} }
        scoped.provide = function () { return function () {} }
        if (typeof cb === 'function') cb(scoped)
        return function () {}
      },
    }
    fresh.apply(noGuardCtx)

    const set = tools.find(function (t) { return t.name === 'permission_mode' })
    const mounted = set !== undefined
    if (!mounted) failures += 1
    console.log((mounted ? 'PASS' : 'FAIL') + ' | the tool still registers without tools.guard (reporting stays available)')

    if (mounted) {
      const report = set.execute({}, {})
      const reports = report && report.current && typeof report.current.id === 'number'
      if (!reports) failures += 1
      console.log((reports ? 'PASS' : 'FAIL') + ' | reporting still works without the guard')

      const caps = report && report.capabilities ? report.capabilities : {}
      const saysInactive = caps.toolsGuard === false
      if (!saysInactive) failures += 1
      console.log((saysInactive ? 'PASS' : 'FAIL') + ' | the report states toolsGuard=false')

      // Pick a target that DIFFERS from the current mode, so a switch would be observable.
      const target = modeBefore === 4 ? 1 : 4
      const attempt = set.execute({ mode: target }, {})
      const refused = attempt && attempt.refused === true && attempt.ok === false
      if (!refused) failures += 1
      console.log((refused ? 'PASS' : 'FAIL') + ' | a switch attempt is REFUSED (fail-closed), not merely reported')

      const unchanged = currentOnDisk() === modeBefore
      if (!unchanged) failures += 1
      console.log((unchanged ? 'PASS' : 'FAIL') + ' | the mode on disk is UNCHANGED after the refused attempt ('
        + modeBefore + ')')
    }
  } finally {
    // Restore the module cache so later assertions use the guarded instance again.
    delete require.cache[require.resolve(path.join(ROOT, 'index.js'))]
    fs.writeFileSync(STATE_FILE, JSON.stringify({ mode: modeBefore }, null, 2) + '\n', 'utf8')
  }
}

// red.
//
// NOTE ON THE STRAY PATH. It is the LEGACY workspace-root location, chosen deliberately:
// it shares the former FILENAME but not the directory, so it exercises "another directory
// is ignored" without accidentally tripping the same-directory rename handover (which has
// its own suite below). Using the former filename HERE is the point — that is the name a
// stale copy would realistically carry.
console.log('--- single source of truth (no fallback) ---')
{
  const STRAY = path.join('D:\\DeepSeek Harness', STATE_FILE_ZH)
  const savedState = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE) : null
  const savedStray = fs.existsSync(STRAY) ? fs.readFileSync(STRAY) : null
  try {
    // 1. A stray copy elsewhere on disk must NOT influence the mode.
    fs.writeFileSync(STATE_FILE, JSON.stringify({ mode: 2 }, null, 2) + '\n', 'utf8')
    fs.writeFileSync(STRAY, JSON.stringify({ mode: 4 }, null, 2) + '\n', 'utf8')
    const ignored = s.execute({})
    const gotIgnored = ignored && ignored.current ? ignored.current.id : null
    const isIgnored = gotIgnored === 2
    if (!isIgnored) failures += 1
    console.log((isIgnored ? 'PASS' : 'FAIL') + ' | a stray copy in another directory is IGNORED (got ' + gotIgnored + ', expected 2)')

    // 2. With the live file gone, the mode must drop to fail-safe 1 — NOT over to the stray.
    fs.unlinkSync(STATE_FILE)
    fs.writeFileSync(STRAY, JSON.stringify({ mode: 4 }, null, 2) + '\n', 'utf8')
    const degraded = s.execute({})
    const gotDegraded = degraded && degraded.current ? degraded.current.id : null
    // 2. With the live file gone, the mode must drop to the fail-safe DEFAULT — NOT over to the
    //    stray copy. Read from modes.js rather than written as a literal: this default changed
    //    from 1 to 2 when the plugin became distributable, and the stale literal is exactly what
    //    made this assertion fail against correct code.
    const failsSafe = gotDegraded === modes.DEFAULT_MODE_ID
    if (!failsSafe) failures += 1
    console.log((failsSafe ? 'PASS' : 'FAIL') + ' | a missing live file fails SAFE to the default ('
      + modes.DEFAULT_MODE_ID + '), not over to the stray copy (got ' + gotDegraded + ')')

    // 3. The degraded state must be visible on disk, not silent. The re-seed happens in
    //    `apply()`, so re-applying is what a restart does — a mode that silently reverts
    //    with no trace on disk is the worst outcome of removing the fallback.
    plugin.apply(ctx)
    const seeded = fs.existsSync(STATE_FILE)
      && JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).mode === modes.DEFAULT_MODE_ID
    if (!seeded) failures += 1
    console.log((seeded ? 'PASS' : 'FAIL') + ' | apply() re-seeds the live file at the default ('
      + modes.DEFAULT_MODE_ID + ') so the loss is visible')
  } finally {
    if (savedState !== null) fs.writeFileSync(STATE_FILE, savedState)
    if (savedStray !== null) fs.writeFileSync(STRAY, savedStray)
    else if (fs.existsSync(STRAY)) fs.unlinkSync(STRAY)
  }
}

// The ONE handover that is allowed: the state file's former NAME, in the SAME directory.
// Without it, renaming the file silently drops every deployment to fail-safe mode 1 — a
// permission change caused by cosmetics. These assertions pin both the handover and its
// two safety properties (single-shot and consumed), because those are what separate it from
// the general fallback that was deleted.
console.log('--- renamed state-file handover ---')
{
  const FORMER = path.join(ROOT, STATE_FILE_ZH)
  const savedState = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE) : null
  const savedFormer = fs.existsSync(FORMER) ? fs.readFileSync(FORMER) : null
  try {
    // The former name carries the operator's real mode; the current name is absent.
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE)
    fs.writeFileSync(FORMER, JSON.stringify({ mode: 4, name: 'Full access' }, null, 2) + '\n', 'utf8')

    const adopted = s.execute({})
    const gotAdopted = adopted && adopted.current ? adopted.current.id : null
    const preserved = gotAdopted === 4
    if (!preserved) failures += 1
    console.log((preserved ? 'PASS' : 'FAIL') + ' | the former name is adopted, preserving the chosen mode (got ' + gotAdopted + ', expected 4)')

    // It must be CONSUMED: a lingering second copy is the dormant-escalation shape.
    const currentExists = fs.existsSync(STATE_FILE)
      && JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).mode === 4
    if (!currentExists) failures += 1
    console.log((currentExists ? 'PASS' : 'FAIL') + ' | the mode was written to the current name')

    const consumed = !fs.existsSync(FORMER)
    if (!consumed) failures += 1
    console.log((consumed ? 'PASS' : 'FAIL') + ' | the former name is DELETED, so the handover cannot fire twice')

    // Single-shot: the handover consumed the old file, so running again with the current
    // file also absent must fall all the way to the fail-safe DEFAULT. Without the deletion
    // this would keep reading the former file, which is how a stale value stays a live source.
    fs.unlinkSync(STATE_FILE)
    const second = s.execute({})
    const gotSecond = second && second.current ? second.current.id : null
    const singleShot = gotSecond === modes.DEFAULT_MODE_ID
    if (!singleShot) failures += 1
    console.log((singleShot ? 'PASS' : 'FAIL') + ' | the handover runs at most once; a consumed former file cannot be re-read (got '
      + gotSecond + ', expected ' + modes.DEFAULT_MODE_ID + ')')
  } finally {
    if (savedState !== null) fs.writeFileSync(STATE_FILE, savedState)
    if (savedFormer !== null) fs.writeFileSync(FORMER, savedFormer)
    else if (fs.existsSync(FORMER)) fs.unlinkSync(FORMER)
  }
}

console.log('--- denial messages carry the offending path ---')
{
  const set = registeredTools.find(function (t) { return t.name === 'permission_mode' })
  set.execute({ mode: 1 })
  const diagnostic = run('read', { file_path: OUT })
  // The plugin normalizes separators to '/', so compare on the normalized form.
  const normalizedOut = OUT.replace(/\\/g, '/').toLowerCase()
  const normalizedReason = typeof diagnostic.reason === 'string' ? diagnostic.reason.toLowerCase() : ''
  const namesPath = diagnostic.denied && normalizedReason.indexOf(normalizedOut) !== -1
  if (!namesPath) failures += 1
  console.log((namesPath ? 'PASS' : 'FAIL') + ' | denial names the offending path')
  const status = set.execute({})
  const ok = status && status.current && status.current.id === 1
  if (!ok) failures += 1
  console.log((ok ? 'PASS' : 'FAIL') + ' | status.current survives the execute boundary (id=' + (status && status.current ? status.current.id : 'undefined') + ')')

  // The ring buffer is the only audit surface when the durable sink is
  // unavailable, so a denial must land there WITH its reason. An earlier version
  // omitted the field and recorded undefined.
  const lastDenial = status && status.recentDenials && status.recentDenials.length
    ? status.recentDenials[status.recentDenials.length - 1]
    : undefined
  const ringOk = lastDenial && typeof lastDenial.reason === 'string' && lastDenial.reason !== ''
    && typeof lastDenial.path === 'string'
  if (!ringOk) failures += 1
  console.log((ringOk ? 'PASS' : 'FAIL') + ' | ring-buffer denial keeps its reason and path')
}

console.log('--- mode state file is not agent-writable (self-escalation) ---')
{
  const set = registeredTools.find(function (t) { return t.name === 'permission_mode' })
  set.execute({ mode: 1 })
  const direct = run('write', { file_path: STATE_FILE, content: '{"mode":4}' })
  const viaEdit = run('edit', { file_path: STATE_FILE, old_string: 'a', new_string: 'b' })
  const viaShell = run('pwsh', { command: 'Set-Content "' + STATE_FILE + '" -Value "{\\"mode\\":4}"' })
  const all = direct.denied && viaEdit.denied && viaShell.denied
  if (!all) failures += 1
  console.log((all ? 'PASS' : 'FAIL') + ' | write/edit/shell to the mode file are all denied'
    + ' (write=' + direct.denied + ' edit=' + viaEdit.denied + ' shell=' + viaShell.denied + ')')
  const stillOne = currentOnDisk() === 1
  if (!stillOne) failures += 1
  console.log((stillOne ? 'PASS' : 'FAIL') + ' | the mode file was not modified')
}

console.log('--- live mode reads (no stale cache) ---')
{
  const set = registeredTools.find(function (t) { return t.name === 'permission_mode' })
  set.execute({ mode: 1 })
  const first = run('read', { file_path: 'C:\\outside\\x.txt' }).denied
  set.execute({ mode: 3 })
  const second = run('read', { file_path: 'C:\\outside\\x.txt' }).denied
  const flipped = first === true && second === false
  if (!flipped) failures += 1
  console.log((flipped ? 'PASS' : 'FAIL') + ' | switching mode takes effect on the very next check (no reload)')
}

// A projection-based selector integration was attempted and reverted: registering
// the `permissions` key at a different stateVersion makes the upstream
// `dsh-permission-presets` entry fail to load and takes the whole plugin tree down.
// The assertions below pin that decision by asserting the plugin does NOT register
// the key.
console.log('--- no projection takeover (regression guard) ---')
{
  const took = registeredProjections.length > 0
  if (took) failures += 1
  console.log((took ? 'FAIL' : 'PASS') + ' | the plugin does not register the "permissions" projection key'
    + (took ? ' (would break boot: stateVersion conflict with dsh-permission-presets)' : ''))
}

// A /permission command shadow was attempted and reverted: it only rewrote this
// plugin's mode file without calling permissionPresets.set(), so it could report
// "full access" while the DSH kernel sandbox still confined writes. The assertion
// below pins that decision.
console.log('--- no /permission command shadow (regression guard) ---')
{
  const shadowed = registeredCommands.length > 0
  if (shadowed) failures += 1
  console.log((shadowed ? 'FAIL' : 'PASS') + ' | the plugin does not shadow the /permission command'
    + (shadowed ? ' (it would not move the kernel knobs, so it could lie about the active mode)' : ''))
}

// A per-package client RPC (`harness.handle` + client `host.call`) was attempted and
// reverted. `harness` is a DYNAMIC-plugin builtin and a profile plugin has no binding
// for it, so the call threw ReferenceError at apply() and failed the loader entry -
// a boot failure. The seam a profile plugin should use instead has not been
// identified, so the client half is currently display-only and this guard pins the
// decision until that seam is known.
console.log('--- no dynamic-only builtin RPC (regression guard) ---')
{
  const used = handlers.size > 0
  if (used) failures += 1
  console.log((used ? 'FAIL' : 'PASS') + ' | the plugin registers no harness.handle RPC'
    + (used ? ' (harness is dynamic-only; this breaks boot)' : ''))
}

console.log('--- read-only mode route (client indicator) ---')
{
  const route = registeredRoutes[0]
  if (route === undefined) {
    failures += 1
    console.log('FAIL | the mode route is registered')
  } else {
    console.log('PASS | mode route registered at ' + route.path + ' (kind=' + route.kind + ')')
    const isExactGetPath = route.kind === 'exact' && route.path === '/permission-guard/mode'
    if (!isExactGetPath) failures += 1
    console.log((isExactGetPath ? 'PASS' : 'FAIL') + ' | route is exact /permission-guard/mode')

    function callRoute(method) {
      const captured = { statusCode: null, headers: {}, body: null }
      const req = { method: method }
      const res = {
        set statusCode(v) { captured.statusCode = v },
        get statusCode() { return captured.statusCode },
        setHeader: function (k, v) { captured.headers[k] = v },
        end: function (body) { captured.body = body },
      }
      route.handler(req, res)
      return captured
    }

    const set = registeredTools.find(function (t) { return t.name === 'permission_mode' })
    set.execute({ mode: 2 })
    const ok = callRoute('GET')
    let parsed = null
    try { parsed = JSON.parse(ok.body) } catch (error) { parsed = null }
    const serves = ok.statusCode === 200 && parsed !== null && parsed.id === 2
    if (!serves) failures += 1
    console.log((serves ? 'PASS' : 'FAIL') + ' | GET returns the live mode as JSON (id=' + (parsed && parsed.id) + ', status=' + ok.statusCode + ')')

    const noStore = ok.headers['cache-control'] === 'no-store'
    if (!noStore) failures += 1
    console.log((noStore ? 'PASS' : 'FAIL') + ' | GET is not cacheable')

    // The write direction is deliberately absent: a POST route would be reachable by
    // the agent's own shell, reopening the self-escalation hole fenceSelfWrite closes.
    const post = callRoute('POST')
    const rejectsWrite = post.statusCode === 405
    if (!rejectsWrite) failures += 1
    console.log((rejectsWrite ? 'PASS' : 'FAIL') + ' | POST is refused with 405 (no write route)')
  }
}

console.log('--- old <-> new sync ---')
{
  const modeBefore = currentOnDisk()
  const set = registeredTools.find(function (t) { return t.name === 'permission_mode' })

  // Fixture: two live sessions, one of them with a live agent (approval.setPolicy
  // needs an agent, and its absence must not break the sandbox half).
  liveSessions.length = 0
  const appended = []
  function makeSession(id) {
    return {
      id: id,
      _events: [],
      append: function (type, data) { appended.push({ id: id, type: type, data: data }); this._events.push({ type: type, data: data }) },
      snapshotEvents: function () { return this._events.slice() },
    }
  }
  liveSessions.push(makeSession('s1'), makeSession('s2'))
  liveAgents['s1'] = { id: 's1' }

  // 1. Mapping table matches the operator's specification.
  const mapOk = sync.OLD_TO_NEW['read-only'] === 1
    && sync.OLD_TO_NEW['workspace-write'] === 2
    && sync.OLD_TO_NEW['danger-full-access'] === 4
    && sync.NEW_TO_OLD_SANDBOX[1] === 'read-only'
    && sync.NEW_TO_OLD_SANDBOX[2] === 'workspace-write'
    && sync.NEW_TO_OLD_SANDBOX[3] === 'workspace-write'
    && sync.NEW_TO_OLD_SANDBOX[4] === 'danger-full-access'
    && sync.NEW_TO_OLD_APPROVAL[3] === 'ask'
    && sync.NEW_TO_OLD_APPROVAL[4] === 'never'
  if (!mapOk) failures += 1
  console.log((mapOk ? 'PASS' : 'FAIL') + ' | mapping matches the spec')

  // 1b. THE KERNEL MUST NEVER BE LOOSER THAN THE MODE.
  //
  // `workspace-write` fences modifications only; reads are unconfined in every
  // kernel mode (the bundled fs sandbox documents "reads pass through untouched",
  // and it is observable: reading outside the workspace succeeds while the policy
  // is workspace-write). So "outside readable" needs NO kernel help, and new 3 must
  // NOT map to danger-full-access — that made the kernel permit outside WRITES while
  // the mode claimed to deny them, which is why the built-in selector showed
  // 完全权限 for 非工作区可读.
  //
  // Invariant: for every mode, the kernel write permission must be a SUBSET of the
  // mode's write permission. Only mode 4 may reach danger-full-access.
  const kernelGrantsOutsideWrite = function (sandbox) { return sandbox === 'danger-full-access' }
  const kernelGrantsWorkspaceWrite = function (sandbox) { return sandbox !== 'read-only' }
  let loose = []
  for (let i = 0; i < 4; i++) {
    const id = i + 1
    const m = modes.modeById(id)
    const sandbox = sync.NEW_TO_OLD_SANDBOX[id]
    if (kernelGrantsOutsideWrite(sandbox) && m['outside-write'] !== true) loose.push('mode ' + id + ' -> ' + sandbox)
    if (kernelGrantsWorkspaceWrite(sandbox) && m.workspaceWrite !== true) loose.push('mode ' + id + ' -> ' + sandbox)
  }
  const tight = loose.length === 0
  if (!tight) failures += 1
  console.log((tight ? 'PASS' : 'FAIL') + ' | the kernel is never LOOSER than the mode'
    + (tight ? '' : ' | too permissive: ' + loose.join(', ')))

  const onlyFourIsFull = sync.NEW_TO_OLD_SANDBOX[4] === 'danger-full-access'
    && sync.NEW_TO_OLD_SANDBOX[1] !== 'danger-full-access'
    && sync.NEW_TO_OLD_SANDBOX[2] !== 'danger-full-access'
    && sync.NEW_TO_OLD_SANDBOX[3] !== 'danger-full-access'
  if (!onlyFourIsFull) failures += 1
  console.log((onlyFourIsFull ? 'PASS' : 'FAIL') + ' | only mode 4 unlocks outside writes in the kernel')

  // 2. The upstream PIN must not be mistaken for an operator change.
  //
  // Regression for a reported bug: the operator set the mode to 4 and it silently
  // became 2. Cause: upstream pins every new session with
  //   ctx.on('session/created', s => this.pinInitialPermission(s))
  // which appends `sandbox/mode = ctx.shell.sandboxMode` — the DEPLOYMENT default
  // (workspace-write -> new 2). The sync treated that initialization as an operator
  // action and overwrote the hand-set value.
  set.execute({ mode: 4 })
  const fresh = makeSession('fresh-session')
  liveSessions.push(fresh)
  const pinBefore = currentOnDisk()
  sessionEventListeners[0](fresh, { type: 'sandbox/mode', data: { mode: 'workspace-write' } })
  const pinKept = currentOnDisk() === pinBefore && pinBefore === 4
  if (!pinKept) failures += 1
  console.log((pinKept ? 'PASS' : 'FAIL') + ' | a session\'s FIRST sandbox/mode event (the pin) does NOT overwrite the mode'
    + ' (stayed ' + currentOnDisk() + ', expected 4)')

  // 3. old -> new: a LATER sandbox/mode event on that session IS an operator change.
  const listenerCount = sessionEventListeners.length
  if (listenerCount === 0) { failures += 1; console.log('FAIL | session/event listener registered') } else {
    console.log('PASS | session/event listener registered (' + listenerCount + ')')
    sessionEventListeners[0](fresh, { type: 'sandbox/mode', data: { mode: 'read-only' } })
    const becameOne = currentOnDisk() === 1
    if (!becameOne) failures += 1
    console.log((becameOne ? 'PASS' : 'FAIL') + ' | a LATER old=read-only moves new to 1 (got ' + currentOnDisk() + ')')

    sessionEventListeners[0](fresh, { type: 'sandbox/mode', data: { mode: 'danger-full-access' } })
    const becameFour = currentOnDisk() === 4
    if (!becameFour) failures += 1
    console.log((becameFour ? 'PASS' : 'FAIL') + ' | old=danger-full-access moved new to 4 (got ' + currentOnDisk() + ')')

    sessionEventListeners[0](fresh, { type: 'sandbox/mode', data: { mode: 'workspace-write' } })
    const becameTwo = currentOnDisk() === 2
    if (!becameTwo) failures += 1
    console.log((becameTwo ? 'PASS' : 'FAIL') + ' | old=workspace-write moved new to 2 (got ' + currentOnDisk() + ')')

    // Unknown values must be ignored, not crash.
    sessionEventListeners[0](liveSessions[0], { type: 'sandbox/mode', data: { mode: 'nonsense' } })
    const survived = currentOnDisk() === 2
    if (!survived) failures += 1
    console.log((survived ? 'PASS' : 'FAIL') + ' | an unknown old mode is ignored')
  }

  // 4. new -> old: switching writes every live session and the agent's policy.
  for (let i = 0; i < liveSessions.length; i++) liveSessions[i]._events.length = 0
  policyWrites.length = 0
  appended.length = 0
  set.execute({ mode: 3 })
  const writes = appended.filter(function (a) { return a.type === 'sandbox/mode' })
  // Derive the expected value FROM THE MAPPING TABLE rather than repeating a literal.
  // A hard-coded 'danger-full-access' here went stale the moment new 3 was corrected
  // to map to workspace-write, and the resulting failure looked like a product bug —
  // the same "expired literal" trap as the earlier session-count assertion.
  const expected3 = sync.NEW_TO_OLD_SANDBOX[3]
  const wroteAll = writes.length === liveSessions.length
    && writes.every(function (w) { return w.data.mode === expected3 })
  if (!wroteAll) failures += 1
  console.log((wroteAll ? 'PASS' : 'FAIL') + ' | new=3 wrote sandbox/mode to every live session ('
    + writes.length + '/' + liveSessions.length + ', value=' + expected3 + ')')

  const askedPolicy = policyWrites.length === 1 && policyWrites[0].policy === 'ask' && policyWrites[0].agent.id === 's1'
  if (!askedPolicy) failures += 1
  console.log((askedPolicy ? 'PASS' : 'FAIL') + ' | new=3 set approval "ask" on the live agent (got ' + JSON.stringify(policyWrites) + ')')

  // 4. new=4 is the ONLY mode that unlocks outside writes in the kernel, and it
  //    differs from new=3 by the approval policy.
  liveSessions[0]._events.length = 0
  liveSessions[1]._events.length = 0
  policyWrites.length = 0
  appended.length = 0
  set.execute({ mode: 4 })
  const never = policyWrites.length === 1 && policyWrites[0].policy === 'never'
  if (!never) failures += 1
  console.log((never ? 'PASS' : 'FAIL') + ' | new=4 set approval "never" (got ' + JSON.stringify(policyWrites) + ')')

  const expected4 = sync.NEW_TO_OLD_SANDBOX[4]
  const writes4 = appended.filter(function (a) { return a.type === 'sandbox/mode' })
  const fullOnly = expected4 === 'danger-full-access'
    && writes4.length === liveSessions.length
    && writes4.every(function (w) { return w.data.mode === 'danger-full-access' })
  if (!fullOnly) failures += 1
  console.log((fullOnly ? 'PASS' : 'FAIL') + ' | new=4 is the only mode that reaches danger-full-access ('
    + expected4 + ', ' + writes4.length + '/' + liveSessions.length + ')')

  // 5. Loop safety: our own writes must not be echoed back as a new mode.
  const beforeEcho = sync.stats.skippedEcho
  const modeNow = currentOnDisk()
  sessionEventListeners[0](liveSessions[0], { type: 'sandbox/mode', data: { mode: 'danger-full-access' } })
  // In apply-scope the listener must ignore it entirely.
  sync.apply(function () {
    sessionEventListeners[0](liveSessions[0], { type: 'sandbox/mode', data: { mode: 'read-only' } })
  })
  const noEcho = currentOnDisk() === modeNow && sync.stats.skippedEcho > beforeEcho
  if (!noEcho) failures += 1
  console.log((noEcho ? 'PASS' : 'FAIL') + ' | an event observed inside apply-scope is ignored (echo suppressed)')

  // 6. A session created later starts from the composition default; the status
  //    report must say so rather than implying full coverage.
  const status = set.execute({})
  const honest = status.sync && status.sync.armed === true
    && typeof status.sync.note === 'string' && status.sync.note.indexOf('live') !== -1
  if (!honest) failures += 1
  console.log((honest ? 'PASS' : 'FAIL') + ' | status reports the sync is armed and states its coverage limit')

  // 7. Read-only tools may name the mode file; mutating ones may not.
  const stateAsPosix = STATE_FILE.replace(/\\/g, '/')
  const canRead = run('read', { file_path: stateAsPosix }).denied === false
  if (!canRead) failures += 1
  console.log((canRead ? 'PASS' : 'FAIL') + ' | read of the mode file is ALLOWED (the fence no longer over-blocks)')

  const readOnlyShell = run('pwsh', { command: 'Get-Content "' + STATE_FILE + '"' }).denied === false
  if (!readOnlyShell) failures += 1
  console.log((readOnlyShell ? 'PASS' : 'FAIL') + ' | a read-only shell command naming it is ALLOWED')

  const mutateShell = run('pwsh', { command: 'Set-Content "' + STATE_FILE + '" -Value x' }).denied === true
  if (!mutateShell) failures += 1
  console.log((mutateShell ? 'PASS' : 'FAIL') + ' | a mutating shell command targeting it is DENIED')

  // 8. Every name the state file has ever had is protected, in every directory.
  //
  //    Two real regressions are pinned here. First: when the file moved into the plugin
  //    directory, `isStateFile` was an exact comparison against the new path, so writes to
  //    the old location were silently accepted while the guard was live. Second: the file
  //    was then RENAMED, and fencing only the current name would have made the former name
  //    writable at exactly the moment the rename handover started reading it as a legitimate
  //    source. Both are the same mistake — a rename narrowing the guard — so both are
  //    asserted on the `write`/`edit` tool path, not only through the shell.
  const formerName = path.join('D:\\DeepSeek Harness', STATE_FILE_ZH)
  const newNameElsewhere = path.join('D:\\DeepSeek Harness\\sub', 'permissions.json')
  const toolCases = [
    ['write to the CURRENT state file via the write tool', 'write', { file_path: STATE_FILE, content: 'x' }, true],
    ['edit to the CURRENT state file via the edit tool', 'edit', { file_path: STATE_FILE, old_string: 'a', new_string: 'b' }, true],
    ['write to the FORMER name in another directory via the write tool', 'write', { file_path: formerName, content: 'x' }, true],
    ['edit to the FORMER name in another directory via the edit tool', 'edit', { file_path: formerName, old_string: 'a', new_string: 'b' }, true],
    ['write to the CURRENT name in another directory via the write tool', 'write', { file_path: newNameElsewhere, content: 'x' }, true],
    ['write to an unrelated path (must NOT be denied)', 'write', { file_path: IN, content: 'x' }, false],
  ]
  for (let i = 0; i < toolCases.length; i++) {
    const label = toolCases[i][0]
    const tool = toolCases[i][1]
    const args = toolCases[i][2]
    const shouldDeny = toolCases[i][3]
    const got = run(tool, args).denied
    const ok = got === shouldDeny
    if (!ok) failures += 1
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' -> ' + (shouldDeny ? 'DENIED' : 'ALLOWED')
      + (ok ? '' : ' (got ' + (got ? 'DENIED' : 'ALLOWED') + ')'))
  }

  // 9. Script-language file APIs (the observed blind spot).
  //
  //    The move of this very file was done with fs.renameSync inside `node -e`, which
  //    the cmdlet-only verb list did not match, so the fence never ran. These cases
  //    pin the fix and, equally importantly, pin that it did not become a blanket
  //    ban on running scripts or on moving unrelated files.
  const posix = STATE_FILE.replace(/\\/g, '/')
  const scriptCases = [
    ['fs.renameSync moving the state file', 'node -e "require(\'fs\').renameSync(\'' + posix + '\', \'D:/x.json\')"', true],
    ['fs.writeFileSync rewriting the state file', 'node -e "require(\'fs\').writeFileSync(\'' + posix + '\', \'{\\"mode\\":4}\')"', true],
    ['fs.unlinkSync deleting the state file', 'node -e "require(\'fs\').unlinkSync(\'' + posix + '\')"', true],
    ['python shutil.move moving the state file', 'python -c "import shutil; shutil.move(\'' + posix + '\', \'D:/x.json\')"', true],
    ['fs.renameSync on an unrelated file (must NOT be denied)', 'node -e "require(\'fs\').renameSync(\'D:/DeepSeek Harness/a.png\', \'D:/DeepSeek Harness/b.png\')"', false],
    ['a read-only script naming the state file (must NOT be denied)', 'node -e "console.log(require(\'fs\').readFileSync(\'' + posix + '\',\'utf8\'))"', false],
  ]
  for (let i = 0; i < scriptCases.length; i++) {
    const label = scriptCases[i][0]
    const command = scriptCases[i][1]
    const shouldDeny = scriptCases[i][2]
    const got = run('pwsh', { command: command }).denied
    const ok = got === shouldDeny
    if (!ok) failures += 1
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' -> ' + (shouldDeny ? 'DENIED' : 'ALLOWED')
      + (ok ? '' : ' (got ' + (got ? 'DENIED' : 'ALLOWED') + ')'))
  }

  // Left as-is on purpose: `process.on('exit', restoreStateFile)` puts the
  // operator's original mode back, so this suite does not decide it.
}

/**
 * Restore the operator's real state file.
 *
 * The suites switch modes constantly, and an earlier version finished with a
 * hard-coded `permission_mode { mode: 2 }` (whatever the last sub-suite happened to
 * want). Running the tests therefore OVERWROTE a live mode 4 with 2 — the tests were
 * silently changing the deployment's permissions. Restore from the snapshot taken at
 * startup, and do it on exit so a mid-suite crash cannot leave a stray mode either.
 */
function restoreStateFile() {
  try {
    if (originalState !== null) fs.writeFileSync(STATE_FILE, originalState)
    else if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE)
  } catch (error) {
    console.error('[test-matrix] could not restore state file:', String(error))
  }
}
process.on('exit', restoreStateFile)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES')
process.exitCode = failures === 0 ? 0 : 1
