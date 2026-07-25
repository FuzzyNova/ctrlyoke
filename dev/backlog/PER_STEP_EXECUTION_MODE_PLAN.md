# Per-Step Execution Mode — move headless/interactive from settings into the workflow

Status: **Proposed (2026-07-25).** Not implemented. Interlocks with
[`SCRIPT_OUTPUT_UNIFICATION_PLAN.md`](./SCRIPT_OUTPUT_UNIFICATION_PLAN.md) — see
"Relationship to the Script Output Unification plan".

## Problem

Execution mode is a single global switch. `settings-schema.json` declares
`execution.mode: "interactive" | "headless"`, and every runtime consumer reads it
from that one place:

| Consumer                                    | Site                              | Reads                                        |
| ------------------------------------------- | --------------------------------- | -------------------------------------------- |
| CLI harness dispatch (interactive vs exec)   | `CliIntegration.ts:846`           | `this.getExecutionMode()`                    |
| Inject-mode gate                             | `CliIntegration.ts:1643`          | `this.getExecutionMode()`                    |
| Session-activity watcher resume              | `CliIntegration.ts:564`           | `this.getExecutionMode()`                    |
| Headless permission warning                  | `CliIntegration.ts:1334`          | `this.getExecutionMode()`                    |
| Script step PTY vs child process             | `WorkflowExecutor.ts:899`         | `ConfigurationUtils.getCliExecutionMode()`   |
| Output/Terminal auto-focus                   | `useMessageHandler.ts:825`        | `globalSettings.executionMode`               |
| Output header toggle                         | `OutputSectionHeader.tsx:309-320` | `globalSettings.executionMode`               |
| CLI binary                                   | `cli.ts:312`                      | `--headless` / `--interactive` / TTY sniff   |

So a workflow cannot say "plan headlessly, implement interactively, then lint and
commit headlessly." The user flips one toggle for the whole run, and the setting
is workspace-global, so it leaks across workflows.

`executionMode` is also the only major execution property missing from
`ExecutionProperties` (`CtrlYokeTypes.ts:123`). Harness, model, agent, skills,
resumeSession, mcpServers, hooks, priorContext, additionalArgs, toolPermissions,
errorBehavior, and both conditions are all three-tier resolvable. Mode is the
odd one out — which is also why it sits under `execution.*` in settings instead
of under `defaults.*` with the rest of the `ExecutionProperties` mirror.

## Goal

`executionMode` becomes an ordinary `ExecutionProperties` field resolved
prompt → workflow → settings by `PropertyResolver`, surfaced as an explicit
dropdown on the **Harness** page of both drawers, and consumed per execution
session instead of per integration instance.

The global setting **moves** from `execution.mode` to `defaults.executionMode`,
joining the block whose own description is "Default execution properties applied
to all new workflows (mirrors ExecutionProperties)". What goes away is the
transient toggle in `OutputSectionHeader` — mode stops being a live switch and
becomes part of the saved workflow definition.

Non-goals: changing inject-mode semantics, changing PTY lifecycle, or giving
pre/end-conditions their own mode (see the recommendation below).

## Contract

### `ExecutionProperties`

```ts
/**
 * Where this step runs.
 * - "interactive": live PTY/TUI — user can steer and answer questions
 * - "headless": background child process — output in the Output panel
 * - undefined: inherit from workflow, then settings (defaults.executionMode)
 *
 * Not nullable: there is no "no mode" state, so the tri-state null pattern
 * used by agent/skills/additionalArgs does not apply.
 */
executionMode?: ExecutionMode;
```

`ExecutionMode` and `EXECUTION_MODES` already exist in `DashboardConstants.ts:717`
and are already exported through `WebviewMessageTypes.ts:84`. No new constant.

`ResolvedProperties` (`PropertyResolver.ts:24`) gains a **required**
`executionMode: ExecutionMode`, filled by a new `resolveExecutionMode()` in the
same shape as `resolveResumeSession` (`PropertyResolver.ts:281`): prompt →
workflow → `ConfigurationUtils.getCliExecutionMode()`.

