# "Waiting for Input" Notification Plan

**Status:** In progress — staged as a ctrlyoke workflow on 2026-10-26 (see "Orchestrator review").

> **2026-10-10 audit:** Not implemented — no `awaitingInput` setting, constant, or env var exists.
> The problem statement still matches the code (the per-harness table agrees with the `HookEvent`
> mapping comment in `DashboardConstants.ts`, and the two "enabled hook events" computations are
> still duplicated). Refreshed line numbers and pointed the workflow-schema reference at
> `schemas/workflow-schema.json`.
>
> Last reviewed against code: 2026-10-26. Still not started; refreshed line numbers and the
> location of `buildHookEnvVars` (`src/core/harness/shared/CliExecutionRunner.ts`) and
> `HookArtifact` (`src/ui/notifications/CompletionNotificationFactory.ts`; the OpenCode plugin
> keeps its own copy).

## Orchestrator review (2026-10-26) — corrections before building

Staged as four workflow steps: (1) verify the mapping and finalize this plan, (2) settings +
types + `HookNotificationPlan` resolver wiring, (3) hook-script / OpenCode-plugin emission,
(4) notification factory, dashboard toggle, docs and changelog. Corrections made while staging:

- **Copilot `notification` is noisy, so it needs a filter too.** The workspace
  `ctrlyoke-copilot-hook-debug.log` shows Copilot `notification` payloads with
  `notification_type` `agent_idle` and `shell_completed`. Neither means "waiting on you". The
  Copilot row must list its permission/elicitation types explicitly. An unfiltered
  `{ event: "notification" }` would fire on every idle and every finished shell.
- **The Claude filter is confirmed necessary.** The Claude hook-debug log has ~170
  `idle_prompt` notifications against 1 `permission_prompt`.
- **No schema bump.** `notifications.events.awaitingInput` is an optional field with a default,
  which is the "No bump" case in `CONTRIBUTING.md` ("Changing the schemas"). Run
  `npm run schema:update` only.
- **Default decided: `true`.** It is the notification users want, and it now costs only one native
  hook per harness. It changes what users see, so it needs a `CHANGELOG.md` entry under
  `## [Unreleased]`.
- **Missing from the touch list:** `src/ui/webview-react/components/settings/settingsCatalog.ts`
  (each setting key is catalogued there and checked by `settingsSchemaUiParity`),
  `docs/guide/notifications.md` (the hand-written page), and `CHANGELOG.md`.
- **Keep the `hooks: null` behaviour.** `ExecutionPlanBuilder` installs no notification hooks when
  a step sets `hooks: null`, and the resolver's `installEvents` must stay empty in that case.
- **Headless hook setup is not disabled.** `ExecutionPlanBuilder` passes enabled notification
  events to each provider's `planHeadlessUserHookArgs`; Codex, Claude, Copilot and Qwen install
  their notification hook configuration there. OpenCode's headless path serializes user hooks for
  its plugin, while the enabled native notification event list is currently ignored. Do not claim
  headless runs install no ctrlyoke notification hooks. Decide separately during implementation
  whether awaiting-input hooks should be installed headless; preserve existing raw-event behavior.

## Problem

The notification you actually want from a harness is "it is blocked waiting on me."
Today you can only get it by opting into raw hook events under
`notifications.events.hookEvents`, and the right raw event depends on the harness:

| Harness     | Fires when the user is actually asked                            | Fires on every tool call (noise)                      |
| ----------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| Copilot     | `notification` (permission / elicitation dialogs)                | `permissionRequest` (asks the active mode, even yolo) |
| Codex       | `permissionRequest`                                              | — (`notification` is n/a)                             |
| Claude      | `notification` (`permission_prompt`) **and** `permissionRequest` | — (turning both on double-notifies)                   |
| Qwen        | same shape as Claude                                             | —                                                     |
| OpenCode    | `permissionRequest` (`permission.asked`)                         | — (`notification` is n/a)                             |
| Antigravity | n/a                                                              | n/a                                                   |

Because `hookEvents` is one global switchboard, `permissionRequest` has to be on for
Codex and off for Copilot. Mixed-harness workflows can't be configured correctly.

There is also a cost beyond the spam. Enabling an event installs the native hook,
because `ExecutionPlanBuilder` passes `getEnabledHookNotificationEvents()` into each
provider's `planNotificationHookArgs`. With `permissionRequest` on, Copilot spawns a
`node ctrlyoke-copilot-hook.js` process on every tool call.

