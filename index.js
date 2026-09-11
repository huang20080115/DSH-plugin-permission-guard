'use strict'

/**
 * Tool-layer permission fence implementing the four modes in
 * D:\DeepSeek Harness\权限设置.txt.
 *
 * WHY THE TOOL LAYER. Upstream fences only WRITES, and its SandboxMode is a
 * closed three-value vocabulary (see ./modes.js). "非工作区不可读" has no upstream
 * mechanism, so this plugin adds one at `tools/pre-execute`.
 *
 * WHAT THIS IS NOT. This is a policy check over model-controlled arguments, not a
 * kernel boundary. It sees the file tools exactly and shell commands only by
 * best-effort path extraction, so a deliberately obfuscated `pwsh` command
 * (variable-built paths, encoded strings, script content loaded at run time) can
 * get a read past it. Kernel-grade isolation of untrusted code remains
 * `ctx.shell`'s job. This is the ceiling the deployment chose.
 */

const fs = require('node:fs')
const path = require('node:path')
const modes = require('./modes.js')
const sync = require('./sync.js')

/**
 * The mode state file, kept BESIDE THE PLUGIN rather than in the session workspace.
 *
 * `__dirname` rather than a literal path, so the same code works whether the plugin
 * is being developed inside the workspace or installed under `${DSH_HOME}`.
 *
 * WHY IT MOVED OUT OF THE WORKSPACE: the workspace is writable by the agent, so a
 * state file living there was protected only by this plugin's own fence — a single
 * point of failure, and precisely the CVE-2026-82533 shape. Under `${DSH_HOME}` the
 * sibling security-guard plugin's control-plane guard covers it as well, giving two
 * independent layers. The fence below is retained: it stops the MODEL from rewiring
 * its own mode and reports the attempt, which is the actionable signal.
 */
const STATE_FILE = path.join(__dirname, 'permissions.json')

/**
 * The workspace used only when a tool execution carries no session cwd.
 *
 * THIS USED TO BE A HARD-CODED DEVELOPER PATH, which made the package non-distributable: every
 * other machine would have been judged against a directory it does not have. Two independent
 * misclassifications follow from a wrong constant — a real workspace file read as "outside"
 * (false denial) or an outside file read as "inside" (false allow, the dangerous direction).
 *
 * Resolution order, most authoritative first:
 *   1. `exec.agent.session.header.cwd` — the session's real workspace. Measured to be exact.
 *   2. `DSH_PERMISSION_GUARD_WORKSPACE` — an explicit operator override for unusual setups.
 *   3. `process.cwd()` — the deployment's working directory, which is a better guess than
 *      another machine's path, and is what the upstream tools fall back to as well.
 *
 * A wrong value here can only ever affect the FALLBACK case: whenever a session cwd exists it
 * wins, so a misconfigured constant cannot override a correctly identified session.
 */
function fallbackWorkspace() {
  const override = process.env.DSH_PERMISSION_GUARD_WORKSPACE
  if (typeof override === 'string' && override !== '') return normalizePath(override)
  return normalizePath(process.cwd())
}

/**
 * The starting mode when no state file exists.
 *
 * Defined in modes.js and re-exported here for readability. 2 ("Workspace write") rather than 1: a
 * fresh install that silently denies every write looks broken, and rather than 4, which would hand
 * out full access immediately. Mode 2 is the exact equivalent of the harness's own default
 * `workspace-write` policy, so installing this plugin does not change anyone's permissions.
 */
const DEFAULT_MODE_ID = modes.DEFAULT_MODE_ID

/**
 * Every file name this state file has ever had, for the self-escalation fence AND for
 * the one-time filename handover below.
 *
 * The fence is basename-based precisely because a path list drifts, and this list is the
 * one place that is allowed to change: a rename must leave the OLD name fenced too, or the
 * rename itself opens the hole (an agent could write the old name and have a later handover
 * promote it). Both names are therefore protected forever, not just while they are current.
 */
const STATE_FILE_BASENAMES = ['permissions.json', '权限设置.json']

const stats = { denied: 0, allows: 0, shellPathsChecked: 0, shellPathsAllowed: 0, selfWriteBlocks: 0 }
const audit = []

/**
 * Set while the sync injection is live; pushes a new four-mode value onto the old
 * model. Null when the sync dependencies are absent, so callers must check.
 */
let syncPush = null

let ctx0 = null

/**
 * Whether the monotonic `tools.guard` seam was available and the mode-switch control is armed.
 *
 * Recorded rather than merely logged: without it the `permission_mode` tool is a self-escalation
 * path, and a capability that silently degrades is worse than one that never existed. Surfaced in
 * `statusReport` so it can be checked without reading startup logs.
 */
let guardArmed = false

// ---------------------------------------------------------------- path helpers

function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '')
}

function isAbsolute(p) {
  return path.isAbsolute(p)
}

/** The session workspace, falling back only when the execution carries no session cwd. */
function resolveWorkspace(exec) {
  try {
    const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
      ? exec.agent.session.header.cwd
      : undefined
    if (typeof cwd === 'string' && cwd !== '') return normalizePath(cwd)
  } catch (error) { /* fall through to the resolved fallback */ }
  return fallbackWorkspace()
}

/** Resolve an argument path against the workspace and normalize it. */
function resolveCandidate(candidate, workspace) {
  const text = String(candidate)
  if (isAbsolute(text)) return normalizePath(text)
  return normalizePath(path.resolve(workspace, text))
}

function isUnder(target, root) {
  if (root === '') return false
  // Windows path comparison is case-insensitive; the harness targets Windows here.
  const t = target.toLowerCase()
  const r = root.toLowerCase()
  return t === r || t.startsWith(r + '/')
}

// ------------------------------------------------------------------ mode state

