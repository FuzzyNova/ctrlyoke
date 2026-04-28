# Hook Event Notifications Plan

**Date:** 2026-04-24

## Problem

FlightPath already supports completion notifications:

- workflow completion
- prompt completion
- VS Code toasts
- hosted-browser connected notifications
- hosted-browser push notifications

What it does **not** support is notifying on the lower-level hook lifecycle itself.

The requested behavior is:

- In [NotificationsSection.tsx](/C:/dev/FlightPath/src/ui/webview-react/components/settings/NotificationsSection.tsx), show a table of all logical hook events with a checkbox for whether that event should notify.
- These notifications must work even when the user has **no** custom `hooks` configured.
- This is a **global FlightPath setting**, not a workflow YAML property.
- When enabled, FlightPath should inject its own built-in hook notification handlers for the selected events on every prompt execution.

Example target behavior:

> "Notify me whenever `preToolUse` fires, even if I do not have a user hook script for `preToolUse`."

---

## Current Code Shape

### Existing notifications UI

[NotificationsSection.tsx](/C:/dev/FlightPath/src/ui/webview-react/components/settings/NotificationsSection.tsx) already exists and already renders:

- channels
- completion events (`workflowComplete`, `promptComplete`)
- content toggles
- noise-control toggles

There is already a Notifications tab in the global settings drawer, so this feature extends the existing UI rather than adding a new tab.

### Existing notification settings model

[FlightPathSettings.ts](/C:/dev/FlightPath/src/types/FlightPathSettings.ts) currently models notification settings as:

```ts
notifications: {
  vscode: {
    enabled: boolean;
  }
  browser: {
    mode: BrowserNotificationMode;
  }
  events: {
    workflowComplete: NotificationEventMode;
    promptComplete: NotificationEventMode;
  }
  includeWorkflowName: boolean;
  includePromptName: boolean;
  onlyWhenWindowUnfocused: boolean;
}
```

There is no place to store per-hook notification preferences today.

### Existing completion notification pipeline

Completion notifications already have a full extension-to-browser pipeline:

- [NotificationManager.ts](/C:/dev/FlightPath/src/ui/NotificationManager.ts) shows VS Code toasts.
- [CompletionNotificationFactory.ts](/C:/dev/FlightPath/src/ui/notifications/CompletionNotificationFactory.ts) builds shared notification payloads.
- [FlightPathHostedServer.ts](/C:/dev/FlightPath/src/server/FlightPathHostedServer.ts) broadcasts `MESSAGE_TYPES.NOTIFICATION_EVENT` and sends Web Push.
- [browserNotifications.ts](/C:/dev/FlightPath/src/ui/webview-react/utils/browserNotifications.ts) renders hosted-browser notifications.

This is the correct delivery pipeline to reuse.

### Existing hook model

[FlightPathTypes.ts](/C:/dev/FlightPath/src/types/FlightPathTypes.ts) already defines the logical hook events:

- `stop`
- `sessionStart`
- `preToolUse`
- `postToolUse`
- `userPromptSubmit`

Those logical names already map to harness-native hook names.

### Existing hook injection

Hook injection already exists for completion detection and user hooks:

- Claude / Copilot build hook config directly in their notification monitors.
- Codex / Qwen / Gemini use tracker-based settings-file injection.
- OpenCode uses its plugin path instead of JSON hook settings.

The important current limitation is that FlightPath's built-in hook scripts mostly care only about session-start/completion detection:

- [flightpath-claude-hook.js](/C:/dev/FlightPath/src/scripts/flightpath-claude-hook.js) ignores non-`SessionStart`/`Stop` events.
- [flightpath-copilot-hook.js](/C:/dev/FlightPath/src/scripts/flightpath-copilot-hook.js) only writes notification files for `sessionStart` / `agentStop`.
- The same pattern exists for the other harness hook scripts.

So the hook infrastructure exists, but the built-in FlightPath scripts do not currently surface arbitrary hook events into the notification pipeline.

---

## Goal

Add a new global notification feature layer for logical hook events.

When a hook event checkbox is enabled:

1. FlightPath injects its own built-in hook handler for that logical event on each prompt run.
2. The built-in handler emits a normalized hook-event artifact with workflow/prompt metadata.
3. FlightPath converts that artifact into a regular notification event.
4. Existing channels deliver it:
   - VS Code toast
   - hosted-browser connected notification
   - hosted-browser push notification