### Settings: move `execution.mode` → `defaults.executionMode`

Pre-release, no back-compat constraint, and two homes for one value would violate
the single-source rule. Move it rather than duplicate it.

`settings-schema.json`, in `properties.defaults.properties` (after `skills`,
before `resumeSession`, matching the drawer's field order):

```json
"executionMode": {
  "type": "string",
  "enum": ["interactive", "headless"],
  "description": "Default execution mode for new workflows. 'interactive' spawns a live terminal (TUI) the user can steer; 'headless' runs in the background with output in the Output panel. Workflows and individual steps can override this."
}
```

Delete `properties.execution.properties.mode`. `execution` keeps `injectMode`,
`maxPromptTimeout`, `scriptTimeout`, `closeTerminalOnComplete`, and
`autoDeleteTempFiles`.

**No migration code.** `settings-schema.json` is wired up only as a
`jsonValidation` association (`package.json:704-709`) — it drives editor
squiggles, not runtime parsing. `CtrlYokeConfigService` deep-merges whatever JSON
it finds and ignores unknown keys, so a stale `execution.mode` after the move is
inert: `getCliExecutionMode()` reads `defaults.executionMode`, misses, and falls
back to `CTRLYOKE_SETTINGS_DEFAULTS`. (The existing user-scope file already
carries several unschema'd keys — top-level `harness`, `chat`,
`permissions.copilotAllowAllPaths` — and has never caused a problem.)

Instead, Phase 1 hand-edits the one file that has the key:
`C:\Users\natha\.ctrlyoke\settings.json` — move `execution.mode: "interactive"`
to `defaults.executionMode: "interactive"`. Neither `c:\dev\ctrlyoke` nor
`c:\dev\fuzzno` has a workspace-scope `.ctrlyoke/settings.json`, so that is the
complete list.

Deliberately **not** writing a throwaway migration as practice for the real one:
a genuine release migration is a different shape (versioned, idempotent, run once
across files this repo will never see), and a one-off written now would be
deleted before it taught anything. Build migration infrastructure when there is a
second thing to migrate.

### Where the resolved value is consumed

The core change is that `CliIntegration.getExecutionMode()` stops being the
authority. It becomes the *fallback* used when there is no session:

```ts
private sessionExecutionMode(session: CliExecutionSession): CliExecutionMode {
  return session.resolvedProperties?.executionMode ?? this.getExecutionMode();
}
```

Call-site changes:

- `runExecutionSession` (`:846`) → `sessionExecutionMode(session)`.
- `sendPrompt` (`:1643`) → `sessionExecutionMode(executionSession)`; the session
  is already created at that point (`:1637`), so no reordering is needed.
- `resumeSessionActivityWatcher` (`:564`) → takes the mode from the finishing
  session (it is already called with `executionSession.resolvedProperties`
  fields at `:1668`), so pass the mode in rather than re-reading config.
- `warnIfHeadlessWithoutPermissions` (`:1334`) → takes the mode as a parameter;
  it is only called from the headless branch at `:985` and already receives the
  resolved permissions there.
- `WorkflowExecutor.executeScriptStep` (`:899`) → resolve the script step's own
  mode instead of `ConfigurationUtils.getCliExecutionMode()`.

`CliAdapter.getConfig("cliExecutionMode")` (`CliAdapter.ts:78`) stays as the
bottom-tier fallback and is what `CommitMessageGenerator.ts:159` uses to force
headless — that path has no workflow, so it is unaffected.

### Mixed-mode transitions already work

The two transitions a mixed workflow creates are both already implemented:

- **interactive → headless** on the same session:
  `retireInteractivePtyBeforeHeadlessResume` (`CliIntegration.ts:1035`) kills the
  live TUI before a headless `--resume` of the same session ID.
- **headless → interactive**: no PTY exists, so `shouldUseInjectMode` returns
  false (`getLastInteractiveContext()` is null) and a fresh TUI spawns.

Inject mode needs no new incompatibility reason: it is gated on `isInteractive`
before `shouldUseInjectMode` is consulted (`:854`), and the headless step in
between retires the PTY, clearing `lastInteractiveContext`.

### CLI binary: `--headless` is a clamp, not a tier

`cli.ts:312` resolves mode from flags then TTY. A workflow that declares
`executionMode: "interactive"` cannot honour that in CI where there is no TTY.

Rule: **an explicit `--headless` flag, or the absence of a TTY on stdout+stdin,
forces headless for every step regardless of what the workflow says**, and logs
one warning naming the steps it downgraded. Only `--interactive` and the
TTY-detected default leave the workflow's own values in effect.

Implement as a clamp inside `PropertyResolver.resolveExecutionMode` fed by a
process-level capability flag (set from `cli.ts` the same way
`cliExecutionMode` is written into the config overlay today at `cli.ts:345`), so
one function owns the rule and the dashboard/CLI/hosted-server paths cannot
diverge. The hosted-server dashboard uses the same clamp when it cannot host a
PTY.

Note that the CLI binary already forces script steps headless independently:
`spawnScriptPty` is `isCli() ? undefined : …` (`WorkflowInstance.ts:2884`), and
`executeScriptStep` falls through to the child-process path whenever it is
absent. The clamp makes that behavior explicit rather than incidental.

## Pre-existing defect: interactive script steps degrade their comparison

**Yes — the current `scriptStep` type is already partially broken in interactive
mode.** This is not hypothetical, and it is worth fixing as part of Phase 2
because the fix is small and this plan makes interactive script steps far more
likely to be used.

What happens today. `executeScriptStep` runs the script in a PTY when interactive
(`WorkflowExecutor.ts:903`) and then, because a PTY has no separate stderr
stream, synthesises the `EvaluationResult` from the exit code alone
(`:936-951`):

```ts
const passed = EndConditionEvaluator.evaluateExitCodeResult(
  exitCode, step.returns, step.compareSource
);
evalResult = { passed, stdout: outputChunks.join(""), stderr: "", … };
```

`evaluateExitCodeResult` (`EndConditionEvaluator.ts:52`) handles `exitCode` and
boolean `auto` correctly, then ends with an unconditional
`return exitCode === 0` for everything else. Divergences against the headless
path, which routes the same step through `evaluateCondition` with
`compareSource: step.compareSource ?? "exitCode"` and `returns: step.returns ?? "0"`:

| Step config                                  | Headless verdict          | Interactive verdict | Same? |
| -------------------------------------------- | ------------------------- | ------------------- | ----- |
| no `returns` / `compareSource`                | exit 0                    | exit 0              | ✅    |
| `compareSource: exitCode`, `returns: "2"`     | exit code == 2            | exit code == 2      | ✅    |
| `auto` + `returns: "true"`/`"false"`          | exit code                 | exit code           | ✅    |
| `compareSource: stdout`, `returns: "PASS"`    | stdout match              | **exit 0**          | ❌    |
| `compareSource: stderr`, `returns: "…"`       | stderr match              | **exit 0**          | ❌    |
| `auto` + non-boolean `returns` (e.g. `"80"`)  | stdout numeric ≥/substring | **exit 0**         | ❌    |

Three further interactive-only losses, all in the same block:

1. **`stderr` is always `""`** in the persisted `ScriptRuntimeOutput` (`:957`),
   so history and prior context lose the split.
2. **ANSI codes survive into persisted output.** `outputChunks.push(chunk)`
   (`:876`) stores raw PTY bytes; only the display string is stripped (`:980`).
   `scriptRuntimeOutput.stdout` — which feeds `cacheRuntimeOutput` and therefore
   downstream prior context — keeps the escape sequences.
3. **`timeout` is ignored.** `spawnScriptPty` takes no timeout parameter
   (`WorkflowExecutor.ts:159-170`), so `step.timeout` / `execution.scriptTimeout`
   apply only in headless mode.

Why it has stayed latent: pre-release with a single developer who uses `exitCode`
on every script step, and the default step (no `returns`, no `compareSource`)
agrees across both paths anyway. The defect is confined to output-comparing
script steps run interactively — a combination that has never shipped. Fix it now
because this plan makes interactive script steps a first-class, discoverable
choice rather than a global-toggle accident.

**Fix, in Phase 2:**

- Feed the accumulated PTY output through `sanitizeTerminalOutput`
  (`src/utils/TerminalOutputSanitizer.ts`) and pass it as `stdout` into the same
  `checkResult` comparison the headless path uses, instead of calling
  `evaluateExitCodeResult`. That makes `stdout` and `auto`-with-non-boolean
  agree across modes, and fixes losses 1's display half and 2 at the same time.
- `compareSource: "stderr"` genuinely cannot work under a single PTY. Detect it
  at dispatch, log one warning, and run that step headless. A step that wants to
  compare stderr is not a step that wants a terminal.
- Pass `timeout` through to `spawnScriptPty` and kill the PTY on expiry.

The same argument is why conditions stay headless — see the next section.

## Recommendation on pre-conditions and end-conditions

**Keep them always headless. Do not give them a mode, and do not have them
inherit the step's mode.**

Rationale:

1. **Interactive execution degrades the comparison.** Exactly the defect
   documented above. The Phase 2 fix narrows it to `stderr` only, but the
   remaining loss is real, and conditions are precisely the feature where
   `compareSource` matters most.
2. **Retry loops multiply the cost.** `endCondition.maxRetries` can be -1
   (unlimited). Spawning and tearing down a terminal per attempt is a poor
   experience and fights the terminal-session model, which is keyed per workflow.
3. **The escape hatch already exists and is better.** A user who genuinely wants
   an interactive gate should use a **script step** with
   `executionMode: "interactive"` — a first-class queue step, visible in the
   steps panel, with `onPass`/`onFail` and a real terminal. The only thing it
   lacks versus a pre-condition is `skipPrompt`, and `stopWorkflow` covers the
   realistic interactive-gate case ("confirm before I continue").
4. **It keeps the mental model one sentence long.** *"executionMode controls
   where the step itself runs; conditions always run headless and stream into the
   Output panel."* The alternative needs a paragraph and a caveat about
   `compareSource`.

The dropdown's help text and the schema description both state this explicitly so
nobody has to infer it.

If a finer-grained override is ever wanted, the clean place is an
`interactive?: boolean` on `scriptProperties` in the schema — shared by
`endCondition`, `preCondition`, and `scriptStep` — honoured in exactly one place
(the `ScriptExecutionReporter` the Script Output Unification plan introduces).
Strictly additive; nothing here forecloses it. Do not build it now: it costs a
fourth control on the Validation page for a use case nobody has asked for.

## UI

### Global settings — `DefaultsHarnessPage.tsx`

The mode row moves here from `ExecutionSection`. Add a bordered section between
`HarnessesSection` and the existing "Agent & Skill Defaults" block
(`DefaultsHarnessPage.tsx:43`), using the same
`SettingInputRow` + `CustomSelect` + `rowProps` pattern already in the file:

```tsx
<div className="border-t border-panel-border pt-4 space-y-3">
  <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
    Execution Defaults
  </h3>
  <SettingInputRow
    label="Execution mode"
    description="Where steps run by default. Interactive spawns a live terminal you can steer; headless runs in the background. Workflows and steps can override this. Pre/end-condition scripts always run headless."
    id="defaults-execution-mode"
    path="defaults.executionMode"
    {...rowProps}
  >
    <CustomSelect
      id="defaults-execution-mode"
      value={wf.executionMode}
      onChange={(v) => onUpdate("defaults.executionMode", v)}
      options={EXECUTION_MODE_OPTIONS}
    />
  </SettingInputRow>
</div>
```

`ExecutionSection.tsx:38-50` loses its "Execution mode" row and its local
`MODE_OPTIONS` const. Promote those options to a shared
`EXECUTION_MODE_OPTIONS` (derived from `EXECUTION_MODES`) so the settings page
and both drawers use one list — three call sites is exactly where a literal
array stops being acceptable.

### Workflow level — `WorkflowPropertiesPanel.tsx`

New field on the **Harness** page (`DRAWER_PAGES.HARNESS`), added as Row 3 next to
Additional Args, which currently sits alone with a `<div />` spacer
(`WorkflowPropertiesPanel.tsx:1111-1145`) — the spacer becomes the new field, so
the grid needs no restructuring.

```
Row 1: Harness         | Model
Row 2: Agent           | Skills
Row 3: Additional Args | Execution Mode
```

- `CustomSelect` with `EXECUTION_MODE_OPTIONS`, wired through
  `getEffectiveExecutionMode()` (new selector in `settingsStore`, same shape as
  `getEffectiveResumeSession`).
- `SetAsDefaultButton` with `isDifferentFromGlobal("executionMode")` — falls into
  the default `globalValue` comparison branch (`:380`), no special case needed.
- `handleResetAllToDefault` (`:807`) gains
  `executionMode: globalSettings.executionMode`.

### Prompt level — `PropertiesDrawer.tsx`

Same row, three states, following the `Additional Args` / `Prior Context`
`Inherit (X)` pattern already used on that page:

```
Inherit (Headless)   ← resolves workflow → global, label built like defaultHarnessLabel
Interactive
Headless
```

- `resolvedExecutionMode = workflowProperties.executionMode ?? globalSettings.executionMode`
  and `defaultExecutionModeLabel = \`Inherit (${…})\``, alongside the other
  resolved labels at `PropertiesDrawer.tsx:121-190`.
- `onChange`: `"default"` → `setProperty("executionMode", undefined)`, otherwise
  the literal mode. No `null` state — see the contract note.
- `handleResetAllToInherit` (`:98`) gains
  `setProperty("executionMode", undefined)`.

### Removed — `OutputSectionHeader.tsx`

Delete the `IconToggleButton` block (`:309-320`) and the
`executionModeInteractive` / `onExecutionModeToggle` props. Delete
`handleExecutionModeChange` and the `executionModeScope` selector in
`OutputSection.tsx:176-193`, and drop both props at the render site (`:1116`).
Update `test/components/layout/OutputSectionHeader.test.tsx:15`.

`MESSAGE_TYPES.CHANGE_EXECUTION_MODE` (`DashboardConstants.ts:87`),
`WebviewMessageRouter.ts:1020`, and
`WebviewSettingsSync.handleExecutionModeChange` (`:457`) become dead once the
header toggle goes — the header used `UPDATE_GLOBAL_SETTING`, not this message,
and grep shows no other sender. Delete all three with the header.

### Steps panel badge

`WorkflowStepsPanel.tsx:434` renders per-step override badges (the
`additionalArgs` case is the model). Add an `executionMode` badge —
`codicon-debug-console` for interactive, `codicon-terminal` for headless — shown
only when `step.executionMode !== undefined`. This is what makes a mixed-mode
workflow legible at a glance and is the main reason to prefer an explicit
dropdown over the old ambient toggle.

### Auto-focus follows the step, not the settings

`useMessageHandler.ts:825` currently picks the Output vs Terminal tab from
`globalSettings.executionMode` at run start. That must become per-step: the
execution-start message already carries `isInjectMode`, so add the resolved
`executionMode` for the step being started and branch on it. Without this, a
mixed workflow focuses the wrong tab for every step after the first.

## Plumbing checklist

Every property added to `ExecutionProperties` has to be threaded through the same
places. Missing any one silently drops the value on save/load.

**Workflow property (Phase 1):**

| File | Change |
| ---- | ------ |
| `types/CtrlYokeTypes.ts:123` | `executionMode?: ExecutionMode` on `ExecutionProperties` |
| `utils/PropertyResolver.ts:24,106` | `ResolvedProperties.executionMode` + `resolveExecutionMode()` + CLI clamp |
| `schemas/workflow-schema.json` | `definitions/executionProperties` **and** `definitions/scriptStep` (the latter is `additionalProperties: false` and does not `$ref` executionProperties, so it needs its own copy) |
| `core/orchestration/PromptFileLoader.ts:345` | seed `defaults.executionMode` in `populateSettingsDefaults` |
| `core/WorkflowStepSanitizer.ts:365,564` | `sanitize…` allowlist + `buildPromptStepProperties` (plain enum — use `coerce`) |
| `ui/WorkflowStepHandlers.ts:300` | add to the `raw` workflow-properties map |
| `ui/webview-react/store/settingsStore.ts:123` | `WorkflowProperties.executionMode` + `getEffectiveExecutionMode()` |

**Settings move (Phase 1):**

| File | Change |
| ---- | ------ |
| `schemas/settings-schema.json` | add `defaults.executionMode`; delete `execution.mode` |
| `types/CtrlYokeSettings.ts:36,75,293` | move the field in the interface and in `CTRLYOKE_SETTINGS_DEFAULTS` |
| `utils/ConfigurationUtils.ts:69,535,898` | `EXECUTION_MODE` key → `"defaults.executionMode"`; `getCliExecutionMode` reads `CONFIG_KEYS.DEFAULTS` |
| `C:\Users\natha\.ctrlyoke\settings.json` | hand-move `execution.mode` → `defaults.executionMode` (only file with the key; no migration code) |
| `ui/webview-react/components/settings/ExecutionSection.tsx:38-50` | remove the row + local `MODE_OPTIONS` |
| `ui/webview-react/components/settings/defaults/DefaultsHarnessPage.tsx:43` | add the "Execution Defaults" section |

`WebviewSettingsSync.buildGlobalSettings` already emits `executionMode` (`:757`)
via `ConfigurationUtils.getCliExecutionMode()`, so it needs no change once that
getter points at the new path. `WorkflowSerializer` needs no change — it does not
enumerate execution properties.

## Phasing

**Phase 1 — contract + settings move.** Both tables above, including the
hand-edit of the user-scope settings file. No behavior change:
`resolveExecutionMode` returns the global value for every existing workflow.
Gate: `npm run typecheck`, `PropertyResolver.test.ts`,
`CtrlYokeConfigService.test.ts` (its `execution.mode` assertions at `:43`, `:68`,
`:94-99`, `:162-171`, `:309-311` all move to `defaults.executionMode`), and
`PromptFileLoader.test.ts`.

**Phase 2 — consumption + script-step fix.** `sessionExecutionMode` in
`CliIntegration` and the four call sites; `executeScriptStep`'s mode source; the
interactive comparison fix, `stderr` headless fallback, and PTY timeout; the CLI
clamp in `cli.ts`. Manual test: a hand-edited YAML with
`executionMode: interactive` on step 2 of three.

**Phase 3 — UI.** Both drawers, the `DefaultsHarnessPage` row, the shared
`EXECUTION_MODE_OPTIONS`, the steps-panel badge, the per-step auto-focus fix, and
deletion of the header toggle + `CHANGE_EXECUTION_MODE` message path.

**Phase 4 — tests.** Below.

Phases 1–2 ship independently and are useful on their own for CLI users. Phase 1
is mechanical; Phase 2 is where the judgment is.

## Testing

Extension host (`src/test/**`):

- `PropertyResolver.test.ts` — prompt over workflow over settings; `undefined`
  inherits; the CLI clamp forces headless over an explicit workflow
  `interactive` and leaves `headless` alone.
- `CtrlYokeConfigService.test.ts` — the moved path (existing assertions
  retargeted; no migration case, since there is no migration).
- `PromptFileLoader.test.ts` — `populateSettingsDefaults` seeds `executionMode`
  and does not overwrite an explicit value.
- `WorkflowStepSanitizer` — a step-level `executionMode` survives a sanitize
  round-trip; an invalid string is dropped.
- `CliIntegration.test.ts` — a session whose `resolvedProperties.executionMode`
  is `interactive` takes `executeInteractive` while the global setting is
  `headless`, and the reverse; inject mode is skipped for a headless step.
- **New** `interactiveScriptStep.test.ts` — the parity table above, asserted as a
  matrix: for each `compareSource`/`returns` combination, the interactive and
  headless verdicts agree (with `stderr` asserted to fall back to headless), and
  the persisted `scriptRuntimeOutput.stdout` contains no ANSI escapes.
- New mixed-mode integration test — three steps (headless / interactive /
  headless) on one workflow: the PTY is retired before step 3 and the step-2
  session ID is resumed headlessly.

Webview (`src/ui/webview-react/test/**`):

- `WorkflowPropertiesPanel` — dropdown renders the effective value; changing it
  posts `UPDATE_WORKFLOW_PROPERTY`; Set-as-Default appears only when it differs.
- `PropertiesDrawer` — three states; `Inherit (X)` label resolves through
  workflow then global; reset-all clears to inherit.
- `DefaultsHarnessPage` — the row renders, writes `defaults.executionMode`, and
  shows the correct scope/reset affordance.
- `OutputSectionHeader.test.tsx` — toggle assertions removed, not just skipped.
- `useMessageHandler` — the existing execution-mode auto-focus tests
  (`:2325`, `:2350`, `:2376`) move from the global setting to the per-step value
  on the execution-start message.

## Relationship to the Script Output Unification plan

They touch one common function: `executeScriptStep`. This plan changes where its
mode comes from and fixes its interactive comparison; the other plan moves the
whole body into `ScriptExecutionReporter`.

**Land this plan's Phases 1–2 first.** They are a surgical diff to a function the
other plan is about to rewrite, and doing it in this order means
`ScriptExecutionReporter` is extracted with the correct mode source and a correct
interactive path already in place. The reverse order bakes
`ConfigurationUtils.getCliExecutionMode()` and the exit-code-only synthesis into
the new reporter and immediately rewrites both.

Phase 3 (UI) is fully independent and can run in parallel with that plan's
Phases 0–2.

Two design points carry across:

- The other plan already mandates replacing the inlined ANSI regex
  (`WorkflowExecutor.ts:980`) with `sanitizeTerminalOutput`. This plan's Phase 2
  fix needs the same helper one layer earlier — on the accumulated PTY chunks,
  not just the display string. Do it once, in `TerminalOutputSanitizer`'s caller.
- Because conditions stay headless, the reporter's condition call sites always
  execute as child processes, so `ScriptVerdict` always has real stdout/stderr
  and a real comparison. Only the script-step call site needs a mode parameter.

## Risks

- **Silent drop on save.** Missing any row of the plumbing checklist means the
  dropdown appears to work and the value vanishes on reload. The sanitizer and
  the `WorkflowStepHandlers` `raw` map are the two most commonly forgotten.
- **Forgetting the settings hand-edit.** Harmless but confusing: a stale
  `execution.mode` is silently ignored and the effective mode falls back to
  `CTRLYOKE_SETTINGS_DEFAULTS.defaults.executionMode`. Only visible as an editor
  squiggle on the now-unschema'd key.
- **Interactive in a non-interactive host.** A workflow authored in VS Code and
  run via `ctrlyoke run` in CI will request a PTY that cannot exist. The clamp
  handles it; without the clamp, this hangs rather than fails.
- **Inject mode surprise.** A user with `execution.injectMode` on who inserts one
  headless step between two interactive steps loses TUI continuity across that
  boundary — the PTY is retired and respawned. Correct, but worth a line in the
  dropdown tooltip.
- **Terminal tab churn.** A workflow alternating modes every step spawns and
  retires a terminal per interactive step. Acceptable; the steps-panel badge
  makes the cost visible before the run starts.
