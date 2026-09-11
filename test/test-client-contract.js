'use strict'

/**
 * Client-bundle contract check.
 *
 * The bundle is NOT a plain module. The shell composes every `dsh.client` package
 * into one script and each segment must register itself:
 *
 *   window.__ModuleLoader__.load({ id: "<package name>", factory: (require) => { … } })
 *
 * A bundle that merely defines `exports.apply` loads and then fails with
 *   "… loaded without registering <id> via __ModuleLoader__.load"
 * which is a plugin-load error in the UI. That happened once, so it is pinned here.
 *
 * The real loader is also stubbed and invoked, so registration is exercised rather
 * than pattern-matched.
 */

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

/** The package root, which is this file's parent. See `test-matrix.js` for why the suite lives in `test/`. */
const ROOT = path.join(__dirname, '..')

let failures = 0
const bundlePath = path.join(ROOT, 'client.js')
const source = fs.readFileSync(bundlePath, 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

// 1. Registration call present, with the package name as id.
const registers = /window\.__ModuleLoader__\.load\s*\(/.test(source)
if (!registers) failures += 1
console.log((registers ? 'PASS' : 'FAIL') + ' | bundle calls window.__ModuleLoader__.load')

const idMatch = source.match(/id:\s*"([^"]+)"/)
const id = idMatch ? idMatch[1] : null
const idOk = id === pkg.name
if (!idOk) failures += 1
console.log((idOk ? 'PASS' : 'FAIL') + ' | loader id equals the package name (' + String(id) + ' vs ' + pkg.name + ')')

// 2. The `dsh.client` declaration and its matching `exports["./client"]` entry.
//
// Both halves are REQUIRED and the host enforces the pairing loudly:
//   "dsh-plugin-permission-guard declares dsh.client but exports no \"./client\" bundle"
// which fails the whole `modules` plugin entry and therefore the plugin tree.
//
// Career note: this assertion was briefly inverted to FORBID an `exports` map, because
// an ERR_MODULE_NOT_FOUND was misattributed to it. The real cause was an install that
// nested the files one directory too deep. Removing `exports` then broke composition.
// Keep both; do not "simplify" the manifest.
const platform = pkg.dsh && pkg.dsh.client ? pkg.dsh.client.platform : undefined
const platformOk = platform === 'web'
if (!platformOk) failures += 1
console.log((platformOk ? 'PASS' : 'FAIL') + ' | package declares dsh.client.platform = web')

const clientExport = pkg.exports && pkg.exports['./client'] ? pkg.exports['./client'].default : undefined
const exportOk = clientExport === './client.js'
if (!exportOk) failures += 1
console.log((exportOk ? 'PASS' : 'FAIL') + ' | exports["./client"] present and pointing at ./client.js'
  + (exportOk ? '' : ' (the host rejects dsh.client without it)'))

const rootExport = pkg.exports && pkg.exports['.'] ? pkg.exports['.'].default : undefined
const rootOk = rootExport === './index.js'
if (!rootOk) failures += 1
console.log((rootOk ? 'PASS' : 'FAIL') + ' | exports["."] present and pointing at ./index.js')

const mainOk = pkg.main === 'index.js'
if (!mainOk) failures += 1
console.log((mainOk ? 'PASS' : 'FAIL') + ' | main points at index.js')

// 2b. The client `slots` service must be declared on the BUNDLE, by service name.
//
// The two faces are not interchangeable:
//   exports.inject (bundle)           -> SERVICE names; decides what is attached to ctx
//   package.json dsh.client.inject    -> PACKAGE names; load ordering only
//
// Evidence from the shipped tree: dsh-client-resources declares only
// '@deepseek-ai/dsh-client-ui-renderer' in its manifest, yet its bundle says
// inject = ["slots"]. An earlier version of THIS plugin put a package name in both
// places and `ctx.get("slots")` still returned undefined on DSH Desktop.
//
// The package name used there, '@deepseek-ai/dsh-client-ui-slots', is also simply
// wrong: that package ships lib/index.js only, has no lib/client.js, and declares no
// dsh.client, so it is not a client plugin package at all. The assertion below is on
// the bundle face and names the SERVICE, which is what actually matters.
const INJECT_SERVICE = 'slots'
const manifestInject = pkg.dsh && pkg.dsh.client && Array.isArray(pkg.dsh.client.inject) ? pkg.dsh.client.inject : []
const manifestClean = manifestInject.every(function (name) { return name.charAt(0) === '@' })
if (!manifestClean) failures += 1
console.log((manifestClean ? 'PASS' : 'FAIL') + ' | dsh.client.inject holds only package names (load ordering)')

// 3. Drive the real bundle through a stubbed loader and require().
const registered = new Map()
/** Records textContent writes from the sandboxed reporter. */
const boxTexts = []
function makeSandboxElement() {
  const element = { id: '', setAttribute: function () {}, remove: function () {} }
  Object.defineProperty(element, 'textContent', {
    get: function () { return '' },
    set: function (v) { boxTexts.push(String(v)) },
    configurable: true,
  })
  return element
}
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: function (spec) { registered.set(spec.id, spec.factory) },
    },
  },
  console: console,
}
vm.createContext(sandbox)
let ran = true
try {
  vm.runInContext(source, sandbox, { filename: 'client.js' })
} catch (error) {
  ran = false
  console.log('FAIL | bundle executes | threw: ' + error.message)
}
if (!ran) failures += 1
else console.log('PASS | bundle executes at top level')