This must coexist with:

- existing completion detection hooks
- existing user `hooks`
- existing completion notifications

---

## Non-Goals

- No workflow YAML / JSON schema changes for this feature.
- No per-prompt or per-workflow notification overrides.
- No prompt-output snippets in hook notifications.
- No attempt to make `copilot-chat` support hook notifications.
- No new dashboard "hook activity log" UI in this plan.

---

## Proposed Settings Model

Add a new nested group under `notifications`:

```ts
import type { HookEvent } from "./FlightPathTypes";

export interface FlightPathNotificationSettings {
  vscode: {
    enabled: boolean;
  };
  browser: {
    mode: BrowserNotificationMode;
  };
  events: {
    workflowComplete: NotificationEventMode;
    promptComplete: NotificationEventMode;
  };
  hookEvents: Record<HookEvent, boolean>;
  includeWorkflowName: boolean;
  includePromptName: boolean;
  onlyWhenWindowUnfocused: boolean;
}
```

Default values:

```ts
hookEvents: {
  stop: false,
  sessionStart: false,
  preToolUse: false,
  postToolUse: false,
  userPromptSubmit: false,
}
```

Rationale:

- Hook notifications are occurrence-based, not success/failure-based, so booleans fit better than `NotificationEventMode`.
- Keeping them under `notifications` makes the feature obviously global.
- `hookEvents` avoids confusion with the existing top-level `hooks` setting.
- Defaults should be all-off because `preToolUse` / `postToolUse` can be extremely noisy.

---

## Settings UX

Extend [NotificationsSection.tsx](/C:/dev/FlightPath/src/ui/webview-react/components/settings/NotificationsSection.tsx) with a new subsection:

**Hook Events**

Recommended layout:

| Event              | Notify   | Meaning                            |
| ------------------ | -------- | ---------------------------------- |
| Session Start      | checkbox | AI session started for this prompt |
| User Prompt Submit | checkbox | prompt submitted into the harness  |
| Pre Tool Use       | checkbox | before a tool call                 |
| Post Tool Use      | checkbox | after a tool call                  |
| Stop               | checkbox | harness stop/completion hook       |

Behavior notes:

- This should be a compact table, not five standalone toggle rows.
- Each checkbox writes to `notifications.hookEvents.<event>`.
- Add helper text above the table:
  "FlightPath can notify on built-in hook events even when you have no custom hook scripts configured."
- Add helper text below the table:
  "Unsupported events are skipped by harnesses that do not expose them. Hook notifications require a CLI harness."

Implementation note:

- Keep the table local to `NotificationsSection.tsx` unless another settings page actually needs the same UI.
- The event list itself should move to a shared constant so it is not duplicated between `HooksEditor.tsx` and `NotificationsSection.tsx`.

Recommended shared source:

- add a `HOOK_EVENT_OPTIONS` or `HOOK_EVENT_LABELS` export in a root type/constants file
- consume it from both:
  - [HooksEditor.tsx](/C:/dev/FlightPath/src/ui/webview-react/components/editor/HooksEditor.tsx)
  - [NotificationsSection.tsx](/C:/dev/FlightPath/src/ui/webview-react/components/settings/NotificationsSection.tsx)

---

## Notification Event Model

The current shared notification payloads are completion-specific by name. This feature pushes the system past that boundary.

Recommended cleanup while implementing:

- rename `CompletionNotificationEvent` -> `FlightPathNotificationEvent`
- rename `CompletionNotificationEventPayload` -> `FlightPathNotificationEventPayload`
- rename `COMPLETION_NOTIFICATION_KINDS` -> `NOTIFICATION_KINDS`
- add a new kind: `hook`

If a rename feels too large for the first patch, the minimum acceptable fallback is:

- keep the existing types
- add `HOOK` to the existing kind constants
- tolerate the legacy naming temporarily

Payload additions for hook events:

```ts
{
  id: string;
  kind: "hook";
  severity: "info";
  workflowId: string;
  stepIndex?: number;
  title: string;
  body: string;
  tag: string;
  url?: string;
  hookEvent: HookEvent;
  harnessId?: HarnessId;
}
```

Hook notifications are informational, so `severity` should be `info` in v1.

---

## Hook Notification Source of Truth

Hook notifications should come from the actual harness hook invocation, not from inferred status transitions.

