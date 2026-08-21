# Statusline User Controls Plan

**Related:** [`HARNESS_USAGE_TRACKING_PLAN.md`](../implemented/HARNESS_USAGE_TRACKING_PLAN.md)
(Claude statusline collector), [`ANTIGRAVITY_STATUSLINE_TOKEN_TRACKING_PLAN.md`](../implemented/ANTIGRAVITY_STATUSLINE_TOKEN_TRACKING_PLAN.md)
(Antigravity statusline collector, original single-value-lease design)

## Goal

Claude and Antigravity are both single-statusline harnesses: ctrlyoke installs its own
statusline command into a global config file (`~/.claude/settings.json` /
`~/.gemini/antigravity-cli/settings.json`) to collect quota/context data, which silently
replaces whatever the user already had configured. Today that's handled two different,
already-diverging ways per harness, with real gaps:

1. Antigravity has an opt-out (`permissions.antigravityStatusLineTracking`); Claude has none
   — it's only gated by the global `usageTracking.enabled` switch, which also controls
   Codex/Copilot collection and the entire observed-token rollup.
2. Neither harness lets a user see or edit the "forward to" command ctrlyoke captured. It's
   an in-memory value snapshotted once per extension-host process and never exposed.
3. The restore-on-exit behavior (put the user's original value back when the last ctrlyoke
   workflow using it ends) fights with wanting ctrlyoke's collector to just stay installed
   between runs — see "Cleanup question, answered" below.
4. Antigravity gets a branded ANSI fallback line when there's nothing to forward to; Claude
   doesn't (its wrapper just prints nothing).
5. Antigravity's statusline payload already carries live weekly-quota data
   (`quota.<planKey>.remaining_fraction` / `.reset_time`) — the wrapper script parses it today
   for the branded line — but nothing on the TypeScript side turns it into a
   `HarnessQuotaSnapshot`, so `UsageCard.tsx` always renders Antigravity as
   `quota.source: unavailable`.

This plan gives users explicit control (enable/disable, custom forward target, ctrlyoke-style
override) over both collectors, single-sources what's currently duplicated across the two
provider implementations and the two wrapper scripts, and finishes the Antigravity quota
plumbing.

## Cleanup question, answered

> we never cleanup our status line scripts in the settings file if there's nothing to put
> back right?

Checked `SettingsJsonMcpTracker.unregisterValueLease` (`src/core/harness/shared/SettingsJsonMcpTracker.ts:643-709`):
when no baseline existed (`sidecar.baselineHadKey` / `lease.baselineHadKey` is `false`, exactly
your case — no prior statusline script on either harness), it does `delete settings[key]` once
the last owner unregisters, and `CliIntegration.cleanupWorkflowArtifacts` (`CliIntegration.ts:1699-1722`)
calls `provider.cleanupWorkspaceArtifacts?.()` — which for both `ClaudeCliProvider` and
`AntigravityCliProvider` calls `unregisterValueLease` for the `statusLine` key — at the end of
every workflow run, not just extension shutdown.

**Confirmed by spike**: on a normal run completion, the `statusLine` key is in fact fully
removed from the settings file again — not a bug, matches the code read above. No further repro
needed.

That's moot going forward anyway: Decision 4 below intentionally replaces this behavior, so once
this plan ships, the key stops being removed on every run exit and instead stays installed until
the user explicitly turns tracking off.

## Decisions

1. **Give both providers the same enable/disable switch**, replacing Claude's implicit
   dependence on the global `usageTracking.enabled` flag and relocating (not just renaming)
   Antigravity's existing `permissions.antigravityStatusLineTracking`. See Settings Shape.
2. **All three settings (`enabled`, `customCommand`, `useCtrlyokeStyle`) are user/machine
   scope only — never workspace.** See "Scope: User/Machine Only, Not Workspace" below for the
   full reasoning; short version: the file each setting controls is one physical, machine-wide
   resource, not a per-workspace one, so a workspace-level override would just create a
   "whichever workspace wrote last wins" conflict with no good resolution, and `customCommand`
   specifically is an arbitrary shell command that must not be settable from a workspace's
   (possibly repo-committed, untrusted) `.vscode/settings.json`.
3. **Auto-detected baseline becomes a persisted, user-editable setting, not an in-memory
   snapshot.** The first time ctrlyoke ever registers its command _on this machine_ and finds
   the custom-command setting empty, copy the file's current `statusLine.command` value into
   that setting once. From then on, the setting — not a frozen baseline captured at
   registration time — is the forward target, so editing it in the UI takes effect on the next
   prompt without ctrlyoke needing to re-detect anything. (Because scope is machine-only per
   Decision 2, "first time ever" has exactly one meaning — no per-workspace ambiguity to
   resolve.)
