'use strict'

/**
 * Two-way sync between the OLD sandbox permission model and the NEW four-mode
 * model.
 *
 * THE MAPPING (per the operator's specification)
 *
 *   old -> new                      new -> old
 *   read-only         -> 1         1 -> read-only        + approval ask
 *   workspace-write   -> 2 (default) 2 -> workspace-write + approval ask
 *   danger-full-access -> 4        3 -> danger-full-access + approval ask
 *                                  4 -> danger-full-access + approval never
 *
 * `workspace-write` maps to new 2 and not 3 on purpose: the user chose 2 as the
 * default for that old value. It is a lossy mapping by construction — the old model
 * tracks WRITE permission only, so it cannot say whether outside READS are allowed.
 * New 3 and 4 therefore both land on `danger-full-access` and are told apart by the
 * approval policy: 3 keeps `ask`, 4 sets `never`.
 *
 * WHERE EACH SIDE LIVES
 *
 * The old model has no deployment-level setter at all:
 *   - `sandboxPolicy.defaultMode` is a readonly getter (config, boot-time only).
 *   - the runtime write is `session.append('sandbox/mode', { mode })`, which is
 *     PER SESSION.
 *   - approval is `approval.setPolicy(agent, policy)`, also per live agent.
 * So "new -> old" applies to every live session, and a brand-new session starts
 * from the composition's default. That limitation is reported, not hidden.
 *
 * The new model stores one global mode in the state file, so "old -> new" is
 * likewise applied globally.
 */

/** Old sandbox mode -> new four-mode id. */
const OLD_TO_NEW = {
  'read-only': 1,
  'workspace-write': 2,
  'danger-full-access': 4,
}

/**
 * New four-mode id -> old sandbox mode.
 *
 * THE KERNEL NEEDS NO READ FENCE. `workspace-write` restricts MODIFICATIONS to the
 * session workspace and leaves reads unconfined — the bundled fs sandbox says so
 * ("Reads pass through untouched: every mode permits reading") and it is observable:
 * reading outside the workspace succeeds while the policy is workspace-write.
 *
 * So "outside readable" needs NO kernel help, and mapping new 3 onto
 * `danger-full-access` (an earlier mistake) made the kernel LOOSER than the mode
 * claimed: outside WRITES were then permitted by the kernel, leaving mode 3's
 * "outside write denied" enforced only by this plugin's tool-layer fence. Measured
 * consequence: with new 3 selected, the built-in selector showed 完全权限 because
 * the kernel really was at danger-full-access.
 *
 * Correct mapping — the kernel expresses each mode's WRITE half exactly:
 *
 *   1 workspace r,   outside -/-   -> read-only          (no workspace writes)
 *   2 workspace r/w, outside -/-   -> workspace-write
 *   3 workspace r/w, outside r/-   -> workspace-write    (outside read needs no knob)
 *   4 workspace r/w, outside r/w   -> danger-full-access
 *
 * The kernel is now never more permissive than the selected mode. Modes 2 and 3
 * share a kernel state on purpose, and the built-in selector therefore shows both
 * as 工作区内修改 — accurate about the kernel, while mode 3's extra READ freedom
 * (which the kernel grants to every mode anyway) is what this plugin's fence adds.
 */
const NEW_TO_OLD_SANDBOX = {
  1: 'read-only',
  2: 'workspace-write',
  3: 'workspace-write',
  4: 'danger-full-access',
}

/** New four-mode id -> approval policy. */
const NEW_TO_OLD_APPROVAL = {
  1: 'ask',
  2: 'ask',
  3: 'ask',
  4: 'never',
}

const stats = {
  oldToNew: 0,
  newToOld: 0,
  skippedEcho: 0,
  skippedUnknown: 0,
  /** Sessions whose initial `pinInitialPermission` event was ignored, not a user change. */
  skippedPin: 0,
  writeFailures: 0,
}

/**
 * Re-entrancy guard.
 *
 * Both directions write the other side, so without this each write would be
 * observed as an external change and echoed back forever. Depth-counted rather
 * than boolean so a nested write cannot clear the flag for an outer one.
 */
let applying = 0
function inApply() { return applying > 0 }

/**
 * Run a programmatic write to the other side with echo suppression.
 *
 * Every write this plugin makes MUST go through here. The listeners check
 * `inApply()` and ignore what they observe, because what they observe is this
 * plugin's own write rather than an operator action.
 */
function apply(operation) {
  applying += 1
  try {
    return operation()
  } finally {
    applying -= 1
  }
}

function report(kind, detail) {
  console.log('[permission-guard:sync] ' + kind + ' ' + detail)
}

module.exports = {
  OLD_TO_NEW,
  NEW_TO_OLD_SANDBOX,
  NEW_TO_OLD_APPROVAL,
  stats,
  inApply,
  apply,
  report,
}