## Options considered

### A. Per-harness overrides of the raw events

Add `notifications.events.hookEventsByHarness: { "<harnessId>": Partial<Record<HookEvent, boolean>> }`,
layered over the global `hookEvents`. There is precedent for this: `defaults.models`,
`defaults.additionalArgs`, and `ui.harnessColors.byHarness` are all keyed by `HARNESS_IDS`.

- ✅ General. It fixes any raw-event quirk, not just this one.
- ❌ It makes every user learn each harness's hook semantics (the table above) before
  the most valuable notification works. The logical-event layer already exists to
  hold that knowledge, and this option pushes it back onto users.
- ❌ UI cost: an 8 events × 6 harnesses matrix, or a harness picker with override state.

### B. A derived, harness-normalized `awaitingInput` event ← **recommended**

Add one semantic event, "Waiting for input". ctrlyoke owns the mapping from each
harness's native signal to it, so one toggle is correct on every harness and needs
no per-harness configuration.

- ✅ It matches the user's intent directly and works for mixed-harness workflows.
- ✅ Only the one native hook each harness needs is installed, which fixes the
  Copilot hook spawned per tool call.
- ✅ It solves Claude/Qwen double-notifying, because the mapping chooses one source.
- ❌ The mapping is ours to maintain when a harness changes its hook semantics. That
  is already true of the logical-to-native mapping table in the doc comment on `HookEvent`
  in `DashboardConstants.ts`.

**Decision: build B. Defer A.** Raw `hookEvents` stay as-is for power users. Add A
only if raw-event quirks other than this one keep coming up after B ships. If A is
built later, use the shape above: sparse overrides keyed by `HARNESS_IDS`, not a full matrix.

## Design (option B)

### 1. Single-source mapping (TS)

New `src/core/harness/shared/HookNotificationPlan.ts`, or a table on each provider's
`config` if it fits the provider-capability pattern better:

```ts
interface AwaitingInputSource {
  event: HookEvent;                 // logical event whose native hook must be installed
  notificationTypes?: string[];     // filter on hookInput.notification_type, when event === "notification"
}
const AWAITING_INPUT_SOURCES: Record<HarnessId, AwaitingInputSource | null> = {
  "copilot-cli":     { event: "notification", notificationTypes: ["permission_prompt", "elicitation_dialog"] },
  "claude-cli":      { event: "notification", notificationTypes: ["permission_prompt", "elicitation_dialog"] },
  "qwen-cli":        { event: "notification", notificationTypes: ["permission_prompt"] },
  "codex-cli":       { event: "permissionRequest" },
  "opencode-cli":    { event: "permissionRequest" },
  "antigravity-cli": null,
};
```

Evidence for the finalized mapping (checked 2026-10-26):