4. **Stop restoring-on-every-run-exit.** Once ctrlyoke's command is installed, leave it
   installed across workflow runs and host restarts. Only write the settings file back
   (restore the custom-command value, or delete the key if that's empty) when the user
   explicitly disables tracking, and only after a confirmation dialog. This is a deliberate
   behavior change from the existing `SettingsJsonMcpTracker` value-lease pattern — see
   Architecture Impact below for what that simplifies (and what it still needs to keep).
5. **Disabling requires confirmation**, worded per-provider: losing token/quota data for
   Claude, losing token/quota _and context-window_ data for Antigravity (context-window
   tracking has no other source there — see `ANTIGRAVITY_STATUSLINE_TOKEN_TRACKING_PLAN.md`),
   plus a note that the visible statusline text will change back too when `useCtrlyokeStyle`
   was on (it's not just a data-loss warning — the terminal will visibly look different again).
   One confirm action either way: when `customCommand` is non-empty, the dialog shows a
   checked-by-default checkbox next to the confirm button naming the exact value it will restore
   (see UI Placement for wording rules) — confirming with it checked writes that value back to
   the settings file as part of disabling, confirming with it unchecked just deletes ctrlyoke's
   `statusLine` key. No checkbox (and no restore) when `customCommand` is empty — there's
   nothing to offer back.
6. **A `useCtrlyokeStyle` toggle controls stdout only, independent of the forward target.**
   The wrapper always writes the snapshot and always invokes the custom command (if any) so
   its own state/side effects keep running; it only decides whose _output_ reaches the
   harness's statusline. `true`: always print ctrlyoke's branded line, discarding the custom
   command's stdout. `false`: relay the custom command's stdout (or print nothing if none is
   configured). This gives "run my script AND show my decoration" as well as "run my script but
   show ctrlyoke's decoration."

   **Its default is computed once, at the same first-ever-install moment that populates
   `customCommand` (Decision 3), not a fixed value:** if that first install finds an existing
   `statusLine.command` and captures it into `customCommand`, set `useCtrlyokeStyle: false` at
   the same time, so a user who already had a working statusline sees **zero visible change**
   the moment ctrlyoke starts managing it — their script keeps running, their output keeps
   showing, and the only thing that changed is who's calling it. If there was nothing to
   capture (`customCommand` stays empty), set `useCtrlyokeStyle: true`, since ctrlyoke's branded
   line is strictly additive there — something appears where nothing did — which is also what
   makes it a safe default discoverability channel (see UX Risks below). After this one-time
   computed default, both settings are independently user-editable as normal; toggling
   `useCtrlyokeStyle` later, or clearing `customCommand`, does not recompute the other. When
   there is nothing to capture, the effective static default already supplies `true`; the
   installer must not write `true` again on every disable/re-enable cycle, because that would
   overwrite a later user edit and violate this compute-once rule.

7. **Add a branded line for Claude.** Today only Antigravity's wrapper has one
   (`formatBrandedStatusLine` in `ctrlyoke-antigravity-statusline.js`); Claude's wrapper prints
   nothing when there's no forward target. Give Claude an equivalent branded line (model,
   context usage if/when available, rate-limit percentages) using the shared formatter
   described below.
8. **Finish Antigravity's weekly-quota plumbing** so `UsageCard.tsx` actually shows it instead
   of `unavailable`.
9. **Fire a one-time install notification per provider, keyed to the actual write, not to
   "ctrlyoke's first run."** A user can install ctrlyoke, use only Claude for months, then
   install Antigravity later — Antigravity's notification must still fire the first time _its_
   statusline gets taken over, independently of whatever already happened with Claude's. See
   "Install Notification" below for the full design.

## Scope: User/Machine Only, Not Workspace

All three settings must be **machine-scoped** (VS Code `"scope": "machine"`, same as the two
existing settings this design touches), never settable at workspace scope, for reasons that
go beyond preference. This directly covers the "different script per workspace" scenario too
(a user wanting workspace A to forward to one script and workspace B to another) — not just
"tracking on in one workspace, off in another" — because both are the same underlying ask
("let this one global file hold two different values depending on which workspace is asking"),
which the file physically cannot do:

- **The resource itself is machine-wide, not per-workspace.** Both `~/.claude/settings.json`
  and `~/.gemini/antigravity-cli/settings.json` are single global files — confirmed explicitly
  in `ANTIGRAVITY_STATUSLINE_TOKEN_TRACKING_PLAN.md`'s research ("No project/workspace-scoped
  variant was found"). There is no way for workspace A to see ctrlyoke's line and workspace B
  to see the user's own line at the same time; whichever workspace's ctrlyoke instance wrote
  last wins, machine-wide, including for CLI invocations outside VS Code entirely. Letting the
  _setting_ be workspace-scoped would just let two open workspaces disagree about a value that
  can only physically hold one answer — recreating exactly the "who wins" conflict problem
  `SettingsJsonMcpTracker`'s original ref-counted lease existed to arbitrate, which Decision 4's
  simplification (dropping ref-counting) only holds up if these settings genuinely can't
  disagree across workspaces. Scoping them to machine-only is what makes that simplification
  safe, not just simpler.
- **`customCommand` is a machine-local filesystem path.** VS Code's `machine` scope (unlike
  `application`) is also excluded from Settings Sync, which is correct here — syncing an
  absolute script path from a Windows machine to a Mac (or between two developer machines with
  different tool install locations) would silently install a broken forward command.
