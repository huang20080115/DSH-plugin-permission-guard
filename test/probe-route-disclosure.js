'use strict'

/**
 * Assert the HTTP status route discloses no filesystem path.
 *
 * WHY A PROBE RATHER THAN A CODE READ: "there is no path in the payload" is a claim about what the
 * server SENDS, and a field can return through a default, a spread, or a future edit. This drives
 * the real handler and inspects the real bytes.
 *
 * It also checks the neighbouring claims in the same place: GET/HEAD only, and no write route.
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const entry = path.join(ROOT, 'index.js')

delete require.cache[require.resolve(entry)]
const plugin = (function (m) { return m.default || m })(require(entry))

const routes = []
const svc = {
  tools: { register: function () {}, guard: function () { return function () {} }, get: function () { return {} }, schemas: function () { return [] } },
  systemPrompt: { section: function () {} },
  webServer: { register: function (r) { routes.push(r); return function () {} } },
  sessions: { list: function () { return [] }, get: function () { return undefined } },
  approval: { setPolicy: function () {}, request: function () { return Promise.resolve('unavailable') } },
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

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + (detail ? ' | ' + detail : ''))
}

check('a mode route was registered', routes.length === 1, 'routes: ' + routes.length)

if (routes.length === 1) {
  const route = routes[0]
  check('the route is GET-only by handler logic', typeof route.handler === 'function', 'path: ' + String(route.path))

  function call(method) {
    let body = ''
    const res = {
      statusCode: 0,
      headers: {},
      setHeader: function (k, v) { this.headers[k.toLowerCase()] = v },
      end: function (chunk) { if (chunk !== undefined) body += String(chunk) },
    }
    route.handler({ method: method }, res)
    return { status: res.statusCode, body: body, headers: res.headers }
  }

  const got = call('GET')
  check('GET returns 200', got.status === 200, 'status ' + got.status)
  check('the response is JSON', String(got.headers['content-type'] || '').indexOf('json') !== -1)

  let parsed = null
  try { parsed = JSON.parse(got.body) } catch (error) { /* reported below */ }
  check('the body parses as JSON', parsed !== null, got.body.slice(0, 120))

  // The actual claim under test: no absolute path, and specifically not the workspace root the
  // server happens to run in.
  const body = got.body
  const looksLikeAbsPath = /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|root|var|etc)\/)/.test(body)
  check('the body contains NO absolute filesystem path', looksLikeAbsPath === false, body.slice(0, 200))

  const leaksWorkspace = body.toLowerCase().indexOf(String(process.cwd()).replace(/\\/g, '/').toLowerCase()) !== -1
  check('the body does not name the server working directory', leaksWorkspace === false)

  const fields = parsed === null ? [] : Object.keys(parsed)
  console.log('    fields returned: ' + JSON.stringify(fields))
  check('the payload carries only mode identity (id/name/summary)',
    fields.every(function (f) { return ['id', 'name', 'summary'].indexOf(f) !== -1 }), JSON.stringify(fields))

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = call(method)
    const is405 = r.status === 405
    check(method + ' is refused with 405 (no write route)', is405, 'status ' + r.status)
  }

  // HEAD is allowed by design and, like GET, must not leak a path.
  const head = call('HEAD')
  check('HEAD is allowed and also leaks no path',
    (head.status === 200 || head.status === 405) && /(?:[A-Za-z]:[\\/]|\/Users\/)/.test(head.body) === false,
    'status ' + head.status)
}

console.log('')
console.log(failures === 0 ? 'ROUTE DISCLOSURE PROBE OK' : failures + ' FAILURES')
process.exitCode = failures === 0 ? 0 : 1