/**
 * Read the persisted mode. Any failure falls back to the most restrictive mode.
 *
 * THE PLUGIN DIRECTORY'S FILE IS THE ONLY SOURCE OF TRUTH.
 *
 * There is deliberately NO general fallback. An earlier version read a workspace-root copy
 * whenever this file was missing, so that relocating the file would not drop every
 * deployment to fail-safe mode 1. That was removed by operator decision, and the reasoning
 * is worth keeping:
 *
 *   - A fallback source is an ATTACK SURFACE. Any file the agent can write and the plugin
 *     will later trust is deferred self-escalation: plant a permissive mode now, wait for
 *     the live file to vanish.
 *   - It only ever fires in the degraded case, so it is the least exercised and least
 *     observed path — exactly where a wrong value does the most damage.
 *   - "Which file is authoritative?" had two answers, and the two could disagree.
 *
 * The ONE exception is `adoptRenamedStateFile()` below, a filename handover inside a single
 * directory rather than a permission fallback. It is bounded in a way the removed fallback
 * was not, and that difference is the reason it is allowed back: it can only succeed when
 * the authoritative file is ABSENT, it never consults another directory, and it PRESERVES
 * the mode the operator already chose instead of substituting a guess. A fallback that
 * changes the mode is dangerous; a rename that keeps it is not.
 *
 * No caching either. An earlier version memoised the first read into a module-level
 * `modeCache`, so a hand edit did not take effect until reload while the README promised
 * edits take effect immediately — the live guard kept denying under the old mode. A few
 * hundred bytes per tool call is not worth a stale permission decision.
 */
function loadMode() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const found = modes.modeById(Number(parsed && parsed.mode))
    if (found !== undefined) return found
  } catch (error) { /* absent or malformed: try the rename handover, then fail safe */ }
  return modes.modeById(adoptRenamedStateFile())
}

/**
 * One-time handover from the state file's former name, in the SAME directory.
 *
 * WHY THIS EXISTS AT ALL, GIVEN THAT ALL FALLBACKS WERE DELETED
 *
 * The file was renamed `权限设置.json` -> `permissions.json`. Without a handover every
 * existing deployment would silently drop to fail-safe mode 1 on upgrade — a permission
 * change nobody asked for, caused purely by a cosmetic rename. That is the same failure the
 * removed workspace fallback existed to prevent, so refusing to handle it would be
 * consistency for its own sake.
 *
 * WHY IT IS NOT THE OLD FALLBACK IN DISGUISE
 *
 *   - It only reads a sibling of STATE_FILE, never another directory. The removed version
 *     reached into the workspace, which the agent can write; this one cannot.
 *   - It runs only when STATE_FILE is absent, and carries over the operator's existing mode
 *     rather than choosing one. No old file still means fail-closed mode 1.
 *   - It DELETES the old file on success, so it cannot fire twice and cannot resurrect a
 *     stale value if the new file is later removed. A permanent second copy was exactly the
 *     dormant-escalation problem; a consumed one is not.
 *
 * The old name stays in STATE_FILE_BASENAMES so the self-escalation fence protects it too —
 * otherwise the rename would open the very hole this function is here to close.
 */
function adoptRenamedStateFile() {
  for (let i = 0; i < STATE_FILE_BASENAMES.length; i++) {
    const name = STATE_FILE_BASENAMES[i]
    if (name === path.basename(STATE_FILE)) continue
    const candidate = path.join(path.dirname(STATE_FILE), name)
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      const found = modes.modeById(Number(parsed && parsed.mode))
      if (found === undefined) continue
      persistMode(found)
      // Consume the old file. If this fails the handover still succeeded, so it is reported
      // rather than thrown: a stale duplicate is a hygiene problem, not a permissions one.
      try {
        fs.unlinkSync(candidate)
      } catch (error) {
        console.error('[permission-guard] renamed state file adopted but old copy could not be removed:', candidate, String(error))
      }
      console.log('[permission-guard] adopted state file', candidate, '->', STATE_FILE, '(mode ' + found.id + ')')
      return found.id
    } catch (error) { /* absent or malformed: try the next former name */ }
  }
  return DEFAULT_MODE_ID
}

function currentMode() {
  return loadMode()
}