- **Security: `customCommand` is executed with shell semantics.** Both wrapper scripts run the
  configured command via `spawn(..., { shell: true })`, on Antigravity's ~300ms poll cadence.
  If this setting could be set at workspace scope, a cloned repository's committed
  `.vscode/settings.json` could inject an arbitrary shell command that ctrlyoke would then
  execute automatically and repeatedly the moment someone opens that workspace and runs a
  ctrlyoke workflow — a command-injection vector through workspace settings, exactly the class
  of risk `Security first: Workspace-scoped operations, process isolation for scripts` (project
  `CLAUDE.md`) calls out. This is the strongest of the three reasons and applies even if the
  other two didn't.
- **Existing gap to fix while touching this area**: `antigravityStatusLineTracking` and
  `usageTracking.enabled` are already declared `"scope": "machine"` in `package.json`, but that
  only stops the VS Code Settings UI from exposing them at workspace level — it is not enforced
  by the platform-agnostic `CtrlYokeConfigService`. `CtrlYokeConfigService.getAll()`
  (`src/config/CtrlYokeConfigService.ts:157-184`) deep-merges the workspace backend over the
  user backend for every key, and `set()`'s workspace-scope guard
  (`WORKSPACE_FORBIDDEN_SETTING_ROOTS`, `CtrlYokeConfigService.ts:27-38`) currently only lists
  `worktrees` and `storage` — nothing stops a hand-edited `.vscode/settings.json`, or the
  standalone `cli.ts`/`mcp-server.ts` hosts (which have no notion of VS Code's `machine` scope
  at all), from setting `permissions.antigravityStatusLineTracking` or
  `usageTracking.enabled` at workspace scope today. Add `permissions.statusLineTracking` and
  `usageTracking.enabled` to the workspace-forbidden path policy for the settings this plan
  touches. That policy must apply on both sides of `CtrlYokeConfigService`: reject writes through
  `set()`, **and strip those paths from `getWorkspaceSettings()` before `getAll()`, `resolve()`,
  `getScoped()`, or `getLeafSources()` can observe them**. A write-only guard is insufficient:
  hand-edited `.vscode/settings.json` and the standalone file-backed hosts bypass `set()` and
  would otherwise still override the machine value on reads. Generalize the existing
  `getWorkspaceSettings()` filtering (which currently removes `storage` only) rather than adding
  another one-off merge exception. The relocated Antigravity setting is covered by the new
  `permissions.statusLineTracking` subtree, so no compatibility filter for its deleted old path
  is needed.

## Settings Shape (single-sourced, not six flat keys)

Nest both providers under one shared shape instead of hand-duplicating three keys twice. This
directly answers "can these be simplified": a `$ref`-style shared JSON-schema definition, one
TS type, one set of defaults, one generic accessor, and one parameterized React block replace
what would otherwise be six independently-authored settings.

```typescript
interface StatusLineTrackingSettings {
  enabled: boolean;
  /** Empty string = no custom command detected/configured. */
  customCommand: string;
  /** Whether ctrlyoke's own branded line wins over the custom command's stdout. */
  useCtrlyokeStyle: boolean;
}

// CtrlYokeSettings.ts
permissions: {
  // ...existing fields
  statusLineTracking: {
    claude: StatusLineTrackingSettings;
    antigravity: StatusLineTrackingSettings;
  }
}
```