| Harness | Source and allow-list | Evidence |
| --- | --- | --- |
| Copilot CLI | `notification`: `permission_prompt`, `elicitation_dialog` | [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference) lists both types and says `permissionRequest` runs before rule checks, auto-allow/auto-deny and user prompting. Existing `.ctrlyoke/logs/ctrlyoke-copilot-hook-debug.log` payloads show noisy `agent_idle` and `shell_completed`, so exclude them. A `permission_prompt` represents an actual permission prompt and is absent when yolo auto-approves; `elicitation_dialog` remains eligible. The installed npm JS bundle (`@github/copilot` 0.0.384, `index.js`) did not contain these event type strings, so the official hook reference is the source for the type list. |
| Claude CLI | `notification`: `permission_prompt`, `elicitation_dialog` | Installed native bundle `~/.local/share/claude/versions/2.1.311` contains the Notification type schema and enum values `permission_prompt`, `elicitation_dialog`, `idle_prompt`, and `auth_success` (among others). `.ctrlyoke/logs/ctrlyoke-claude-hook-debug.log` has repeated `idle_prompt` payloads (for example lines 5644–5666); allow-list only the two prompt types. [Claude Code hooks reference](https://code.claude.com/docs/en/hooks) documents `Notification`. |
| Qwen CLI | `notification`: `permission_prompt` | Installed `@qwen-code/qwen-code` bundle under `%APPDATA%/npm/node_modules/@qwen-code/qwen-code/chunks/chunk-YGSOH3UK.js` emits Notification payloads with `notification_type` and uses `permission_prompt` for permission prompts. `chunks/startInteractiveUI-H643FQJ2.js` emits `idle_prompt`; the first bundle also emits `auth_success`. No `elicitation_dialog` emission was found, so use the conservative single-type filter. |
| Codex CLI | `permissionRequest` | [Codex hooks reference](https://developers.openai.com/codex/hooks/) says `PermissionRequest` runs when Codex is about to request approval and does not run for commands that need no approval. `CodexToolPermissionMapper.ts` maps `allowAll` to workspace-write plus `on-request`, and dangerously allow-all to `--dangerously-bypass-approvals-and-sandbox`; already auto-approved calls do not invoke this request hook. |
| OpenCode CLI | `permissionRequest` | [OpenCode plugins reference](https://opencode.ai/docs/plugins/) lists `permission.asked`. [OpenCode permissions reference](https://opencode.ai/docs/agents/) defines `allow` as permitting operations without approval and `ask` as prompting. `OpenCodeToolPermissionMapper.ts` sets the allow-all catch-all to `allow` and emits no permission slice for dangerously allow-all; auto-approved calls therefore do not raise `permission.asked`. |
| Antigravity CLI | `null` | `DashboardConstants.ts`'s native hook mapping marks `notification` and `permissionRequest` as n/a for Antigravity (`src/types/DashboardConstants.ts`, lines 2516–2519); `AntigravityNotificationMonitor.ts` marks `notification` unsupported. |

**Step 2 implementation: complete.** Added this mapping to
`src/core/harness/shared/HookNotificationPlan.ts`, with separate installation
and raw-emission lists. `CliIntegration`, `ExecutionPlanBuilder`, and
`CliExecutionRunner` now use the shared resolver. Resolver and execution-plan
tests cover each harness, hook suppression, and Codex's installed-but-not-raw
case.

Codex `allowAll` is the Auto preset (`on-request`), not a blanket no-approval mode: operations Codex escalates can still trigger `PermissionRequest`. The claim above is that already auto-approved calls do not.

Then one resolver replaces the two places that currently compute "enabled hook
events" separately: `CliIntegration.getEnabledHookNotificationEvents()` (line ~1906)
and `CliExecutionRunner.buildHookEnvVars()` (`src/core/harness/shared/CliExecutionRunner.ts`,
line ~558), which duplicate each other today.

```ts
resolveHookNotificationPlan(harnessId, notificationSettings): {
  installEvents: HookEvent[];      // raw enabled ∪ awaitingInput source event
  emitRawEvents: HookEvent[];      // raw enabled only → CTRLYOKE_NOTIFY_HOOK_EVENTS
  awaitingInput?: AwaitingInputSource; // → CTRLYOKE_NOTIFY_AWAITING_INPUT
}
```

The key point is that **install** and **emit** are separate. For Codex with
`awaitingInput` on and raw `permissionRequest` off, the `PermissionRequest` hook is
installed but no raw `permissionRequest` artifact is written.

### 2. Hook scripts stay dumb

The TS resolver sends the rule to the scripts in a new env var, for example
`CTRLYOKE_NOTIFY_AWAITING_INPUT=notification:permission_prompt,elicitation_dialog`
or `=permissionRequest`. The harness mapping then lives only in TS, and nothing has
to be imported into `out/scripts/`.

In `ctrlyoke-hook-utils.js`, `maybeWriteHookArtifact` also checks the awaiting-input
rule (the logical event matches, and `notification_type` is in the list if one is
given). If it matches, it writes an artifact with `hookEvent: "awaitingInput"`.
**One artifact per native invocation:** if the raw event is also enabled, write only
the `awaitingInput` artifact, so the user doesn't get two notifications for one prompt.
The OpenCode plugin (`ctrlyoke-opencode-plugin.ts`) reads the same env var.

### 3. Settings + types

- `schemas/settings-schema.json`: `notifications.events.awaitingInput: boolean`, a
  sibling of `workflowComplete`/`promptComplete`, not inside `hookEvents`, because it
  is not a native hook event. The description should say the source is chosen per
  harness and that Antigravity has none.
- `CtrlYokeSettings.ts`: add it to `CtrlYokeNotificationSettings.events` and to the
  defaults. **Open question:** default `true`? It is the highest-value notification
  and cheap once it is scoped to one native hook. `hookEvents` stays opt-in.
- `DashboardConstants.ts`: add a `DERIVED_NOTIFICATION_EVENTS.AWAITING_INPUT` constant.
  Widen the `HookArtifact.hookEvent` union rather than adding `awaitingInput` to
  `HookEvent`/`HOOK_EVENT_ORDER`, because those drive the raw-event UI and user-hook
  enums.
- `CompletionNotificationFactory.buildHookNotificationEvent` gates on
  `settings.events.hookEvents[artifact.hookEvent]` (line ~359). Branch so that
  `awaitingInput` gates on the new setting. Title: "ctrlyoke - Waiting for input".
  Body: workflow/prompt name, tool name, and the notification message when there is one.

**Step 2 implementation: complete.** Added the optional `awaitingInput` setting
with default `true`, regenerated schema-derived files, added the derived event
and env-var constants, and widened `HookArtifact.hookEvent`. The notification
factory continues to ignore the derived artifact until step 4 implements its
notification behavior.

**Deviation:** `settingsSchemaUiParity.integration.test.ts` requires every
schema leaf to have a live dashboard control, so the minimal “Waiting for
input” toggle and updated raw-hook-events blurb were added in step 2 instead
of step 4. The schema generator also updated `docs/reference/settings.md`.

### 4. UI (`NotificationsSection.tsx`)

Add a "Waiting for input" toggle to the **Events** group, next to Workflow/Prompt
complete, not in the Hook Events list. Its description names the harnesses that
support it. Update the Hook Events blurb to point to it:
"Most people want _Waiting for input_ above; these are raw per-harness events."

### 5. (Optional, later) Workflow schema

`userHookConfig.event` in `schemas/workflow-schema.json` (`$defs/userHookConfig`) could accept
`awaitingInput` too, so one user hook script works on every harness without
per-step overrides. This is lower priority because step overrides already work
around it. It is a separate change because user hooks go through each provider's
`buildHookConfig` rather than the artifact path.

## Verification before building

Verification before building (completed 2026-10-26; static evidence used, no interactive probes):

1. [x] Copilot `notification`: GitHub's hook reference enumerates `permission_prompt` and `elicitation_dialog`; existing debug log payloads show noisy `agent_idle` and `shell_completed`, which the allow-list excludes. A permission notification represents an actual prompt and is absent when yolo auto-approves; elicitation dialogs remain eligible in yolo. The installed JS bundle did not include these event strings, so this relies on the official reference and event semantics.
2. [x] Claude: installed bundle and existing log confirm Notification `notification_type` payloads and frequent `idle_prompt`. Use only `permission_prompt` and `elicitation_dialog`; exclude `idle_prompt`, `auth_success`, and all other types. Qwen's installed bundle emits `permission_prompt`, `idle_prompt`, and `auth_success`; it does not show an `elicitation_dialog` emission, so its conservative allow-list is only `permission_prompt`.
3. [x] Codex `PermissionRequest` and OpenCode `permission.asked`: official event documentation defines these as request/ask events; provider permission mapping sets allow-all policies to auto-allow and dangerously allow-all to bypass/allow. Codex `allowAll` remains `on-request`, so only operations Codex escalates can still prompt.
4. [x] Headless assumption corrected: `ExecutionPlanBuilder.ts` passes enabled notification events to `planHeadlessUserHookArgs`. Codex, Claude, Copilot and Qwen use those events to configure native hooks; OpenCode ignores the event list in headless but can serialize user hooks into its plugin. Headless does not inherently disable ctrlyoke notification hooks. Decide whether the new awaiting-input hook is installed headless during implementation; do not rely on the earlier false claim.

## Touch list

- `src/core/harness/shared/HookNotificationPlan.ts` (new) + `CliIntegration.ts`,
  `CliExecutionRunner.ts`, `ExecutionPlanBuilder.ts` (use the resolver)
- `src/scripts/ctrlyoke-hook-utils.js`, `ctrlyoke-opencode-plugin.ts` (awaiting-input emission)
- `schemas/settings-schema.json`, `src/types/CtrlYokeSettings.ts`, `src/types/DashboardConstants.ts`
- `src/ui/notifications/CompletionNotificationFactory.ts`
- `src/ui/webview-react/components/settings/NotificationsSection.tsx`
- Tests: `NotificationHookScripts.test.ts` (env rule → artifact, and dedup),
  `ExecutionPlanBuilder.test.ts` (install vs emit), `CompletionNotificationFactory.test.ts`,
  `NotificationSettings.test.ts`, `settingsSchemaUiParity.integration.test.ts`,
  `NotificationsSection.test.tsx`
- Regenerate docs: `npm run schema:update` (runs `generate-schema-docs` among others). Also update
  `docs/harnesses/compatibility.md` through its generator if hook support is listed there.