function persistMode(mode) {
  // NO `workspace` FIELD. Earlier versions wrote one here, and it was read by nothing while
  // being wrong whenever the deployment moved or the operator opened a different workspace —
  // a field that only misleads whoever opens the file. The workspace is not a property of the
  // MODE; it belongs to the SESSION, and is resolved per call from the session header.
  const payload = {
    mode: mode.id,
    name: mode.name,
    note: 'Read and written by the permission-guard plugin. Change the mode number (1-4) to switch; it takes effect on the next check.',
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8')
}

/**
 * Whether a path names a mode state file, in ANY directory — not just the live one.
 *
 * WHY BASENAME, AND WHY THE NON-LIVE LOCATIONS STILL MATTER
 *
 * This began as an exact comparison against STATE_FILE, and that was the bug. Moving the
 * state file into the plugin directory made the check narrower in exactly the wrong place:
 * the workspace-root copy stopped being recognised, so a `write` straight to it sailed
 * through the fence. Observed, not theorised — two writes to `D:\DeepSeek Harness\权限设置.json`
 * were accepted while the guard was demonstrably live in the same session.
 *
 * The live file is now the ONLY authority (see `loadMode`), so a writable stray copy can no
 * longer be promoted by migration. The fence still refuses every location, for two reasons
 * that survive that change:
 *
 *   1. Defence in depth. "Nothing reads that file" is a property of TODAY'S code. The moment
 *      any future fallback, debug aid, or operator script consults a stray copy, a writable
 *      one becomes a live escalation path again. The fence should not have to be re-derived
 *      from the current read path.
 *   2. A stray copy IS a real permission file to a human. `security-guard` and this fence
 *      exist so that no file with this name is silently rewritten; if the model can edit
 *      one, an operator reading it later has no way to tell it was tampered with.
 *
 * Matching on the basename rather than enumerating paths is deliberate: a path list is
 * exactly what drifted out of sync here, and the file name is distinctive enough that the
 * false-positive cost is one refused call. The cost is real — an unrelated file with the same
 * name in another directory is also refused — and it is accepted.
 *
 * EVERY FORMER NAME IS FENCED TOO. The file was renamed once; fencing only the current name
 * would make the old name freely writable exactly when `adoptRenamedStateFile()` was reading
 * it as a legitimate source. A rename must not punch a hole in its own guard.
 */
function isStateFile(target) {
  const normalized = normalizePath(target).toLowerCase()
  const base = normalized.split('/').pop()
  if (base === '') return false
  for (let i = 0; i < STATE_FILE_BASENAMES.length; i++) {
    const name = String(STATE_FILE_BASENAMES[i]).toLowerCase()
    if (name.length < 3) continue
    if (base === name) return true
  }
  return false
}

// ------------------------------------------------------------------ decisions

function decisionOk() {
  stats.allows += 1
  return null
}

function record(entry) {
  audit.push(entry)
  if (audit.length > 200) audit.splice(0, audit.length - 200)
  console.log('[permission-guard] DENY', entry.tool, entry.reason)
}

function decide(tool, target, kind, mode, exec) {
  const where = kind === 'read' ? 'read' : 'write'
  const inWorkspace = isUnder(target, resolveWorkspace(exec))
  const allowed = inWorkspace
    ? (kind === 'read' ? mode.workspaceRead : mode.workspaceWrite)
    : (kind === 'read' ? mode['outside-read'] : mode['outside-write'])

  if (allowed) return decisionOk()

  stats.denied += 1
  const scope = inWorkspace ? 'workspace' : 'outside the workspace'
  const reason = 'Permission mode ' + mode.id + ' (' + mode.name + ') denies ' + where + ' on ' + scope + ': ' + target
  const hint = 'Current mode is "' + mode.name + '" (' + mode.summary + '). '
    + 'The model cannot raise its own permissions; ask the human to change the mode in ' + STATE_FILE
    + ' or via the permission selector.'
  const entry = {
    at: new Date().toISOString(),
    tool: tool,
    kind: kind,
    scope: scope,
    path: target,
    mode: mode.id,
    reason: reason,
  }
  record(entry)
  return { kind: 'deny', reason: reason + '. ' + hint }
}

// -------------------------------------------------------------------- fencing

/**
 * Split a shell command into tokens that look like filesystem paths.
 *
 * Best-effort by design: this catches the plain forms an agent actually writes
 * (`cat D:\x`, `Get-Content ../y`, `rg foo D:/z`) and explicitly does not attempt
 * to defeat deliberate obfuscation.
 */
function extractShellPaths(command) {
  const found = []
  const text = String(command)

  // Quoted spans first: a quoted path containing spaces must stay one token.
  // Then REMOVE those spans before the bare-token pass, or the same path is
  // re-split on whitespace and each fragment is judged as its own path. That
  // bug resolved `D:\DeepSeek` (a fragment of `D:\DeepSeek Harness\sub\f.txt`)
  // and denied a legitimate in-workspace read.
  const quoted = /"[^"]*"|'[^']*'|`[^`]*`/g
  const spans = []
  let q
  while ((q = quoted.exec(text)) !== null) {
    const raw = q[0]
    const inner = raw.slice(1, -1)
    spans.push(raw)
    if (looksLikePath(inner)) found.push(inner)
  }
  let remaining = text
  for (let i = 0; i < spans.length; i++) remaining = remaining.split(spans[i]).join(' ')

  const bare = remaining.split(/\s+/)
  for (let i = 0; i < bare.length; i++) {
    const token = bare[i].replace(/^[("'`]+/, '').replace(/[)"'`,;]+$/, '')
    if (token === '' || token.length > 500) continue
    if (looksLikePath(token)) found.push(token)
  }
  return found
}

/**
 * Decide whether one shell token is a filesystem path.
 *
 * Deliberately strict about the bare-relative form. An earlier draft accepted any
 * `word/word` or `word\word` token, which classified the COMMAND NAME
 * `Get-Content` as a relative path and denied legitimate in-workspace reads. Bare
 * relative paths without a `./` or `../` prefix are rare in generated commands,
 * and PowerShell does not execute them from the current directory by default, so
 * dropping that form costs little and removes the false positive.
 */
function looksLikePath(token) {
  if (typeof token !== 'string') return false
  const t = token.trim()
  if (t.length < 3) return false
  if (/^[A-Za-z]:[\\/]/.test(t)) return true                // C:\x or C:/x
  if (/^\\\\[^\\]/.test(t)) return true                     // UNC \\server\share
  if (t.startsWith('/') && !t.startsWith('//')) return true // POSIX absolute
  if (/^\.\.?[\\/]/.test(t)) return true                    // ./x or ../x
  return false
}

/** Classify a shell command's likely intent. Writes are the conservative default. */
const WRITE_VERBS = /\b(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|mkdir|touch|rm|mv|cp|del|rd|md|tee)\b/i

function fenceShell(exec, args, mode) {
  const command = typeof args.command === 'string' ? args.command : ''
  const writes = WRITE_VERBS.test(command)
  const kind = writes ? 'write' : 'read'
  const candidates = extractShellPaths(command)
  for (let i = 0; i < candidates.length; i++) {
    const target = resolveCandidate(candidates[i], resolveWorkspace(exec))
    stats.shellPathsChecked += 1
    const blocked = decide(exec.name, target, kind, mode, exec)
    if (blocked !== null) {
      return { kind: 'deny', reason: blocked.reason + ' (matched path "' + candidates[i] + '" in the shell command)' }
    }
    stats.shellPathsAllowed += 1
  }
  return null
}

function fencePathTool(exec, args, mode, kind, field) {
  const value = args[field]
  if (typeof value !== 'string' || value.trim() === '') return null
  const target = resolveCandidate(value, resolveWorkspace(exec))
  return decide(exec.name, target, kind, mode, exec)
}

function fenceTreeTool(exec, args, mode) {
  const scopePath = typeof args.path === 'string' && args.path.trim() !== '' ? args.path : '.'
  const target = resolveCandidate(scopePath, resolveWorkspace(exec))
  return decide(exec.name, target, 'read', mode, exec)
}

/**
 * Tools that MUTATE, and the argument fields holding their target path.
 *
 * The self-escalation fence must apply to exactly these. An earlier version checked
 * every tool uniformly, so `read 权限设置.json` was refused too — wider than the
 * design intent. Harmless in direction, but it was "accidentally correct" rather
 * than designed, and it blocked the model from reading its own mode state.
 */
const MUTATING_TOOLS = {
  write: ['file_path'],
  edit: ['file_path'],
  str_replace_editor: ['path'],
}
const SHELL_MUTATION_VERBS = /\b(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|mkdir|touch|rm|mv|cp|del|rd|md|tee)\b/i

/**
 * The same intent spelled as a SCRIPT-LANGUAGE FILE API instead of a shell cmdlet.
 *
 * WHAT THIS CLOSES (a real, observed hole)
 *
 * The list above held PowerShell cmdlets and POSIX utilities only. Moving the mode
 * state file out of the workspace was done with roughly
 *
 *     node -e "const fs=require('fs'); fs.renameSync('<src>', '<dst>')"
 *
 * and the fence did NOT fire. `renameSync` is none of the verbs above, so no target
 * path was extracted and nothing was ever compared against STATE_FILE. The guard was
 * blind to `node -e`, python heredocs, and every other scripted file write — exactly
 * the form an agent reaches for when a cmdlet is unavailable or a path contains
 * characters the shell would mangle.
 *
 * Matching is on the API NAME. These strings are rare in ordinary prose, and the
 * asymmetry is stark: a false positive costs one refused call, a false negative costs
 * a self-escalation. Covers the sync/async spellings, `fs.promises`, Python's os /
 * pathlib / shutil, and PowerShell's .NET file statics.
 */
const SCRIPT_MUTATION_VERBS = /\b(?:writeFileSync?|renameSync?|unlinkSync?|rmdirSync?|rmSync|mkdirSync?|mkdirp|copyFileSync?|cpSync|truncateSync?|appendFileSync?|createWriteStream|chmodSync?|chownSync?|utimesSync?|linkSync?|symlinkSync?|write_text|write_bytes|makedirs|rmtree|shutil\.(?:move|copy2?|copytree|rmtree)|os\.(?:rename|remove|unlink|rmdir|makedirs|mkdir)|\[IO\.File\]|\[System\.IO\.File\])\b/i

/**
 * Does a MUTATING shell command name the state file anywhere in its text?
 *
 * Needed because path EXTRACTION is deliberately strict — `looksLikePath` rejects
 * bare relative paths and anything under three characters — and a path embedded in a
 * script string often never becomes a standalone token. In the command above the
 * inner quotes terminate the outer quoted span, so the destination path is shredded
 * into fragments that `looksLikePath` then rejects. The basename is not a reliable
 * fallback either: it is permissions.json (or 权限设置.json), which the tokenizer can drop.
 *
 * So this is a second, independent signal: if a command already matched a mutation
 * verb AND names the state file — current name, any former name, full path or basename —
 * it is a write to the guard's own mode file.
 *
 * Scoped to the mutating branch only, so a read-only command that merely names the
 * file (`Get-Content ...\permissions.json`) still passes. That distinction is the point:
 * a WRITE-only fence is precisely what let the observed move through, while fencing
 * reads would deny the model knowledge of its own mode for no security gain.
 */
function commandMentionsStateFile(command) {
  const slashed = String(command).replace(/\\/g, '/').toLowerCase()
  if (slashed.indexOf(normalizePath(STATE_FILE).toLowerCase()) !== -1) return true
  for (let i = 0; i < STATE_FILE_BASENAMES.length; i++) {
    const name = String(STATE_FILE_BASENAMES[i]).toLowerCase()
    if (name.length >= 3 && slashed.indexOf(name) !== -1) return true
  }
  return false
}

/**
 * Deny a MUTATING tool call whose target is the mode state file.
 *
 * Without this the guard is self-defeating: 权限设置.json lives INSIDE the
 * workspace, which the agent may write, so an agent could raise its own mode and
 * thereby widen its own confinement — exactly the CVE-2026-82533 shape. Blocking
 * the agent's write does not affect the human: they edit the file with an editor,
 * which never passes through this tool seam.
 *
 * Reads are deliberately NOT fenced: knowing the current mode is not a capability.
 */
function fenceSelfWrite(exec, args) {
  const name = String(exec && exec.name ? exec.name : '')
  const targets = []

  const fields = MUTATING_TOOLS[name]
  if (fields !== undefined) {
    for (let i = 0; i < fields.length; i++) {
      const value = args[fields[i]]
      if (typeof value === 'string' && value !== '') targets.push(value)
    }
  } else if (modes.SHELL_TOOLS.has(name)) {
    // Only commands that actually mutate: a read-only shell command naming the
    // file is observation, not escalation.
    const command = typeof args.command === 'string' ? args.command : ''
    const mutates = SHELL_MUTATION_VERBS.test(command) || SCRIPT_MUTATION_VERBS.test(command)
    if (mutates) {
      // The raw-text signal is checked in addition to (not instead of) extracted
      // paths: extraction misses paths buried inside script strings, which is
      // exactly how the state-file move slipped past the first version.
      if (commandMentionsStateFile(command)) {
        targets.push(STATE_FILE)
      }
      const extracted = extractShellPaths(command)
      for (let i = 0; i < extracted.length; i++) targets.push(extracted[i])
    }
  } else {
    return null
  }

  for (let i = 0; i < targets.length; i++) {
    const resolved = resolveCandidate(targets[i], resolveWorkspace(exec))
    if (!isStateFile(resolved)) continue
    stats.selfWriteBlocks += 1
    const entry = {
      at: new Date().toISOString(),
      tool: name,
      reason: 'self-escalation guard: attempted to modify the permission mode file',
      path: resolved,
      mode: currentMode().id,
    }
    audit.push(entry)
    if (audit.length > 200) audit.splice(0, audit.length - 200)
    console.log('[permission-guard] DENY self-write', entry.tool, resolved)
    return {
      kind: 'deny',
      reason: 'The DSH permission guard denied this call (self-escalation guard): the target is the permission mode file itself ('
        + resolved + '). The model cannot modify its own permission mode — that is the CVE-2026-82533 shape. '
        + 'Ask the human to edit that file with an editor, or to switch mode through the permission selector.',
    }
  }
  return null
}

/**
 * Inspect one pending tool call. Returns a deny decision or null.
 * Fails OPEN on an internal error so a bug here cannot wedge every tool call,
 * but logs loudly, because a silent open failure would look identical to a pass.
 */
function inspect(exec) {
  try {
    const name = String(exec && exec.name ? exec.name : '')
    const args = exec && exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {}
    const mode = currentMode()

    // Checked first and for every tool, so no tool can reach around it.
    const selfWrite = fenceSelfWrite(exec, args)
    if (selfWrite !== null) return selfWrite

    if (modes.PATH_READ_TOOLS.has(name)) return fencePathTool(exec, args, mode, 'read', 'file_path')
    if (modes.PATH_WRITE_TOOLS.has(name)) return fencePathTool(exec, args, mode, 'write', 'file_path')
    if (modes.STR_REPLACE_TOOL === name) return fencePathTool(exec, args, mode, 'write', 'path')
    if (modes.TREE_READ_TOOLS.has(name)) return fenceTreeTool(exec, args, mode)
    if (modes.SHELL_TOOLS.has(name)) return fenceShell(exec, args, mode)
    return null
  } catch (error) {
    console.error('[permission-guard] inspection failed, allowing call:', String(error))
    return null
  }
}

// ------------------------------------------------------------------- reporting

function modeLine(mode) {
  return 'mode ' + mode.id + ' "' + mode.name + '" ' + mode.summary
}

/**
 * The model-facing description of the `permission_mode` tool.
 *
 * GENERATED from PERMISSION_MODES rather than typed out. The previous version hard-coded
 * the four mode names in a string literal, so renaming the file's modes to English left
 * the tool description advertising the old Chinese names — a drift the type system cannot
 * catch, and one that only shows up as a model picking a mode that no longer matches.
 */
function toolDescription() {
  const parts = modes.PERMISSION_MODES.map(function (m) {
    return m.id + ' ' + m.name
  })
  return 'Report the tool-layer file permission mode (' + parts.join(' / ')
    + '). Reports the current mode and counters when called without arguments.'
}

/**
 * Is `next` a strict widening of `current`?
 *
 * This is the whole test the self-escalation guard applies to a mode SWITCH. It is
 * deliberately about the permission SET, not about "did the mode change":
 *
 *   - Widening (1->4, 3->4, 2->3) is self-escalation and is refused.
 *   - Narrowing (4->1, 3->2) gives up access the agent already had. Refusing it would protect
 *     nothing — an agent that can already read everything is not made dangerous by choosing
 *     to read less — and it would block a genuinely useful containment action.
 *   - Same mode is a no-op and is allowed.
 *
 * Compared field-by-field rather than by mode id, so the check keeps working if the mode set
 * ever changes order or gains a dimension. Mode ids happen to be ordered by widening TODAY,
 * but relying on that would make the check silently wrong the moment that stops being true.
 */
function isPrivilegeIncrease(current, next) {
  if (current === undefined || next === undefined) return false
  const currentSet = [current.workspaceRead, current.workspaceWrite, current['outside-read'], current['outside-write']]
  const nextSet = [next.workspaceRead, next.workspaceWrite, next['outside-read'], next['outside-write']]
  let widened = false
  for (let i = 0; i < currentSet.length; i++) {
    if (Boolean(nextSet[i]) && !Boolean(currentSet[i])) widened = true
    // Losing a permission is a narrowing, not an escalation; only the widening loop above
    // can set the flag.
  }
  return widened
}

/**
 * The refusal a self-escalation attempt through the `permission_mode` TOOL receives.
 *
 * WHY THIS EXISTS AT ALL: the file fence was never enough.
 *
 * `fenceSelfWrite` refuses every write to the mode FILE, and that was treated as covering
 * self-escalation. It did not. The `permission_mode` tool calls `persistMode()` in-process,
 * so it never traverses `tools/pre-execute` and the fence never sees it — measured, not
 * assumed. The tool is registered into the agent's own tool list, which means a model could
 * simply call it and switch itself to mode 4, defeating the entire plugin. The README's
 * claim that "the model cannot raise its own permissions" was false through that one door
 * while remaining true through every other.
 *
 * WHY `tools.guard` AND NOT ANOTHER pre-execute LISTENER: the tools service documents the
 * guard as MONOTONIC — "no guard can force-allow a call another guard denied" — while
 * `tools/pre-execute` is an extensible waterfall. For the control that must not be
 * bypassable, the monotonic seam is the correct one.
 */
function modeSwitchRefusal(current, requested) {
  return 'The DSH permission guard refused this mode switch: permission_mode is a reporting '
    + 'tool for the model. It would move the session from mode ' + current.id + ' (' + current.name + ') to mode '
    + requested.id + ' (' + requested.name + '), which extends the model\'s own file access. The model cannot raise '
    + 'its own permissions — that is the CVE-2026-82533 shape. Ask the human to switch modes: the permission '
    + 'indicator in the composer, an editor on ' + STATE_FILE + ', or the human\'s own tool call.'
}

/**
 * The workspace the REQUESTING session is judged against, or null when it cannot be known.
 *
 * WHY THIS TAKES A CONTEXT, AND WHY THE SESSION-LIST SCAN WAS DELETED
 *
 * The enforcing half resolves the workspace exactly, from `exec.agent.session.header.cwd`. The
 * reporting half has no execution, so a first attempt read `sessions.list()`. That was wrong in
 * a way only MULTIPLE WORKSPACES expose: `list()` returns EVERY live session — the shipped host
 * uses it for cross-workspace search and tags candidates with `sameWorkspace` — so picking "the
 * first session with a cwd" is a GUESS. Measured with two sessions live:
 *
 *     list [A,B] -> reports workspace A
 *     list [B,A] -> reports workspace B
 *
 * Same session, same code, different answer. The model would be told one workspace's boundary
 * while the fence enforced its own.
 *
 * The prompt assembly context carries the requesting agent: the shipped host builds it as
 * `{ agent, scope: agent }` and its own providers read `context.agent.session.header.cwd`. So
 * the exact value IS available at render time and no heuristic is needed. `scope` is checked
 * too because it is the same object in the shipped implementation.
 *
 * WHEN IT IS STILL UNKNOWN THIS RETURNS null AND THE TEXT SAYS SO. A heuristic fallback here
 * would restore the bug: a confidently wrong workspace is worse than a stated unknown, because
 * the model acts on it. Enforcement is unaffected — it always has the agent, and fails closed
 * when it does not.
 */
function sessionWorkspace(context) {
  const sources = [context && context.agent, context && context.scope]
  for (let i = 0; i < sources.length; i++) {
    const holder = sources[i]
    try {
      const cwd = holder && holder.session && holder.session.header
        ? holder.session.header.cwd
        : undefined
      if (typeof cwd === 'string' && cwd !== '') return normalizePath(cwd)
    } catch (error) { /* try the next source */ }
  }
  return null
}

/**
 * The per-turn boundary text injected into the agent's context.
 *
 * ENGLISH, and deliberately free of UI wording. This is read by the MODEL, not rendered to
 * a person, so it states the policy instead of naming it: the four mode ids are this
 * plugin's invention and a model cannot act on "mode 3" without the matrix next to it.
 * Localizing this text would be localizing a machine-facing contract.
 *
 * `context` is the prompt assembly context the harness passes to the section callback; it
 * carries the requesting agent. Dropping it was the root cause of the multi-workspace
 * misreport described on `sessionWorkspace`.
 */
function boundaryText(mode, context) {
  const workspace = sessionWorkspace(context)
  const workspaceLine = workspace === null
    ? ' Workspace = (not resolvable this turn; the fence uses the session\'s own cwd).'
    : ' Workspace = ' + workspace + '.'
  return '[permission-guard] Current file permissions: ' + modeLine(mode) + '.'
    + workspaceLine
    + ' Workspace: ' + (mode.workspaceRead ? 'readable' : 'not readable') + ', ' + (mode.workspaceWrite ? 'writable' : 'not writable') + ';'
    + ' Outside: ' + (mode['outside-read'] ? 'readable' : 'not readable') + ', ' + (mode['outside-write'] ? 'writable' : 'not writable') + '.'
    + ' Out-of-scope file access is denied, and the model cannot raise its own permissions;'
    + ' ask the human to switch mode when broader access is needed.'
}

function statusReport(context) {
  const mode = currentMode()
  // No context is available in a tool call, so this is usually null; it is stated as such
  // rather than filled with a guess.
  const workspace = sessionWorkspace(context)
  return {
    plugin: 'permission-guard',
    enforcement: 'tool layer (not a kernel boundary)',
    stateFile: STATE_FILE,
    // Which host APIs this build actually provided. A missing `tools.guard` is not fatal — the file
    // fence still works — but it DOES disable the mode-switch control, and that must be visible in
    // a report rather than only in a startup log line nobody reads.
    capabilities: {
      toolsGuard: guardArmed,
      modeSwitchControl: guardArmed
        ? 'active (the model cannot widen its own mode through permission_mode)'
        : 'INACTIVE — this DSH build does not expose tools.guard, so permission_mode can switch modes',
    },
    // The workspace used to classify paths, and separately the constant used when nothing can
    // be resolved. Reporting only the constant was misleading for an operator elsewhere;
    // reporting a guessed value would be worse. Null here means "unknown", explicitly.
    workspace: workspace,
    workspaceSource: workspace === null ? 'unresolved (no requesting agent in this call)' : 'requesting agent session header cwd',
    fallbackWorkspace: fallbackWorkspace(),
    fallbackWorkspaceSource: typeof process.env.DSH_PERMISSION_GUARD_WORKSPACE === 'string' && process.env.DSH_PERMISSION_GUARD_WORKSPACE !== ''
      ? 'DSH_PERMISSION_GUARD_WORKSPACE'
      : 'process.cwd()',
    // The fence, by contrast, always has an agent and always knows; this says so.
    enforcementWorkspace: 'exec.agent.session.header.cwd, falling back to ' + fallbackWorkspace() + ' and failing closed',
    current: {
      id: mode.id,
      name: mode.name,
      summary: mode.summary,
      workspace: { read: mode.workspaceRead, write: mode.workspaceWrite },
      outside: { read: mode['outside-read'], write: mode['outside-write'] },
    },
    availableModes: modes.PERMISSION_MODES.map(function (m) {
      return { id: m.id, name: m.name, label: m.label, summary: m.summary }
    }),
    counters: {
      denials: stats.denied,
      passes: stats.allows,
      shellPathsChecked: stats.shellPathsChecked,
      shellPathsAllowed: stats.shellPathsAllowed,
      selfWriteBlocks: stats.selfWriteBlocks,
    },
    sync: {
      armed: syncPush !== null,
      oldToNew: sync.stats.oldToNew,
      newToOld: sync.stats.newToOld,
      echoSuppressed: sync.stats.skippedEcho,
      sessionPinsIgnored: sync.stats.skippedPin,
      writeFailures: sync.stats.writeFailures,
      mapping: {
        'old:read-only': sync.OLD_TO_NEW['read-only'],
        'old:workspace-write': sync.OLD_TO_NEW['workspace-write'],
        'old:danger-full-access': sync.OLD_TO_NEW['danger-full-access'],
        'new:1': sync.NEW_TO_OLD_SANDBOX[1],
        'new:2': sync.NEW_TO_OLD_SANDBOX[2],
        'new:3': sync.NEW_TO_OLD_SANDBOX[3] + ' + approval ' + sync.NEW_TO_OLD_APPROVAL[3],
        'new:4': sync.NEW_TO_OLD_SANDBOX[4] + ' + approval ' + sync.NEW_TO_OLD_APPROVAL[4],
      },
      note: 'old->new follows sandbox/mode session events; new->old writes every live '
        + 'session (the old model has no deployment-level setter), so a session created '
        + 'later starts from the composition default until it is switched.',
    },
    limits: [
      'shell commands are judged by path heuristic only; deliberately obfuscated pwsh can evade the read restriction',
      'this mode set is unrelated to the upstream SandboxMode, which fences writes only and is a closed three-value vocabulary',
      'security-guard still blocks writes to the .dsh control plane, mode 4 included',
      'the mode is process-global, not per-session',
    ],
    recentDenials: audit.slice(-5),
  }
}

// --------------------------------------------------------------------- plugin

const plugin = {
  name: 'permission-guard',
  apply(ctx) {
    ctx0 = ctx

    // Seed the state file on first load so the current mode is visible on disk.
    try {
      if (!fs.existsSync(STATE_FILE)) persistMode(currentMode())
    } catch (error) {
      console.error('[permission-guard] could not seed the state file:', String(error))
    }

    ctx.on('tools/pre-execute', function (exec, next) {
      const decision = inspect(exec)
      if (decision !== null) return decision
      return next()
    })

    // Present the four modes in the selector.
    // NO PROJECTION TAKEOVER HERE. This was tried and reverted.
    //
    // The shipped client IS data-driven (`session?.projections.faceOf("permissions")
    // .getSnapshot()`), so presenting four options looked like a projection swap.
    // It is not possible:
    //
    //   1. The registry refuses to share a key across DIFFERENT stateVersions.
    //      Registering `permissions` at stateVersion 1 while the upstream
    //      `dsh-permission-presets` registers it at 2 makes the upstream entry fail
    //      to load, which takes the WHOLE plugin tree down:
    //        "session projection key \"permissions\" is already registered at
    //         stateVersion 1; refusing to share it with stateVersion 2"
    //      This is a boot failure, not a cosmetic one.
    //   2. Even with a matching version, the selection path validates against the
    //      upstream model: selecting writes `sandbox/mode`, an event the sandbox
    //      policy's invariant plugin rejects for any value outside the closed
    //      three-value vocabulary.
    //   3. The upstream selector tracks its selection by deriving it back from
    //      (sandbox, approval) knob VALUES, so modes 2 and 3 - which differ only in
    //      outside-read, a dimension the knobs do not have - cannot be distinguished
    //      at all.
    //
    // Four modes therefore need their OWN surface, not the built-in selector.
    // Enforcement lives in this Host plugin regardless.

    // NO /permission SHADOW HERE EITHER. This was tried and reverted.
    //
    // A shadow accepting "1".."4" looked useful, but it only rewrites this
    // plugin's mode file. It does NOT call `permissionPresets.set()`, so it never
    // touches the DSH kernel sandbox that gates the actual bash/filesystem
    // capabilities. `/permission 4` would then read as "full access is on" while
    // the kernel was still confining writes - a security-relevant lie, which is
    // worse than the mode simply not being offered.
    //
    // Switching the real knobs belongs to the upstream preset service. If a future
    // version integrates these four modes with the selector, it must go through
    // `permissionPresets.set()` (or `setSandboxMode` + `setApprovalPolicy`) so the
    // kernel knobs and this abstraction cannot disagree.

    // Tell the model the current boundary, the same way the upstream sandbox
    // policy does, so it does not have to discover it by being denied.
    //
    // Nothing here may touch ctx.tools. Inside an inject callback the context is a
    // scoped proxy: reading an undeclared service property throws
    // `cannot get property "tools" without inject`, which failed this plugin's
    // load. An earlier draft called `promptCtx.tools.get('read', scope)` to skip
    // the section when the read tool is absent. Not worth a second hard dependency
    // for one advisory line, so the section is now unconditional.
    ctx.inject(['systemPrompt'], function (promptCtx) {
      promptCtx.systemPrompt.section({
        name: 'permission-guard:boundaries',
        order: 0,
        // The assembly context MUST be forwarded: it carries the requesting agent, which is
        // the only way to know WHICH workspace this turn is judged against. Dropping it made
        // the reported workspace a guess once two workspaces were open.
        text: function (context) {
          return boundaryText(currentMode(), context)
        },
      })
    })

    ctx.inject(['tools'], function (toolsCtx) {
      // The mode-switch guard, on the MONOTONIC seam.
      //
      // Placed BEFORE the registration below only for readability; registration order does
      // not affect it. A guard is a synchronous check returning a denial STRING, and the
      // tools service documents that no later guard can force-allow what one denied — which
      // is precisely the property a self-escalation control needs.
      //
      // It targets `permission_mode` ONLY. The fence for the mode FILE stays on
      // `tools/pre-execute`, where it can also inspect shell commands; the two seams cover
      // disjoint paths (tool call vs file write) and neither replaces the other.
      if (typeof toolsCtx.tools.guard === 'function') {
        guardArmed = true
        toolsCtx.tools.guard(function (execution) {
          try {
            if (String(execution && execution.name) !== 'permission_mode') return undefined
            const args = execution && execution.arguments
            const requested = args ? args.mode : undefined
            // Reporting, and a no-op switch, are not escalations.
            if (requested === undefined || requested === null) return undefined
            const next = modes.modeById(Number(requested))
            if (next === undefined) return undefined // the tool body rejects unknown ids
            const current = currentMode()
            if (!isPrivilegeIncrease(current, next)) return undefined
            const entry = {
              at: new Date().toISOString(),
              tool: 'permission_mode',
              reason: 'self-escalation guard: the model attempted to widen its own permission mode',
              from: current.id,
              to: next.id,
            }
            audit.push(entry)
            if (audit.length > 200) audit.splice(0, audit.length - 200)
            stats.selfWriteBlocks += 1
            console.log('[permission-guard] DENY self-escalation via tool', current.id, '->', next.id)
            return modeSwitchRefusal(current, next)
          } catch (error) {
            // FAIL CLOSED, unlike the file fence. An error here must not become permission to
            // escalate: the recoverable outcome is a refused switch, not a widened sandbox.
            console.error('[permission-guard] mode-switch guard failed, refusing the switch:', String(error))
            return 'The DSH permission guard could not evaluate this permission_mode switch, so it refused it (fail-closed).'
          }
        })
      } else {
        // LOUD, because the alternative is a silent hole: without the guard the tool remains
        // a self-escalation path, and a quiet fallback would look identical to a protected one.
        console.error('[permission-guard] tools.guard is unavailable; the permission_mode tool '
          + 'remains a self-escalation path (a model can switch its own mode). Registrations that '
          + 'must not be bypassable belong on the monotonic guard seam.')
      }

      toolsCtx.tools.register({
        name: 'permission_mode',
        description: toolDescription(),
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'integer',
              enum: modes.modeIdList(),
              description: 'Target mode id. Omit to report the current mode and counters. A switch that '
                + 'WIDENS the model\'s own file access is refused by the self-escalation guard; narrowing is allowed.',
            },
          },
          required: [],
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: function (args, value) {
            return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
          },
        },
        isConcurrencySafe: function () { return true },
        // The ToolRunContext carries `agent`, so the status report can name the workspace the
        // CALLER is judged against instead of saying "unknown". It is forwarded, not required:
        // the report works without it and labels the value as unresolved.
        execute: function (args, exec) {
          const requested = args && args.mode
          if (requested === undefined || requested === null) return statusReport(exec)
          const found = modes.modeById(Number(requested))
          if (found === undefined) {
            return { action: 'switch', ok: false, reason: 'unknown mode id ' + String(requested), availableModes: modes.modeIdList() }
          }
          persistMode(found)
          if (syncPush !== null) syncPush(found, 'permission_mode tool')
          return { action: 'switch', ok: true, current: { id: found.id, name: found.name, summary: found.summary }, boundary: boundaryText(found, exec) }
        },
      })
    })

    // READ-ONLY route the client half fetches for the current mode.
    //
    // Why HTTP and not host RPC: `harness.handle` + `host.call` exist only inside
    // the DYNAMIC plugin runner. Its host side keeps a per-run handler Map
    // (`handlers: new Map()` on `plugin.run`) and routes back by
    // `pluginRunId/packageId`; a profile plugin has no handle into it, and across
    // 11342 shipped code files only the four dynamic-runner files mention
    // `host.call` at all. So the seam is closed by design, and the web server is
    // the supported surface a profile plugin CAN own.
    //
    // SAFETY: GET only, and it discloses nothing that is not already visible in the
    // UI. There is deliberately NO write route. A POST route would be reachable by
    // the agent's own shell (HTTP never passes through `tools/pre-execute`), i.e. it
    // would reopen exactly the self-escalation hole `fenceSelfWrite` exists to
    // close. The UI is therefore a status display, not a control.
    ctx.inject(['webServer'], function (webCtx) {
      webCtx.webServer.register({
        kind: 'exact',
        path: '/permission-guard/mode',
        handler: function (req, res) {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.statusCode = 405
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end('{"error":"method not allowed"}')
            return
          }
          const mode = currentMode()
          // No requesting agent exists on an HTTP route, so no session workspace can be named.
          // The payload therefore carries the resolved FALLBACK, clearly labelled, rather than
          // the mode's id under a field called `workspace` — which is what it used to do, and
          // which advertised a workspace the payload had nothing to do with. The client reads
          // `id` and applies its own locale labels; it never used this field.
          const payload = JSON.stringify({
            id: mode.id,
            name: mode.name,
            summary: mode.summary,
            fallbackWorkspace: fallbackWorkspace(),
          })
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(payload)
        },
      })
      console.log('[permission-guard] mode route registered at /permission-guard/mode')
    })

    // ---------------------------------------------------------------- old <-> new sync
    //
    // The two permission models are independent, and this makes them follow each
    // other. Mapping and the per-session caveat are documented in ./sync.js.
    //
    // Loop safety: both handlers write the other side, so every programmatic write
    // runs inside `sync.apply()` (a depth-counted guard) and the handlers ignore
    // events observed while that guard is active. Without it each write would be
    // seen as an external change and echoed forever.
    ctx.inject(['sessions', 'approval'], function (syncCtx) {
      const sessions = syncCtx.sessions
      const approval = syncCtx.approval

      /** new -> old: push the current mode onto every live session and agent. */
      function applyToOld(mode, reason) {
        const sandbox = sync.NEW_TO_OLD_SANDBOX[mode.id]
        const policy = sync.NEW_TO_OLD_APPROVAL[mode.id]
        const targets = sessions.list()
        let touched = 0
        let failed = 0
        for (let i = 0; i < targets.length; i++) {
          const session = targets[i]
          try {
            // Skip a session already carrying this exact mode: append would be a
            // no-op event and would only add log noise.
            if (sandboxPolicyOverride(session) === sandbox) continue
            session.append('sandbox/mode', { mode: sandbox })
            touched += 1
          } catch (error) {
            failed += 1
            sync.report('new->old sandbox failed', String(error))
          }
          try {
            const agent = agentsOf(syncCtx, session)
            if (agent !== undefined && approval.effectivePolicyOf !== undefined) { /* no-op */ }
            if (agent !== undefined) approval.setPolicy(agent, policy)
          } catch (error) {
            failed += 1
            sync.report('new->old approval failed', String(error))
          }
        }
        sync.stats.newToOld += 1
        sync.stats.writeFailures += failed
        sync.report('new->old', 'mode ' + mode.id + ' -> sandbox=' + sandbox + ' approval=' + policy
          + ' sessions=' + targets.length + ' updated=' + touched + ' failed=' + failed
          + ' (' + reason + ')')
      }

      /** The session's own last `sandbox/mode` event, if any. */
      function sandboxPolicyOverride(session) {
        try {
          const events = session.snapshotEvents()
          for (let i = events.length - 1; i >= 0; i--) {
            if (events[i].type === 'sandbox/mode') return events[i].data && events[i].data.mode
          }
        } catch (error) { /* fall through: treat as no override */ }
        return undefined
      }

      /** The live agent for a session, needed by approval.setPolicy. */
      function agentsOf(c, session) {
        try {
          const agents = c.get('agents')
          if (agents === undefined || typeof agents.get !== 'function') return undefined
          return agents.get(session.id)
        } catch (error) {
          return undefined
        }
      }

      // old -> new: follow the kernel sandbox mode when the OPERATOR changes it.
      //
      // The hard part is that not every `sandbox/mode` event is a user action. The
      // upstream preset service pins every new session:
      //
      //   ctx.on("session/created", (session) => this.pinInitialPermission(session))
      //   pinInitialPermission(session) {
      //     ...
      //     setSandboxMode(session, spec.sandbox)        // appends sandbox/mode
      //   }
      //   // and for a session with no override:
      //   if (sandbox === null) setSandboxMode(session, this.ctx.shell.sandboxMode)
      //
      // `ctx.shell.sandboxMode` is the DEPLOYMENT default (workspace-write), not this
      // plugin's mode. So every new session appended `sandbox/mode=workspace-write`,
      // which maps to new 2, which OVERWROTE a hand-set 4 the moment any session was
      // created. That was a real bug: the operator set 4 and it silently became 2.
      //
      // A session's FIRST sandbox/mode event is always that pin, so it is skipped.
      // Genuine changes (the operator switching presets, which calls
      // `session.append('sandbox/mode', ...)` on an existing session) arrive as a
      // later event and still sync. Documented limitation: a change made before a
      // session has any pinned event is indistinguishable from the pin and is
      // skipped — visible in the log, never silent.
      const pinned = new Set()
      ctx.on('session/event', function (session, event) {
        try {
          if (sync.inApply()) { sync.stats.skippedEcho += 1; return }
          if (event === undefined || event.type !== 'sandbox/mode') return
          const key = session === undefined || session.id === undefined ? '?' : String(session.id)
          if (!pinned.has(key)) {
            pinned.add(key)
            sync.stats.skippedPin += 1
            sync.report('old->new skipped', 'session ' + key + ' initial pin (' + (event.data && event.data.mode) + ') — not an operator change')
            return
          }
          const oldMode = event.data && event.data.mode
          const mapped = sync.OLD_TO_NEW[oldMode]
          if (mapped === undefined) { sync.stats.skippedUnknown += 1; return }
          const mode = modes.modeById(mapped)
          if (mode === undefined) return
          if (currentMode().id === mode.id) return
          persistMode(mode)
          sync.stats.oldToNew += 1
          sync.report('old->new', 'sandbox=' + oldMode + ' -> mode ' + mode.id + '「' + mode.name + '」')
        } catch (error) {
          sync.report('old->new failed', String(error))
        }
      })

      // Expose the reverse direction so the mode switch points above can call it.
      syncCtx.effect(function () {
        syncPush = function (mode, reason) {
          if (sync.inApply()) return
          sync.apply(function () { applyToOld(mode, reason) })
        }
        return function () { syncPush = null }
      }, 'permission-guard: new->old push')

      sync.report('armed', 'old->new via session/event; new->old applies to every live session')
    })

    console.log('[permission-guard] active; state file =', STATE_FILE, '; mode =', currentMode().id)
  },
}

module.exports = plugin
module.exports.default = plugin
module.exports.apply = plugin.apply
