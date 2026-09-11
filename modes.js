'use strict'

/**
 * The four permission modes from D:\DeepSeek Harness\权限设置.txt, expressed as
 * a read/write matrix over the session workspace.
 *
 *   1 Workspace read    workspace r          outside -
 *   2 Workspace write   workspace r/w        outside -
 *   3 Outside readable  workspace r/w        outside r
 *   4 Full access       workspace r/w        outside r/w
 *
 * `name`/`summary` are ENGLISH because they are persisted and displayed: `name` is
 * written into permissions.json and `summary` appears in the agent-facing status
 * report. `nameZh` carries the original Chinese display name so a translation exists
 * in exactly one place. END-USER UI TEXT IS NOT HERE — the client owns that, keyed by
 * mode id, so a label can change without touching the enforcement path.
 *
 * NOTE ON THE UPSTREAM VOCABULARY. The harness's own SandboxMode is a CLOSED
 * three-value set (read-only / workspace-write / danger-full-access) enforced in
 * three independent places: the policy config schema (`z.literal`), runtime
 * validation against SANDBOX_MODES, and an invariant companion plugin that fails
 * any unrecognised `sandbox/mode` session event. Reads are never fenced by it at
 * all - the bundled fs sandbox documents "reads pass through untouched". So these
 * four modes cannot be expressed as upstream sandbox modes; they are enforced by
 * this plugin at the tool layer, and the two "outside read" modes are the part
 * with no upstream equivalent.
 */

const OUTSIDE_READ = 'outside-read'
const OUTSIDE_WRITE = 'outside-write'

const PERMISSION_MODES = [
  {
    id: 1,
    name: 'Workspace read',
    nameZh: '工作区查看',
    label: 'workspace-view',
    workspaceRead: true,
    workspaceWrite: false,
    [OUTSIDE_READ]: false,
    [OUTSIDE_WRITE]: false,
    summary: 'workspace: read; outside: none',
  },
  {
    id: 2,
    name: 'Workspace write',
    nameZh: '工作区内修改',
    label: 'workspace-write-only',
    workspaceRead: true,
    workspaceWrite: true,
    [OUTSIDE_READ]: false,
    [OUTSIDE_WRITE]: false,
    summary: 'workspace: read/write; outside: none',
  },
  {
    id: 3,
    name: 'Outside readable',
    nameZh: '非工作区可读',
    label: 'outside-readable',
    workspaceRead: true,
    workspaceWrite: true,
    [OUTSIDE_READ]: true,
    [OUTSIDE_WRITE]: false,
    summary: 'workspace: read/write; outside: read',
  },
  {
    id: 4,
    name: 'Full access',
    nameZh: '完全权限',
    label: 'full-access',
    workspaceRead: true,
    workspaceWrite: true,
    [OUTSIDE_READ]: true,
    [OUTSIDE_WRITE]: true,
    summary: 'workspace: read/write; outside: read/write',
  },
]

/** Tools that read a single path. */
const PATH_READ_TOOLS = new Set(['read', 'read_image'])

/** Tools that mutate a single path. */
const PATH_WRITE_TOOLS = new Set(['write', 'edit'])

/** Tools that read a directory tree, optionally scoped by `path`. */
const TREE_READ_TOOLS = new Set(['glob', 'grep'])

/** Shell tools, fenced by best-effort path extraction from the command text. */
const SHELL_TOOLS = new Set(['pwsh', 'bash'])

/** `str_replace_editor` carries its target in `path` and mutates it. */
const STR_REPLACE_TOOL = 'str_replace_editor'

function modeById(id) {
  for (let i = 0; i < PERMISSION_MODES.length; i++) {
    if (PERMISSION_MODES[i].id === id) return PERMISSION_MODES[i]
  }
  return undefined
}

function modeByLabel(label) {
  for (let i = 0; i < PERMISSION_MODES.length; i++) {
    if (PERMISSION_MODES[i].label === label) return PERMISSION_MODES[i]
  }
  return undefined
}

function modeIdList() {
  return PERMISSION_MODES.map(function (m) { return m.id })
}

/**
 * Map an upstream SandboxMode onto the closest permission mode.
 *
 * Needed because the two vocabularies are NOT isomorphic: upstream has three
 * write-only modes, this set has four read/write modes. The mapping is lossy by
 * construction — `workspace-write` cannot say whether outside reads are allowed,
 * so it resolves to the mode granting exactly what upstream grants (mode 2), and
 * a lossless four-mode selection must be recorded some other way.
 *
 * @param sandbox - read-only / workspace-write / danger-full-access.
 * @returns the closest permission mode, or undefined for an unknown value.
 */
function modeBySandbox(sandbox) {
  if (sandbox === 'read-only') return modeById(2)
  if (sandbox === 'workspace-write') return modeById(2)
  if (sandbox === 'danger-full-access') return modeById(4)
  return undefined
}

/** The upstream SandboxMode that would express this mode's WRITE half, where one exists. */
function sandboxForMode(mode) {
  if (mode.id === 4) return 'danger-full-access'
  if (mode.id === 1) return 'read-only'
  return 'workspace-write'
}

/**
 * The starting mode when no state file exists.
 *
 * Exported so the test suite reads the value instead of repeating the literal. This default changed
 * from 1 to 2 when the plugin became distributable, and the suite still asserted 1 in three places —
 * a number duplicated in tests is a number guaranteed to disagree with the code eventually.
 */
const DEFAULT_MODE_ID = 2

module.exports = {
  DEFAULT_MODE_ID,
  PERMISSION_MODES,
  PATH_READ_TOOLS,
  PATH_WRITE_TOOLS,
  TREE_READ_TOOLS,
  SHELL_TOOLS,
  STR_REPLACE_TOOL,
  modeById,
  modeByLabel,
  modeIdList,
  modeBySandbox,
  sandboxForMode,
}