That matters because:

- `preToolUse` / `postToolUse` have no equivalent in workflow status transitions
- the notification should represent what the CLI actually fired
- it avoids fabricating events from log parsing heuristics

### Proposed normalized artifact

When a built-in FlightPath hook handler runs for a selected notification event, it should write a normalized JSON file containing:

```json
{
  "runId": "uuid",
  "timestamp": 1770000000000,
  "workflowId": "uuid",
  "workflowName": "example.flightpath.yaml",
  "promptIndex": 1,
  "promptName": "implement",
  "hookEvent": "preToolUse",
  "nativeHookEvent": "PreToolUse",
  "harnessId": "claude-cli",
  "sessionId": "optional",
  "toolName": "optional",
  "rawHookData": {}
}
```

Recommended file naming:

```text
{runId}-hook-{timestamp}-{seq}.json
```

Why `runId` instead of `sessionId`:

- `sessionStart` fires before session correlation is always reliable
- `FLIGHTPATH_RUN_ID` already exists for interactive runs
- `runId` is the safest primary correlation key for per-prompt execution

These files can live in the existing harness notification directory as long as they use a distinct filename pattern from `-start.json` / `-stop.json`.

---

## Required Metadata Injection

Current hook scripts only receive enough context for completion detection. That is not enough for user-facing hook notifications.

Add these process env vars for hook-capable executions:

- `FLIGHTPATH_RUN_ID`
- `FLIGHTPATH_WORKFLOW_ID`
- `FLIGHTPATH_WORKFLOW_NAME`
- `FLIGHTPATH_PROMPT_INDEX`
- `FLIGHTPATH_PROMPT_NAME`
- `FLIGHTPATH_HARNESS_ID`
- `FLIGHTPATH_NOTIFY_HOOK_EVENTS`
- `FLIGHTPATH_NOTIFY_DIR`

`FLIGHTPATH_NOTIFY_HOOK_EVENTS` should be a comma-separated list of logical hook event names enabled in global settings.

This env must be set for:

- interactive runs
- headless runs when hook notifications or user hooks are active

Today [CliExecutionRunner.ts](/C:/dev/FlightPath/src/flightpath/harness/shared/CliExecutionRunner.ts) only injects `FLIGHTPATH_RUN_ID` for interactive PTY runs. That needs to become general enough for hook-notification-enabled headless executions too.

---

## Harness Injection Strategy

This feature should reuse the existing built-in FlightPath hook handlers, not invent a second hook command per harness.

### Key rule

For a given harness:

- keep the existing built-in FlightPath handler for completion/session detection
- expand the set of hook events it is registered against when the matching checkbox is enabled
- let the script decide, via `FLIGHTPATH_NOTIFY_HOOK_EVENTS`, whether to emit a user-facing hook notification artifact for the current invocation

This avoids duplicate commands for `SessionStart` / `Stop`.

### Hook layer ordering

The merge order conceptually becomes:

1. FlightPath completion/session-detection handlers
2. FlightPath hook-notification handlers
3. workflow/prompt/global user hooks
4. pre-existing settings-file hooks where that harness preserves them

For implementations where completion detection and hook notification use the same built-in script, layers 1 and 2 can be the same physical command entry with different enabled-event behavior.

---

## Harness-by-Harness Plan

### Claude CLI

Relevant files:

- [ClaudeNotificationMonitor.ts](/C:/dev/FlightPath/src/flightpath/harness/claude/ClaudeNotificationMonitor.ts)
- [flightpath-claude-hook.js](/C:/dev/FlightPath/src/scripts/flightpath-claude-hook.js)

Changes:

- expand built-in hook registration beyond `SessionStart` / `Stop` when matching notification checkboxes are enabled
- keep using the same hook script
- teach the hook script to:
  - map Claude native event names to logical `HookEvent`
  - emit `-start.json` / `-stop.json` exactly as today
  - additionally emit normalized hook-event files only when the logical event is enabled

### Copilot CLI

Relevant files:

- [CopilotNotificationMonitor.ts](/C:/dev/FlightPath/src/flightpath/harness/copilot/CopilotNotificationMonitor.ts)
- [flightpath-copilot-hook.js](/C:/dev/FlightPath/src/scripts/flightpath-copilot-hook.js)

Changes:

- extend built-in hook config to register for selected logical events using `EVENT_MAP`
- preserve existing completion/session files
- emit normalized hook-event files from the same script

### Codex CLI

Relevant files:

- [CodexCliProvider.ts](/C:/dev/FlightPath/src/flightpath/harness/codex/CodexCliProvider.ts)
- [CodexNotificationMonitor.ts](/C:/dev/FlightPath/src/flightpath/harness/codex/CodexNotificationMonitor.ts)
- [flightpath-codex-notify.js](/C:/dev/FlightPath/src/scripts/flightpath-codex-notify.js)

Changes:

- extend `buildHookConfig()` so the generated `.codex/hooks.json` includes built-in entries for selected logical events, not just `SessionStart` / `Stop`
- preserve tracker-based parallel-safe registration
- update the built-in script to emit normalized hook-event files

### Qwen CLI / Gemini CLI

Relevant files:

- [QwenCliProvider.ts](/C:/dev/FlightPath/src/flightpath/harness/qwen/QwenCliProvider.ts)
- [GeminiCliProvider.ts](/C:/dev/FlightPath/src/flightpath/harness/gemini/GeminiCliProvider.ts)
- their hook scripts under `src/scripts/`
- `SettingsJsonHooksTracker`

Changes:

- extend the generated FlightPath hook section to include selected logical notification events
- keep tracker-based merge and parallel safety intact
- update the built-in scripts to emit normalized hook-event files

### OpenCode

OpenCode uses a plugin, not hook scripts.

Recommended scope split:

- Phase 1: ship script-based harnesses first
- Phase 1.5 or same PR if straightforward: have the OpenCode plugin emit the same normalized hook-event files for mapped logical events

OpenCode should not block the settings model or UI work.

### Copilot Chat

Unsupported.

The UI helper text should make it clear that hook notifications require a CLI harness.

---

## Runtime Collection

The extension needs a way to consume the normalized hook-event files while the prompt is running.

Recommended new shared component:

- `HookEventMonitor` under `src/flightpath/harness/shared/`

Responsibilities:

- watch or poll the harness notify directory for `*-hook-*.json`
- filter by `runId`
- parse and delete files after successful read
- emit normalized hook activity back into the runtime

This should stay separate from the completion monitor because:

- completion detection is terminal-state oriented
- hook activity is ongoing and multi-fire during a prompt run
- mixing those concerns into `INotificationMonitor` makes the interface muddy

Integration point:

- start the hook-event monitor alongside prompt execution when `notifications.hookEvents` has at least one enabled event
- stop it when the prompt execution completes or cancels

---

## Notification Building

Add a shared builder for hook notifications alongside the completion builders.

Suggested title/body pattern:

### Generic

**Title:** `FlightPath - Pre Tool Use`

**Body:** `refactor.flightpath.yaml - step 2 "implement" - claude-cli`

### With tool name

**Title:** `FlightPath - Pre Tool Use`

**Body:** `refactor.flightpath.yaml - step 2 "implement" - Bash`

Rules:

- honor `includeWorkflowName`
- honor `includePromptName`
- include harness name only when it adds value
- include tool name only for tool hooks when it is available

Suggested mapping:

- `sessionStart` -> `FlightPath - Session Start`
- `userPromptSubmit` -> `FlightPath - Prompt Submitted`
- `preToolUse` -> `FlightPath - Pre Tool Use`
- `postToolUse` -> `FlightPath - Post Tool Use`
- `stop` -> `FlightPath - Stop Hook`

---

## Delivery Reuse

Do **not** build a second notification delivery system.

Reuse the current surfaces:

- [NotificationManager.ts](/C:/dev/FlightPath/src/ui/NotificationManager.ts)
- [FlightPathHostedServer.ts](/C:/dev/FlightPath/src/server/FlightPathHostedServer.ts)
- [browserNotifications.ts](/C:/dev/FlightPath/src/ui/webview-react/utils/browserNotifications.ts)

That means:

- the extension should turn hook artifacts into the same logical notification events already used by completion notifications
- hosted browser clients should receive the existing `MESSAGE_TYPES.NOTIFICATION_EVENT`
- push notifications should work without a separate pathway

---

## Noise and Dedupe

Hook notifications are intentionally noisy. The defaults already handle that by leaving every hook checkbox off.

Recommended dedupe rules:

- dedupe by `{runId, hookEvent, timestamp, toolName}`
- do not attempt cross-family dedupe against completion notifications

