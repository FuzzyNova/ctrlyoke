# "Waiting for Input" Notification Plan

## Problem

The notification you actually want from a harness is "it is blocked waiting on me."
Today you can only get it by opting into raw hook events under
`notifications.events.hookEvents`, and the right raw event depends on the harness:

| Harness  | Fires when the user is actually asked                 | Fires on every tool call (noise)            |
| -------- | ----------------------------------------------------- | ------------------------------------------- |
| Copilot  | `notification` (permission / elicitation dialogs)     | `permissionRequest` (asks the active mode, even yolo) |
| Codex    | `permissionRequest`                                   | —  (`notification` is n/a)                  |
| Claude   | `notification` (`permission_prompt`) **and** `permissionRequest` | — (turning both on double-notifies) |
| Qwen     | same shape as Claude                                  | —                                           |
| OpenCode | `permissionRequest` (`permission.asked`)              | — (`notification` is n/a)                   |
| Antigravity | n/a                                                | n/a                                         |

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
  is already true of the `HOOK_EVENTS` table in `DashboardConstants.ts`.

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
  "copilot-cli":     { event: "notification" },  // verify: filter by notification_type?
  "claude-cli":      { event: "notification", notificationTypes: ["permission_prompt", "elicitation_dialog"] },
  "qwen-cli":        { event: "notification", notificationTypes: [...] },  // verify
  "codex-cli":       { event: "permissionRequest" },
  "opencode-cli":    { event: "permissionRequest" },
  "antigravity-cli": null,
};
```

Then one resolver replaces the two places that currently compute "enabled hook
events" separately: `CliIntegration.getEnabledHookNotificationEvents()` (line ~1855)
and `CliExecutionRunner.buildHookEnvVars()` (line ~535), which duplicate each other today.

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
  `settings.events.hookEvents[artifact.hookEvent]` (line ~351). Branch so that
  `awaitingInput` gates on the new setting. Title: "ctrlyoke - Waiting for input".
  Body: workflow/prompt name, tool name, and the notification message when there is one.

### 4. UI (`NotificationsSection.tsx`)

Add a "Waiting for input" toggle to the **Events** group, next to Workflow/Prompt
complete, not in the Hook Events list. Its description names the harnesses that
support it. Update the Hook Events blurb to point to it:
"Most people want *Waiting for input* above; these are raw per-harness events."

### 5. (Optional, later) Workflow schema

`userHookConfig.event` in `schemas/workflow-schema.yaml` could accept
`awaitingInput` too, so one user hook script works on every harness without
per-step overrides. This is lower priority because step overrides already work
around it. It is a separate change because user hooks go through each provider's
`buildHookConfig` rather than the artifact path.

## Verification before building

These rows in the mapping table are assumptions. Confirm each against a real session
and the `ctrlyoke-<harness>-hook-debug.log`:

1. Copilot `notification`: which `notification_type` values appear (`elicitation_dialog`,
   permission prompts, anything noisy such as idle)? Does it fire in yolo mode?
2. Claude/Qwen: are `permission_prompt` + `elicitation_dialog` the right filter?
   Exclude `idle_prompt`, because `stop` already covers "turn finished".
3. Codex `PermissionRequest` and OpenCode `permission.asked`: confirm they never fire
   for auto-approved calls under `allowAll`/`dangerouslyAllowAll`.
4. Headless runs can't prompt, so confirm nothing is installed or fired there.

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
- Regenerate docs: `npm run generate-schema-docs`. Also update
  `docs/harnesses/compatibility.md` through its generator if hook support is listed there.
