# dsh-plugin-permission-guard
# tip:This plugin is entirely made by DeepSeek Harness

A four-mode file-permission fence for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), enforced at the tool layer, with a read-only indicator in the composer.

The harness's own sandbox has three modes and fences **writes only** — reads pass through in every mode. This plugin adds the missing dimension: it decides read *and* write access separately for the workspace and for everything outside it, and it refuses to let the model change its own mode.

## The four modes

| # | Mode | Workspace read | Workspace write | Outside read | Outside write |
|---|---|---|---|---|---|
| 1 | Workspace read 工作区查看 | ✅ | ❌ | ❌ | ❌ |
| 2 | Workspace write 工作区内修改 | ✅ | ✅ | ❌ | ❌ |
| 3 | Outside readable 非工作区可读 | ✅ | ✅ | ✅ | ❌ |
| 4 | Full access 完全权限 | ✅ | ✅ | ✅ | ✅ |

A fresh install starts at **mode 2**, which is exactly what the harness's own default `workspace-write` policy grants. The plugin does not change your permissions when you install it.

## Requirements

- **DeepSeek Harness with `tools.guard`.** This plugin puts its mode-switch control on the monotonic `tools.guard` seam, documented as *"no guard can force-allow a call another guard denied"* — the property a self-escalation control needs.

  On a build without `guard()`, the file fence still works and the `permission_mode` tool still reports — but **the tool refuses every switch request**. It does not perform the switch and then mention that it could not prevent it; a control that degrades to "allowed, but logged" is not a control. Mode changes then come only from a human: the composer indicator, or the state file.

  ```
  permission_mode → { capabilities: {
      toolsGuard: false,
      modeSwitchControl: "INACTIVE — this DSH build does not expose tools.guard, ..." } }
  ```

  Check that field after installing. If it says `INACTIVE`, switch modes as a human, or upgrade the harness.

- **Node.js 20 or newer.** The installer runs under `npx`.
- **pnpm available.** The installer uses it to place the package; DSH Desktop's own terminal puts the bundled pnpm on `PATH`.

## Install

```sh
npx dsh-plugin-permission-guard install
```

Then **restart DSH**. The composition is evaluated only at startup, so nothing appears until you do.

Useful flags:

```sh
npx dsh-plugin-permission-guard install --dry-run        # print what would happen
npx dsh-plugin-permission-guard install --profile web    # a different profile (default: desktop)
npx dsh-plugin-permission-guard uninstall                # remove it again
```

### Why not `dsh plugin add`?

Because it refuses to touch the profile most people want:

```js
function rejectElectronProfile(program, profile) {
  if (profile.toLowerCase() === "desktop")
    program.error('error: profile "desktop" is managed exclusively by the Electron application');
}
```

The Desktop profile is an ordinary profile on disk, so the operations are available even though the CLI front door is closed. This installer performs the same two steps directly: run pnpm in the profile directory, then add the package to `dsh.profile.bundles`. The package declares `dsh.bundle.patch`, which is what tells the harness to apply its `cordis.patch.yml` as a configuration layer — without that declaration a package is installed as a plain library and **silently never loaded**.

For a CLI profile (`web`, `headless`, …) the official command works and is equivalent:

```sh
dsh plugin --profile web add dsh-plugin-permission-guard
```

### Manual install

If you would rather not run an installer, copy this package's files into `<profile>/plugins/<name>/` and add the row to the profile's `cordis.patch.yml` yourself:

```yaml
- insert:
    - id: permission-guard
      name: ./plugins/dsh-plugin-permission-guard/index.js
```

The installer is preferred: it verifies the installed manifest before declaring success, and it rolls the profile back if anything fails partway.

## Switching modes

The mode lives in `permissions.json`, beside the plugin's own `index.js`. Three ways to change it, all effective immediately:

- **The permission indicator** in the composer — click it.
- **Edit the file** with any editor. Change `mode` to 1, 2, 3 or 4. This is a human action and does not go through the tool fence, which is deliberate: it is the escape hatch when everything else is misconfigured.
- **The `permission_mode` tool** — for reporting, and for *narrowing* the mode. See below.

### What the model can and cannot do

- **The model cannot widen its own mode.** A `permission_mode` call that would extend the model's file access is refused by a `tools.guard` check, and every write to a mode file is refused by a self-escalation fence — including writes through `node -e`, shell scripts, or a hard-link alias in another directory.
- **The model *can* narrow it.** Giving up access the model already has is not an escalation, and refusing it would block a legitimate containment action.
- **Reporting is always allowed.**

## Configuration

Both are optional.

| Setting | Default | Purpose |
|---|---|---|
| `DSH_PERMISSION_GUARD_WORKSPACE` | the user's home directory | The workspace used **only** when a tool call carries no session working directory. A real session cwd always wins, so this never overrides a correctly identified session. The default is deliberately a location that cannot be a workspace, so a fallback misclassification denies rather than permits. |
| `DSH_TOOLS_MODE` | harness default | Not read by this plugin; mentioned only because mode 3's "outside readable" dimension interacts with how the harness presents tools. |

## Keeping the harness sandbox in step

The harness has its own three-value sandbox mode, and this plugin keeps the two in step in both directions:

- **Harness → plugin.** Changing the harness's own permission selector updates this plugin's mode.
- **Plugin → harness.** Changing this plugin's mode updates the harness sandbox of every live session. This happens when you edit `permissions.json` by hand, when the `permission_mode` tool switches modes, and on the initial read at startup.

Two consequences worth knowing:

- The mapping is lossy. The harness mode tracks **writes only**, so modes 2 and 3 both map to `workspace-write` on that side; only the plugin distinguishes "outside readable". A new session inherits the composition default until it is switched, because the harness mode is per-session while this plugin's mode is process-global.
- Editing the file is a **human** action, and is pushed to the harness even when it widens access. The guard that refuses a model's widening `permission_mode` call is aimed at the tool path; the state file is protected separately by the self-escalation fence.

## What this is not

Stated plainly, because over-trusting a tool-layer fence is its own risk:

- **Not a kernel boundary.** It is enforced in the tool pipeline. A process the model starts can do anything the OS allows, subject to the harness's own sandbox.
- **Shell commands are judged heuristically.** File paths are extracted from command text with a best-effort parser. It catches the normal forms; it does not defeat deliberate obfuscation.
- **The mode is process-global, not per-session.** Two sessions share one mode.
- **Reads are never confined by the kernel**, in any mode. Modes 1 and 2 deny outside reads *at this plugin's layer only*.

By contrast, path arguments of the file tools (`read`, `write`, `edit`, `glob`, `grep`) are structured, so those decisions are exact.

## Troubleshooting

**Nothing appears in the composer after install.** The composition is read only at startup — restart DSH. If it still does not appear, check that the package name is in `<profile>/package.json` under `dsh.profile.bundles`.

**`capabilities.toolsGuard` is `false`.** Your harness build lacks `tools.guard`. The file fence works; the mode-switch control does not. Upgrade the harness.

**Everything is denied.** Read `permissions.json` — the mode is probably 1. A missing or unreadable state file also fails safe to mode 1.

**I changed the mode in the file and nothing happened.** It is re-read on every check, so this should not occur. Confirm you edited the file next to the *installed* plugin, not a copy elsewhere; `statusFile` in the `permission_mode` report names the exact path in use.

## Development

The full design record — why the four modes cannot be expressed as upstream sandbox modes, how the two-way synchronisation with the harness's own sandbox works, and every bug found along the way, with the measurements that found them — is in [`Development process.md`](./Development%20process.md).

```sh
npm test    # matrix, boot-safety, client-contract, module-resolution
```

## License

MIT