Reason:

- if a user enables both `promptComplete` and `stop`, they explicitly asked for both a semantic completion summary and a raw hook event
- trying to infer that one should suppress the other will create surprising edge cases

Still honor existing channel-level suppression:

- `notifications.vscode.enabled`
- `notifications.browser.mode`
- `notifications.onlyWhenWindowUnfocused`

---

## Suggested Implementation Order

### Phase 1: Settings + UI

1. Add `notifications.hookEvents` to [FlightPathSettings.ts](/C:/dev/FlightPath/src/types/FlightPathSettings.ts).
2. Add defaults for all five logical events.
3. Add a shared hook-event label/options constant.
4. Extend [NotificationsSection.tsx](/C:/dev/FlightPath/src/ui/webview-react/components/settings/NotificationsSection.tsx) with the hook-event table.
5. Add tests covering settings defaults and UI updates.

### Phase 2: Notification event generalization

1. Generalize the current completion-only notification types/factory naming, or minimally add hook support to the existing structures.
2. Add a builder for hook notifications.
3. Extend `NotificationManager` and `FlightPathHostedServer` to dispatch hook notification events through the existing channels.

### Phase 3: Runtime metadata + script output

1. Pass workflow/prompt metadata and enabled hook event list through env vars.
2. Update built-in hook scripts to emit normalized hook-event JSON files.
3. Keep completion/session detection file behavior unchanged.

### Phase 4: Harness registration

1. Claude + Copilot
2. Codex
3. Qwen + Gemini
4. OpenCode follow-up

### Phase 5: Runtime collection

1. Add `HookEventMonitor`.
2. Start it only when at least one hook notification event is enabled.
3. Route parsed hook events into shared notification dispatch.

---

## Test Plan

### Automated

- `FlightPathSettings` defaults include `notifications.hookEvents`.
- `NotificationsSection` renders one row per logical hook event.
- checking a row updates `notifications.hookEvents.<event>`.
- hook label/options constant stays in sync with `HookEvent`.
- built-in hook config builders register selected logical events and no others.
- built-in hook scripts still write completion/session files as before.
- built-in hook scripts write normalized hook-event files only for enabled events.
- `HookEventMonitor` filters by `runId`, parses files, and deletes them after dispatch.
- `NotificationManager` delivers hook notifications through VS Code when enabled.
- hosted-server notification events include hook notifications and still support push mode.

### Manual

- Enable only `preToolUse`; confirm no notifications for other hook events.
- Run a Claude or Codex workflow with tool calls; confirm one notification per pre-tool hook fire.
- Enable `postToolUse`; confirm the second notification fires after each tool call.
- Enable `sessionStart`; confirm a notification appears at prompt start.
- Enable `stop`; confirm it fires in addition to completion notifications when both are enabled.
- Confirm `onlyWhenWindowUnfocused` still suppresses notifications when appropriate.
- Confirm browser push still works for hook notifications on the hosted dashboard.

---

## Risks

### Notification spam

`preToolUse` and `postToolUse` can fire many times in a single prompt. This is expected, and the all-off defaults are the mitigation.

### Hook registration drift

Each harness already has slightly different hook registration machinery. The plan should keep the logical event list single-sourced and push the harness-specific mapping to the provider/monitor layer.

### Parallel workflow safety

This plan must preserve the parallel-safety work already embodied in tracker-based hook registration. Hook notifications add more FlightPath-managed hook entries but should not change the concurrency model.

### Headless parity

If headless runs are not given the same env metadata and hook registration behavior, the feature will appear inconsistent. The plan should treat headless parity as part of the initial implementation, not a follow-up.

---

## Recommendation

Implement this as an extension of the **existing** notification system, not as a bespoke hook-only subsystem.

The clean shape is:

1. `notifications.hookEvents` stores the user's global hook-notify preferences.
2. Harness providers inject built-in FlightPath handlers for the selected logical hook events.
3. Built-in scripts emit normalized hook-event files with `runId` + workflow metadata.
4. A shared monitor consumes those files during prompt execution.
5. Existing notification channels deliver the resulting events.

That gets the requested UX in [NotificationsSection.tsx](/C:/dev/FlightPath/src/ui/webview-react/components/settings/NotificationsSection.tsx) while staying aligned with the repo's current notification and hook architecture.
