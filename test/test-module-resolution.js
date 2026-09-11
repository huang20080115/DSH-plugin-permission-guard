'use strict'

/**
 * Host-side module-resolution check.
 *
 * The cordis loader resolves each entry with a real dynamic `import()` of a
 * file:// URL built from the entry's absolute path. A plain `require()` does NOT
 * exercise the same resolver, which is how an `exports` map in package.json slipped
 * through: every test passed, and the real load then failed with
 *
 *   ERR_MODULE_NOT_FOUND: Cannot find module '...\index.js'
 *
 * even though the file existed. So this check mirrors the loader instead of
 * approximating it: it imports the module by absolute file URL, exactly as the
 * loader does.
 *
 * Run standalone: `node test-module-resolution.js`
 */

const fs = require('node:fs')
const path = require('node:path')
const url = require('node:url')

let failures = 0
// The package root, which is this file's parent: the suite lives in `test/` so one `files` entry
// can publish it while excluding it from the package.
const dir = path.join(__dirname, '..')
const indexPath = path.join(dir, 'index.js')
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))

console.log('--- package manifest shape ---')
// The `exports` map IS required here: the host composes a client bundle for any
// package declaring `dsh.client`, and without `exports["./client"]` it fails with
//   "declares dsh.client but exports no \"./client\" bundle"
// An earlier ERR_MODULE_NOT_FOUND was misattributed to this map and the map was
// removed; that broke composition. The real cause was an over-nested install.
const clientExport = pkg.exports && pkg.exports['./client'] ? pkg.exports['./client'].default : undefined
const exportOk = clientExport === './client.js'
if (!exportOk) failures += 1
console.log((exportOk ? 'PASS' : 'FAIL') + ' | exports["./client"] points at ./client.js')
console.log('     name=' + pkg.name + ' main=' + pkg.main + ' type=' + pkg.type)

async function main() {
  console.log('\n--- dynamic import by absolute file URL (what the loader does) ---')
  const href = url.pathToFileURL(indexPath).href
  let moduleExports = null
  let importError = null
  try {
    moduleExports = await import(href)
  } catch (error) {
    importError = error
  }
  const imported = importError === null
  if (!imported) failures += 1
  console.log((imported ? 'PASS' : 'FAIL') + ' | import(' + href.replace(/^file:\/\/\//, '') + ')'
    + (importError ? ' | threw ' + (importError.code || '') + ': ' + importError.message : ''))

  if (imported) {
    const plugin = moduleExports.default ?? moduleExports
    const shapeOk = plugin !== null && typeof plugin === 'object' && typeof plugin.apply === 'function'
    if (!shapeOk) failures += 1
    console.log((shapeOk ? 'PASS' : 'FAIL') + ' | the unwrapped default export exposes apply()')
  }

  console.log('\n--- client bundle must exist where dsh.client points ---')
  const clientPath = path.join(dir, 'client.js')
  const clientExists = fs.existsSync(clientPath)
  if (!clientExists) failures += 1
  console.log((clientExists ? 'PASS' : 'FAIL') + ' | client.js is present beside index.js')

  console.log(failures === 0 ? 'MODULE RESOLUTION OK' : failures + ' MODULE-RESOLUTION FAILURES')
  process.exitCode = failures === 0 ? 0 : 1
}

main()