Static defaults (before any install has ever run): `enabled: true` for both (matches today's
default-on behavior for both harnesses — no new opt-in prompt), `customCommand: ""`,
`useCtrlyokeStyle: true`. `useCtrlyokeStyle` only keeps that static default when the first
install finds no pre-existing statusline command to capture — see Decision 6's computed-default
rule, which flips it to `false` (and populates `customCommand`) the moment an existing script is
detected, so an already-configured user sees no visible change. All six leaf `package.json`
contribution points get `"scope": "machine"` (matching the existing
`antigravityStatusLineTracking`/`usageTracking.*` entries) — see "Scope: User/Machine Only,
Not Workspace" above; this is not optional for `customCommand`.

`antigravityStatusLineTracking` moves into `statusLineTracking.antigravity.enabled`. This is a
breaking settings-schema rename, which is fine pre-release per the project's "no backward
compatibility constraints" stance — no migration shim needed, just update the schema, defaults,
and the one call site (`AdvancedPermissionsSection.tsx:200`) plus its tests.

`ConfigurationUtils` gets one generic accessor instead of two near-duplicates:

```typescript
getStatusLineTrackingSettings(
  provider: "claude" | "antigravity"
): StatusLineTrackingSettings;
```

`SETTING_PATHS` gets three new dotted paths per provider (`permissions.statusLineTracking.claude.enabled`,
`.customCommand`, `.useCtrlyokeStyle`, and the antigravity equivalents) — six total, five of
which are net-new (the sixth is `antigravityStatusLineTracking`'s relocation).

That matches your count: 2 enable/disable (1 existing, relocated) + 2 custom-command + 2
style-override = 5 new leaf settings, now organized under one nested shape instead of six flat
ones.

## Architecture Impact — this actually removes complexity, not just adds settings

Decision 4 (stop restoring on every run exit) means the `statusLine` key no longer needs
`SettingsJsonMcpTracker`'s ref-counted, multi-owner, dead-PID-pruned value-lease machinery at
all for the _write_ side. That machinery exists to answer "when is it safe to put the user's
original value back," and the new design only asks that question once — on an explicit user
action — not on every workflow's cleanup. Concretely:

- Replace `registerValueLease`/`unregisterValueLease`/`pruneDeadOwners` calls for the
  `statusLine` key with a much smaller **idempotent install/uninstall pair**: "if
  `statusLine.command` isn't already ctrlyoke's script and tracking is enabled, install it and,
  if `customCommand` was empty and the file currently names a non-ctrlyoke command, copy that
  value into `customCommand` **and** set `useCtrlyokeStyle: false` in one user-settings object
  write (Decision 6's computed default — do not split those two setting changes, or a crash
  between them would leave a captured `customCommand` with stale styling and silently replace a
  user's working statusline after all)";
  "if the user disables tracking, write `customCommand`'s value back when the dialog checkbox is
  checked, or delete the harness `statusLine` key when it is unchecked." Disabling does not clear
  the persisted `customCommand`; it remains the user's editable forward target for a later
  re-enable. The dialog choice controls only the harness settings file.
- No per-workflow ref-counting is needed for the write side any more — concurrent workflows
  all want the same idempotent end state (ctrlyoke's command installed), so there's nothing to
  count. This only holds because Decision 2 makes `enabled`/`customCommand`/`useCtrlyokeStyle`
  machine-scoped; if they could vary per workspace, "the same idempotent end state" wouldn't be
  true and the ref-counting would still be needed.
- **Still keep the per-settings-file mutex** (`SettingsJsonMcpTracker.withMutationLock`) around
  the detect-and-install sequence, even though the ownership/ref-counting _around_ it goes away.
  Two hosts can still race on a machine's genuine first-ever install — two VS Code windows both
  opening for the first time, or the VS Code extension and a concurrently-running `ctrlyoke` CLI
  invocation. Without the lock, the loser of that race could read the winner's
  already-installed ctrlyoke command back out of the file and mistake it for the user's original
  baseline, permanently corrupting what `customCommand` (and therefore the eventual "restore")
  captures. The lock only needs to guard the whole detect-and-install sequence; it doesn't need
  the multi-owner bookkeeping the old lease used it for. The harness settings file and
  ctrlyoke's user settings are two different files, so they cannot be one filesystem transaction.
  Make the sequence crash-safe instead: under the harness-file lock, first return immediately
  when the harness already points at ctrlyoke; otherwise read the current command, and when it
  must be captured, persist `{ customCommand, useCtrlyokeStyle: false }` together as one
  provider-settings object **before** replacing the harness command. A crash after that first
  write is harmless — the next install sees the saved forward target and finishes the harness
  write. Never replace the harness command first, because a crash before saving the capture would
  lose the only copy of the user's command. When there is no command to capture, leave
  `useCtrlyokeStyle` untouched (its fresh-install default is already `true`, and later user edits
  must survive a reinstall).
- Keep `SettingsJsonMcpTracker`'s existing value-lease pattern exactly as-is for anything that
  genuinely does need per-workflow restore (MCP servers, the `permission` key) — this change is
  scoped to the `statusLine` key only.
- The activation-time `pruneOrphanedStatusLine` sweep and its on-disk owner file become
  unnecessary for `statusLine` specifically once there's no more "restore when the last owner
  exits" to recover from a crashed owner. Remove them for this key rather than keeping now-dead
  code around.

This is worth calling out explicitly during implementation review since it's a net deletion of
a fair amount of machinery, not just new settings plumbing.

No migration/upgrade-compat concern here — pre-release, no existing users to protect (project
`CLAUDE.md`: "Pre-release — No backward compatibility constraints"). Just delete the now-dead
`.ctrlyoke-lease-statusLine.json` / on-disk owner-state sidecar file for the `statusLine` key as
part of the Phase 2 rewrite, since it's clutter once the ref-counted lease is retired for this
key — a tidiness cleanup, not a correctness requirement.

## Wrapper Script Consolidation

`src/scripts/ctrlyoke-claude-statusline.js` and `ctrlyoke-antigravity-statusline.js` already
duplicate atomic snapshot-write and forward-with-timeout logic, and have already drifted:
Claude's forward uses `spawnSync(..., { timeout: 500 })`, Antigravity's uses
`spawn(..., FORWARD_TIMEOUT_MS = 200)` — no documented reason for the difference, and
Antigravity's 200ms was specifically chosen to stay under its ~300ms poll cadence per
`ANTIGRAVITY_STATUSLINE_TOKEN_TRACKING_PLAN.md`; Claude's 500ms default was never justified
against Claude's own statusline refresh cadence.

Adding a Claude branded line (Decision 7) and a shared `useCtrlyokeStyle` switch (Decision 6)
to both scripts is exactly the kind of change that will drift further if done twice. Extract a
shared flat sibling module (`src/scripts/ctrlyoke-statusline-wrapper.js`, plain Node/CommonJS to
match how these scripts already ship standalone under `out/scripts/`) providing:

- `writeSnapshotAtomic(directory, filePrefix, token, payload, writtenAt)` — the
  write-temp-then-rename logic, currently near-identical in both files. The provider-supplied
  prefix is required to preserve the existing `claude-statusline-<token>.json` and
  `agy-statusline-<token>.json` transport contracts; a shared helper cannot infer that filename
  from `directory` and `token` alone.
- `forwardToCommand(command, inputBytes, timeoutMs)` — spawn-with-timeout, one implementation,
  using **200 ms for both wrappers**. That value is already justified by Antigravity's ~300 ms
  poll cadence; there is no evidence supporting Claude's accidental 500 ms variant, and the
  faster shared bound is safe for both statusline refresh paths.
- A provider-parameterized branded-line formatter, generalizing
  `formatBrandedStatusLine`/`getContextValues`/`getQuotaPercentage` out of the Antigravity
  script so Claude's version can reuse the same context/quota-percentage-bar formatting instead
  of hand-rolling a second one.

Keep it flat unless the copier is deliberately rewritten: `esbuild.js`'s current `copy-scripts`
plugin enumerates only the immediate children of `src/scripts/` and calls `copyFileSync` on each,
so a `src/scripts/shared/` directory would fail the build rather than be copied recursively.
Verify early (Phase 1) that `out/scripts/ctrlyoke-statusline-wrapper.js` is carried alongside the
two entry scripts — these run as detached Node processes outside the extension's module graph,
so this is a build-config check, not an assumption to carry into later phases.

## UI Placement

Per your ask:

- **Enable/disable toggle**: in `StatsUsageSection.tsx`, inside the existing per-harness loop
  (`StatsUsageSection.tsx:182-194`), rendered next to `<UsageCard>` — only for
  `HARNESS_IDS.CLAUDE_CLI` and `HARNESS_IDS.ANTIGRAVITY_CLI` (the only two harnesses that write
  a global statusline command). A new `StatusLineTrackingControls` component, parameterized by
  harness id, keeps this from being two hand-written blocks.
- **Custom-command field + style-override checkbox**: inside/below `UsageCard.tsx`, in the same
  conditional slot — a text input bound to `customCommand`, pre-filled from the auto-detected
  value, and the `useCtrlyokeStyle` checkbox. Simplification: only show the style-override
  checkbox once `customCommand` is non-empty — with no custom command configured, ctrlyoke's
  branded line is the only sensible output anyway, so the toggle has nothing to choose between
  yet. (This hides UI, it doesn't remove the stored setting.)
- **Disable confirmation dialog**: build it on `Modal` (`src/ui/webview-react/components/shared/Modal.tsx`)
  the same way `DeleteConfirmModal.tsx` does — `size="sm"`, a two-button `footer`
  (`Cancel` / a destructive-styled confirm, e.g. `variant="danger"` matching
  `DeleteConfirmModal`'s `Delete` button), warning copy from Decision 5 in the body. **One
  confirm action, not two.** Rather than a separate "restore" button, follow
  `DeleteConfirmModal`'s existing checkbox-next-to-the-action pattern (its "Don't ask me again"
  checkbox, `DeleteConfirmModal.tsx:71-85`) but have the checkbox modify what the single confirm
  button does, not gate re-asking: a checkbox rendered in the footer immediately to the left of
  the confirm button, only when `customCommand` is non-empty (nothing to offer otherwise),
  **checked by default** — restoring is the behavior this whole design exists to make safe, so
  default to the preserving choice rather than making the user notice and opt in. Confirm always
  disables tracking; it additionally writes `customCommand`'s current value back to the settings
  file (instead of deleting the key) only when the checkbox is checked. One outbound message
  carries both the disable action and the checkbox's boolean (e.g.
  `{ type: MESSAGE_TYPES.DISABLE_STATUS_LINE_TRACKING, provider, restoreCustomCommand }`) — no
  separate one-shot restore message or second button needed; simpler than the plan's earlier
  draft of this dialog.
  **Wording**: never "restore previous"/"restore old" on the checkbox label or the body copy —
  name the actual value being restored so the user sees exactly what they're getting back. Use
  the command's basename when it looks like a plain script path (e.g. checkbox label `Restore
ctrlyoke-old-line.js as the statusline command`); when `customCommand` isn't a clean path (has
  flags/args, or doesn't parse as one), fall back to the full command string, truncated with a
  tooltip carrying the untruncated value (e.g. `Restore "node C:/tools/my-line.js --compact" as
the statusline command`).

## Install Notification

Fires whenever the idempotent install step (Architecture Impact above) actually **writes**
`statusLine` — i.e. the transition from "not ctrlyoke's command" to "now ctrlyoke's command" —
never on a no-op call where it was already installed. Because Decision 4 means that write only
ever happens once per provider per machine (install, then leave it alone until an explicit
disable/re-enable), the write-happened condition **is** the one-time-per-provider condition —
no separate "have we already shown this" flag needs to be tracked or persisted. The scenario you
raised is exactly why this has to be checked per provider, not globally: install ctrlyoke → run
Claude workflows for months → install Antigravity later → the Claude notification already fired
long ago, but the Antigravity install step still hasn't performed its write yet, so its
notification fires then, on its own schedule, independent of Claude's. "One-time" here means
one-time-per-write, not one-time-ever-persisted: if a user disables tracking and later
re-enables it, that re-enable performs a fresh install write (Decision 4) and should fire the
notification again — don't add a separate persisted "already notified, never again" flag that
would incorrectly suppress it on a legitimate re-install.

Reuse the existing host-agnostic feedback pipeline instead of building a new one:
`notifyUserFeedback(sink, severity, message)` (`src/core/UserFeedbackSink.ts:23-34`) already
has exactly this shape — `CliIntegration` already holds a `UserFeedbackSink | undefined`
(`CliIntegration.ts:210`) and already calls `notifyUserFeedback` once per condition for a
similar one-time case (`notifyHeadlessPermissionWarningOnce`-style guard at
`CliIntegration.ts:1513-1517`). `sink?.notify(...)` is a safe no-op when the current host has no
feedback surface, which is exactly right for the CLI/MCP-server hosts — no separate
CLI-vs-extension branching needed. Severity: `USER_FEEDBACK_SEVERITY.INFO`
(`DashboardConstants.ts:545-550`), not `warning` — this isn't a problem, it's an FYI. In VS Code
this renders as a native `showInformationMessage`; in the standalone webview it renders as a
toast via the existing `notifyUser`/`ToastViewport` path.

The install step already knows, from the same locked install sequence, whether it just captured a
pre-existing `customCommand` (Decision 6) — reuse that to pick the message so it matches what
the user is about to observe, rather than a single generic string:

- Nothing captured: _"ctrlyoke is now showing its own statusline for \<Claude/Antigravity\>.
  Settings → Usage to change this."_
- Existing script captured (`customCommand` populated, `useCtrlyokeStyle` defaulted to `false`):
  _"ctrlyoke is now managing your \<Claude/Antigravity\> statusline and forwarding to your
  existing script unchanged. Settings → Usage to change this."_ — reassuring rather than
  alarming, since Decision 6 already guarantees nothing visibly changed for this user.

Wiring: keep providers unaware of the feedback sink (matches today's separation — providers
don't currently import `UserFeedbackSink`); have the install step return whether it performed a
write and which branch (captured vs. not), and have the caller in `CliIntegration` — which
already owns `userFeedbackSink` — call `notifyUserFeedback` based on that result, mirroring how
`onProviderUsageUpdate` is already threaded down as a constructor-injected callback rather than
each provider reaching for a global.

## UX Risks Found In Review

- **Silent staleness of the forwarded custom command.** With `useCtrlyokeStyle: true` (the
  default), the custom command's stdout is discarded — it still runs, but nothing in the UI
  confirms it's still working. If the user later moves/renames/breaks that script (reinstalls a
  tool that manages it, changes machines and forgets to update the path, etc.), the forward
  silently starts failing and no one notices until the moment they disable tracking and expect
  "restore" to bring back a working statusline — at which point it doesn't, and there's no
  record of when it broke. Recommend the wrapper record forward outcome
  (`ok` / `failed` / `timed-out` / `not-configured`) and last-run timestamp into the snapshot
  it already writes, and surface that next to the `customCommand` field in the settings UI
  ("last ran successfully 2m ago" / "last attempt failed"). Cheap to add since the wrapper
  already knows the forward result; without it, `useCtrlyokeStyle: true` trades visible
  statusline breakage for invisible statusline breakage.
- **Discoverability and zero-surprise-on-install are now both handled correctly, by design, via
  Decision 6's computed default** — resolved during review: a brand-new user (nothing to
  capture) gets `useCtrlyokeStyle: true`, so ctrlyoke's branded line is the discoverability
  channel the Antigravity plan originally wanted ("sees the line change, has a concrete reason
  to go find the toggle"); a user who already had a working script gets `useCtrlyokeStyle: false`
  automatically, so they see **no visible change at all** the moment ctrlyoke starts managing
  it. A flat `true` default for everyone (the original draft of this plan) would have silently
  replaced already-configured users' statuslines on first install — worth remembering if this
  computed-default rule is ever "simplified" back to a flat default later; it's load-bearing,
  not cosmetic.
- ~~First-run confirmation, not just a settings toggle~~ — **resolved, folded in as Decision 9**:
  an install notification (toast/native notification) fires whenever ctrlyoke actually replaces
  a provider's `statusLine` value, not just once globally. See "Install Notification" below for
  the full design.

## Antigravity Weekly Quota Plumbing

Real, empirically-captured field shape (`ANTIGRAVITY_STATUSLINE_TOKEN_TRACKING_PLAN.md`'s
"Payload" section, captured from a live `agy --prompt-interactive` run, not a synthetic mock):

```json
"quota": {
  "3p-weekly": { "remaining_fraction": 0.991, "reset_time": "...", "reset_in_seconds": 283900 },
  "gemini-weekly": { "remaining_fraction": 1, "reset_time": "...", "reset_in_seconds": 604800 }
}
```

`ctrlyoke-antigravity-statusline.js`'s `getQuotaPercentage` already parses this generically
(iterates `Object.values(quota)`, reads `.remaining_fraction`) for the branded line — proof the
shape is trusted enough to build on. Nothing carries it into `HarnessQuotaSnapshot` today:
`AntigravityStatuslineSidecar.acceptSnapshot` only reads `snapshot.context_window`, and
`AntigravityUsageProvider` is a bare `ObservedOnlyUsageProvider` with no
`onProviderUsageUpdate` push port at all (unlike `ClaudeStatuslineSidecarDeps`, which already
has one).

Mirror `ClaudeUsageProvider.parseClaudeRateLimitWindows` (`src/core/harness/shared/usage/providers/ClaudeUsageProvider.ts:56-91`):

- Add `parseAntigravityQuotaSnapshot(snapshot)` to `AntigravityUsageProvider.ts`, iterating
  `quota`'s dynamic keys (don't hardcode `3p-weekly`/`gemini-weekly` — new plan tiers are
  plausible) into `HarnessUsageWindow[]`, mirroring the full shape
  `parseClaudeRateLimitWindows` builds, not just `percentUsed`: `used`/`percentUsed` from
  `(1 - remaining_fraction) * 100`, `limit: 100`, `remaining: remaining_fraction * 100`,
  `resetAt` from `reset_time` (normalize through the existing `normalizeUsageTimestamp`),
  `unit: HARNESS_USAGE_UNITS.PERCENT`, `confidence: EXACT` given it's a live provider payload.
  Since the keys are open-ended plan tiers rather than a fixed enum (unlike Claude's curated
  `five_hour`/`seven_day` table), there's no lookup table to draw `id`/`label` from — use the
  raw key as `id` and a humanized version of it as `label` (e.g. `3p-weekly` → "3P Weekly"),
  decided during implementation rather than pre-guessing every possible plan-tier string here.
- Add `onProviderUsageUpdate` to `AntigravityStatuslineSidecarDeps`, call it from
  `acceptSnapshot` alongside the existing context-window mapping.
- Give `AntigravityUsageProvider` a real `implements IHarnessUsageProvider` quota path (not
  bare `ObservedOnlyUsageProvider`) that ingests pushed snapshots the same way
  `ClaudeUsageProvider`/`ClaudeStatuslineSidecar` already do.
- Update `HARNESS_USAGE_TRACKING_PLAN.md`'s Phase 4 conclusion, which currently dismisses this
  as coming only from "the wrapper's synthetic test payload" — that characterization conflicts
  with the earlier, stronger, live-run evidence in `ANTIGRAVITY_STATUSLINE_TOKEN_TRACKING_PLAN.md`
  and should be corrected once this ships, not left contradicting itself.

## Phases

1. **Settings & schema (completed)**: nested `statusLineTracking.{claude,antigravity}` shape,
   defaults, `settings-schema.json`, `ConfigurationUtils.getStatusLineTrackingSettings(provider)`,
   `SETTING_PATHS` entries, relocation of `antigravityStatusLineTracking`, and machine-only
   scope enforcement on effective reads as well as writes. The existing flat script copier was
   verified and requires no packaging change; the shared wrapper remains a later-phase file.
   Implementation decision: workspace filtering is path-generalized and removes only forbidden
   subtrees/leaves, preserving allowed sibling values such as other `permissions` and
   `usageTracking` settings.
2. **Provider install/uninstall rewrite (completed)**: the shared tracker now exposes a typed,
   idempotent persistent-value install/uninstall pair for the `statusLine` key. Both providers
   use the shared `StatuslineManager`, which keeps capture-before-write, command parsing,
   restore/delete, and global settings paths single-sourced. Statusline leases, orphan pruning,
   and owner sidecars are no longer involved; MCP and permission leases remain unchanged.
3. **Custom-command auto-detect-once + live read + install notification (completed)**:
   `customCommand` and `useCtrlyokeStyle` are captured together before first install writes the
   harness file; providers read both settings live for every prompt and pass them to the wrapper
   environment. `CliIntegration` consumes the nominal provider install result after plan
   mutations apply and emits the per-harness info message only for actual writes. Race and
   cleanup-persistence coverage is included for both providers.
4. **Shared wrapper module + `useCtrlyokeStyle` + Claude branded line (completed)**: extracted
   the flat `ctrlyoke-statusline-wrapper.js`, added the style switch to both entry scripts,
   added Claude's branded line through the shared formatter, and standardized forwarding on the
   deliberate shared 200 ms timeout. Wrapper coverage verifies both providers' stdout, failure,
   timeout, malformed-input, side-effect, and atomic filename contracts.
5. **UI (host contract completed; React rendering remains queued)**: shared
   `DISABLE_STATUS_LINE_TRACKING` discriminator and typed harness-id payload, validated
   `WebviewMessageRouter`/`WebviewSettingsSync` routing through `StatuslineManager`,
   user-scope disable with restore/delete coordination, rollback/error feedback, full
   settings refresh, acknowledgment, and focused host tests are complete. The
   `StatusLineTrackingControls` component, `UsageCard.tsx` custom-command field and
   conditional style checkbox, and `Modal`-based disable-confirmation dialog remain for
   the next React step.
6. **Antigravity quota plumbing**: `parseAntigravityQuotaSnapshot`, sidecar push port,
   `AntigravityUsageProvider` real implementation, doc correction in
   `HARNESS_USAGE_TRACKING_PLAN.md`.

## Open Questions

None blocking. The restore-button wording question is resolved in UI Placement above (name the
actual value, never "previous"/"old" — applies whether the value is ctrlyoke's original capture
or something the user has since hand-edited into the field; it's the same action either way, so
the wording doesn't need to distinguish the two).