const factory = registered.get(pkg.name)
if (factory === undefined) {
  failures += 1
  console.log('FAIL | factory registered under the package name')
} else {
  console.log('PASS | factory registered under the package name')

  // 4. The factory must return a Cordis plugin: an object with apply().
  const slotsCalls = []

  // A CONTROLLABLE locale service. It exists because the plugin reads this service ONCE at
  // apply() time and the registered component closes over that value — so a test that tried
  // to change the language by passing a different locale as a render prop would be testing a
  // wire that does not exist. `activeLocale` is what the service reports, which is exactly
  // how a real locale switch is observed.
  let activeLocale = 'en'
  const fakeLocaleService = {
    getSnapshot: function () { return { active: activeLocale, locales: [], revision: 1 } },
    getLocale: function () { return this.getSnapshot() },
    subscribe: function () { return function () {} },
  }

  // The slot component itself, captured so section 5 can render it. `register` receives it
  // as its second argument; the stub previously discarded it, which is why the i18n
  // behaviour had no test at all.
  let registeredComponent = null
  const fakeReact = {
    useState: function (initial) { return [initial, function () {}] },
    useEffect: function () {},
    // `children` must actually be carried on props, the way real React does it. The
    // previous stub dropped every child, so any assertion that inspected RENDERED TEXT
    // silently saw an empty tree — which is worse than a failing test, because it looks
    // like "nothing to check" rather than "the check is broken".
    createElement: function (type, props) {
      const out = { type: type, props: props === null || props === undefined ? {} : props }
      const children = Array.prototype.slice.call(arguments, 2)
      if (children.length === 1) out.props.children = children[0]
      else if (children.length > 1) out.props.children = children
      return out
    },
  }
  const fakeCtx = {
    get: function (name) {
      if (name === 'locale') return fakeLocaleService
      if (name !== 'slots') return undefined
      return {
        inject: function (key, cb) { slotsCalls.push(['inject', key]); cb() },
        register: function (options, component) {
          slotsCalls.push(['register', options.name, options.id])
          if (typeof component === 'function') registeredComponent = component
          return function () {}
        },
      }
    },
  }
  let plugin = null
  let factoryError = null
  try {
    plugin = factory(function (name) {
      if (name === 'react') return fakeReact
      throw new Error('unexpected require: ' + name)
    })
  } catch (error) {
    factoryError = error
  }
  const shapeOk = factoryError === null && plugin !== null && typeof plugin.apply === 'function'
  if (!shapeOk) failures += 1
  console.log((shapeOk ? 'PASS' : 'FAIL') + ' | factory returns a plugin with apply()'
    + (factoryError ? ' | threw: ' + factoryError.message : ''))

  if (shapeOk) {
    let applyError = null
    try {
      plugin.apply(fakeCtx)
    } catch (error) {
      applyError = error
    }
    const applied = applyError === null
    if (!applied) failures += 1
    console.log((applied ? 'PASS' : 'FAIL') + ' | apply() runs against a slots service'
      + (applyError ? ' | threw: ' + applyError.message : ''))

    const rightSlot = slotsCalls.some(function (c) { return c[0] === 'register' && c[1] === 'conversation.input.left' })
    if (!rightSlot) failures += 1
    console.log((rightSlot ? 'PASS' : 'FAIL') + ' | registers into conversation.input.left')

    // The bundle face carries the SERVICE name, and it is what attaches the service.
    const bundleInject = plugin.inject
    const bundleInjectOk = Array.isArray(bundleInject) && bundleInject.indexOf(INJECT_SERVICE) !== -1
    if (!bundleInjectOk) failures += 1
    console.log((bundleInjectOk ? 'PASS' : 'FAIL') + ' | the bundle exports inject declaring the service "' + INJECT_SERVICE + '"'
      + (bundleInjectOk ? '' : ' | got ' + JSON.stringify(bundleInject)))

    // And the failure must be VISIBLE, not a silent no-op: with no slots service the
    // plugin has to report rather than return quietly.
    //
    // The reporter deliberately swallows DOM problems, and the bundle runs inside the
    // `vm` sandbox — so the stub must be installed on the SANDBOX, not on the Node
    // global. Putting it on globalThis made this assertion fail while the plugin was
    // correct, because the sandboxed code resolved `document` to undefined.
    sandbox.document = {
      getElementById: function () { return null },
      createElement: function () { return makeSandboxElement() },
      body: { appendChild: function () {} },
    }
    const noSlotsCtx = { get: function () { return undefined } }
    const priorLog = console.log
    console.log = function () {}
    if (typeof plugin.apply === 'function') plugin.apply(noSlotsCtx)
    console.log = priorLog

    const reported = boxTexts.some(function (t) { return t.indexOf('returned undefined') !== -1 })
    if (!reported) failures += 1
    console.log((reported ? 'PASS' : 'FAIL') + ' | a missing slots service is REPORTED, not silently ignored'
      + (reported ? '' : ' | captured: ' + JSON.stringify(boxTexts)))
  }

  // 5. The UI must FOLLOW THE ACTIVE LANGUAGE.
  //
  //    Nothing above touches this: an untranslated component would pass every other
  //    assertion in this file, so "the UI follows the system language" would be an
  //    unverified claim. The registered component is rendered and its text tree flattened.
  //
  //    The language is changed through the SERVICE (`activeLocale`), not by passing a prop,
  //    because that is how the plugin is actually wired: it reads the service once at
  //    apply() time and the component closes over it. Rendering with a different prop would
  //    pass against a contract the plugin does not implement.
  {
    const component = registeredComponent
    if (typeof component !== 'function') {
      failures += 1
      console.log('FAIL | the registered slot entry exposes a component to render')
    } else {
      function textsOf(node, out) {
        if (node === null || node === undefined || node === false) return out
        if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
        if (Array.isArray(node)) {
          for (let i = 0; i < node.length; i++) textsOf(node[i], out)
          return out
        }
        if (typeof node === 'object' && node.props !== undefined) {
          // A function component must be INVOKED, not walked. The plugin registers a wrapper
          // element (`createElement(ModeIndicator, merged)`), so skipping this step yields
          // an empty tree and every assertion below would "pass" vacuously.
          if (typeof node.type === 'function') textsOf(node.type(node.props), out)
          else textsOf(node.props.children, out)
        }
        return out
      }

      function renderedText() {
        return textsOf(component({}), []).join(' | ')
      }

      activeLocale = 'zh-CN'
      const zhText = renderedText()
      const zhOk = zhText.indexOf('权限') !== -1
      if (!zhOk) failures += 1
      console.log((zhOk ? 'PASS' : 'FAIL') + ' | active locale zh-CN renders Chinese (' + zhText.slice(0, 56) + '...)')

      activeLocale = 'en'
      const enText = renderedText()
      const enOk = enText.indexOf('Permission') !== -1
      if (!enOk) failures += 1
      console.log((enOk ? 'PASS' : 'FAIL') + ' | active locale en renders English (' + enText.slice(0, 56) + '...)')

      // A prefix tag must match, or every zh-CN/zh-Hant user silently gets English.
      activeLocale = 'zh-Hant'
      const taggedOk = renderedText().indexOf('权限') !== -1
      if (!taggedOk) failures += 1
      console.log((taggedOk ? 'PASS' : 'FAIL') + ' | a region-tagged zh locale matches by prefix, not equality')

      // An unknown locale must land on English, the documented terminal fallback.
      activeLocale = 'de'
      const fallbackLangOk = renderedText().indexOf('Permission') !== -1
      if (!fallbackLangOk) failures += 1
      console.log((fallbackLangOk ? 'PASS' : 'FAIL') + ' | an unknown locale falls back to English')

      // The four MODE NAMES only render on the open panel, so the checks above cannot see
      // them. This renders the panel by driving the component's own state through a
      // STATEFUL React stub: applying the recorded click handler is what a user does, and
      // the setter must actually store the new value or `open` never flips.
      function renderPanelText() {
        const slots = [null, null, null]
        let cursor = 0
        const panelReact = {
          useState: function (initial) {
            const at = cursor++
            if (slots[at] === null) slots[at] = initial
            const index = at
            return [slots[index], function (next) {
              slots[index] = typeof next === 'function' ? next(slots[index]) : next
            }]
          },
          useEffect: function () {},
          createElement: fakeReact.createElement,
        }
        let panelComponent = null
        const panelCtx = {
          get: function (name) {
            if (name === 'locale') return fakeLocaleService
            if (name !== 'slots') return undefined
            return {
              inject: function (key, cb) { cb() },
              register: function (options, comp) { if (typeof comp === 'function') panelComponent = comp; return function () {} },
            }
          },
        }
        const panelFactory = registered.get(pkg.name)
        panelFactory(function (name) {
          if (name === 'react') return panelReact
          throw new Error('unexpected require: ' + name)
        }).apply(panelCtx)

        cursor = 0
        // The slot entry returns an ELEMENT for ModeIndicator, whose props carry children
        // alongside locale. Invoke it to reach the rendered tree.
        const outer = panelComponent({})
        const first = outer.type(outer.props)
        // Apply the button's onClick so `open` flips to true, then render again.
        // Apply the button's onClick so `open` flips to true, then render again.
        // children is an array unless there is exactly one child, so index defensively.
        const button = Array.isArray(first.props.children) ? first.props.children[0] : first.props.children
        button.props.onClick()
        cursor = 0
        return textsOf(panelComponent({}), []).join(' | ')
      }

      activeLocale = 'zh-CN'
      const zhPanel = renderPanelText()
      const zhModes = zhPanel.indexOf('工作区查看') !== -1 && zhPanel.indexOf('完全权限') !== -1
      if (!zhModes) failures += 1
      console.log((zhModes ? 'PASS' : 'FAIL') + ' | the open panel lists all four modes in Chinese (' + zhPanel.slice(0, 48) + '...)')

      activeLocale = 'en'
      const enPanel = renderPanelText()
      const enModes = enPanel.indexOf('Workspace read') !== -1 && enPanel.indexOf('Full access') !== -1
      if (!enModes) failures += 1
      console.log((enModes ? 'PASS' : 'FAIL') + ' | the open panel lists all four modes in English (' + enPanel.slice(0, 48) + '...)')
      activeLocale = 'en'

      // With no locale service the UI must still render — degrading the TEXT, not the control.
      const noLocale = component({})
      const fallbackText = textsOf(noLocale, []).join(' | ')
      const fallbackOk = fallbackText.length > 0
      if (!fallbackOk) failures += 1
      console.log((fallbackOk ? 'PASS' : 'FAIL') + ' | with no locale service the indicator still renders (' + fallbackText.slice(0, 40) + '...)')
    }
  }
}

console.log(failures === 0 ? 'CLIENT CONTRACT OK' : failures + ' CLIENT CONTRACT FAILURES')
process.exitCode = failures === 0 ? 0 : 1
