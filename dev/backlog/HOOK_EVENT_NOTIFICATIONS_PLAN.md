# Hook Event Notifications Plan

**Date:** 2026-05-04

## Objective

Add global FlightPath notifications for logical hook events so users can opt into notifications like:

> "Notify me whenever `preToolUse` fires, even if I have no custom hooks configured."

This must reuse the existing notification delivery channels:

- VS Code toasts
- hosted-dashboard connected browser notifications
- hosted-dashboard push notifications

This is a global settings feature, not a workflow YAML feature.

---

## Verified Current State

This section corrects a few stale assumptions in the older draft.

### Hook event source of truth is now six events, not five

`src/types/FlightPathTypes.ts` currently defines these logical hook events:

- `stop`
- `sessionStart`
- `preToolUse`
- `postToolUse`
- `userPromptSubmit`
- `permissionRequest`

`src/ui/webview-react/components/editor/HooksEditor.tsx` already exposes all six.

### There is pre-existing schema drift

`schemas/prompt-schema.json` still lists only five hook events and omits `permissionRequest`.

That drift is not required to implement notification settings, but it is a real mismatch discovered during review and should be fixed in the same PR or in an immediate precursor PR so the repo has one coherent hook-event model.

### Notification settings type and schema do not yet support hook events

`src/types/FlightPathSettings.ts` and `schemas/settings-schema.json` currently support:

- channel settings
- completion-event settings (`workflowComplete`, `promptComplete`)
- content/noise toggles

There is no `notifications.hookEvents` setting today.

### `package.json` already points at `schemas/settings-schema.json`

The schema contribution already exists under `contributes.jsonValidation`.

Result: this feature needs a `schemas/settings-schema.json` update, but it does **not** need any new `package.json` schema-registration work.

### The notification delivery stack is completion-specific by naming

The current end-to-end completion notification stack is:

- `src/ui/notifications/CompletionNotificationFactory.ts`
- `src/ui/NotificationManager.ts`
- `src/server/FlightPathHostedServer.ts`
- `src/server/WebPushService.ts`
- `src/types/WebviewMessageTypes.ts`
- `src/ui/webview-react/hooks/useMessageHandler.ts`
- `src/ui/webview-react/utils/browserNotifications.ts`

The pipeline itself is reusable, but the event types and helper names are still completion-specific.

### Built-in hook registration already exists, but mostly for completion/session detection

Current built-in FlightPath hook registrations:

- Claude: `SessionStart`, `Stop`
- Copilot CLI: `sessionStart`, `agentStop`
- Codex: `SessionStart`, `Stop`
- Qwen: `SessionStart`, `UserPromptSubmit`, `Stop`
- Gemini: `SessionStart`, `AfterAgent`
- OpenCode: plugin handles session start/idle plus user hooks

User hooks already support a broader event set than FlightPath's built-in completion hooks.

### Built-in scripts/plugins do not emit user-visible hook-event artifacts yet

Current built-in scripts/plugins still only write completion/session files like:

- `{runId|sessionId}-start.json`
- `{sessionId}-stop.json`

They do **not** currently emit a normalized artifact for arbitrary hook events like `preToolUse` or `postToolUse`.

### Interactive runs get partial hook env; headless runs do not

Today:

- interactive PTY runs get `FLIGHTPATH_RUN_ID`
- interactive runs may also get `FLIGHTPATH_NOTIFY_DIR`
- headless runs do not get equivalent hook-notification env
- workflow/prompt metadata env vars for notifications do not exist yet

That means the current runtime plumbing is not enough for headless parity.

---

## Scope Decisions

### In scope

- global settings for hook-event notifications
- all six logical hook events in the settings UI
- existing notification channels only
- CLI harnesses only
- interactive and headless parity
- OpenCode in the main implementation scope

### Out of scope

- workflow YAML / JSON notification settings
- per-prompt or per-workflow notification overrides
- new dashboard hook-activity panels
- `copilot-chat` support

### Supported harness matrix

| Logical event       | Claude CLI          | Copilot CLI           | Codex CLI           | Qwen CLI           | Gemini CLI     | OpenCode              |
| ------------------- | ------------------- | --------------------- | ------------------- | ------------------ | -------------- | --------------------- |
| `stop`              | `Stop`              | `agentStop`           | `Stop`              | `Stop`             | `AfterAgent`   | `session.status idle` |
| `sessionStart`      | `SessionStart`      | `sessionStart`        | `SessionStart`      | `SessionStart`     | `SessionStart` | `session.created`     |
| `preToolUse`        | `PreToolUse`        | `preToolUse`          | `PreToolUse`        | `PreToolUse`       | `BeforeTool`   | `tool.execute.before` |
| `postToolUse`       | `PostToolUse`       | `postToolUse`         | `PostToolUse`       | `PostToolUse`      | `AfterTool`    | `tool.execute.after`  |
| `userPromptSubmit`  | `UserPromptSubmit`  | `userPromptSubmitted` | `UserPromptSubmit`  | `UserPromptSubmit` | `BeforeAgent`  | `session.status busy` |
| `permissionRequest` | `PermissionRequest` | unsupported           | `PermissionRequest` | unsupported        | unsupported    | `permission.asked`    |

Unsupported events should remain valid to store in global settings and should simply no-op on harnesses that do not expose them.

---

## Settings and Schema Changes

Add a new notification-settings branch:

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
  hookEvents: {
    stop: boolean;
    sessionStart: boolean;
    preToolUse: boolean;
    postToolUse: boolean;
    userPromptSubmit: boolean;
    permissionRequest: boolean;
  }
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
  permissionRequest: false,
}
```

Files to update:

- `src/types/FlightPathSettings.ts`
- `schemas/settings-schema.json`

No `FlightPathConfigService` logic changes are required beyond the type/default update; its deep-merge behavior already handles new nested settings.

No `package.json` changes are required; the schema contribution already points at `schemas/settings-schema.json`.

---

## Shared Hook Metadata

The event list must stop being duplicated.

Add a single shared metadata export in `src/types/DashboardConstants.ts`, for example:

- `HOOK_EVENT_METADATA`
- `HOOK_EVENT_ORDER`

Each entry should include at least:

- logical event key
- UI label
- short description

Recommended consumers:

- `src/ui/webview-react/components/editor/HooksEditor.tsx`
- `src/ui/webview-react/components/settings/NotificationsSection.tsx`

Also update `src/types/FlightPathTypes.ts` so the `HookEvent` type is derived from or exhaustively checked against the new shared constant instead of drifting independently.

### Adjacent cleanup

Update `schemas/prompt-schema.json` so the hook-event enum includes `permissionRequest`. This is pre-existing drift, not a direct requirement of global hook notifications, but leaving it stale will keep the repo internally inconsistent.

---

## Notification Event Model

The current payloads are completion-specific by name. This feature should generalize them.

### Recommended rename

- `CompletionNotificationEvent` -> `FlightPathNotificationEvent`
- `CompletionNotificationEventPayload` -> `FlightPathNotificationEventPayload`
- `COMPLETION_NOTIFICATION_KINDS` -> `NOTIFICATION_KINDS`
- `COMPLETION_NOTIFICATION_SEVERITY` -> `NOTIFICATION_SEVERITY`

Add a new kind:

- `hook`

Recommended payload:

```ts
{
  id: string;
  kind: "workflow" | "prompt" | "hook";
  severity: "info" | "warning" | "error";
  workflowId: string;
  stepIndex?: number;
  title: string;
  body: string;
  tag: string;
  url?: string;
  hookEvent?: HookEvent;
  harnessId?: HarnessId;
  toolName?: string;
}
```

V1 should treat hook notifications as `severity: "info"`.

### Files to update

- `src/types/DashboardConstants.ts`
- `src/types/WebviewMessageTypes.ts`
- `src/ui/notifications/CompletionNotificationFactory.ts`
  Recommended follow-up rename: `NotificationEventFactory.ts`
- `src/ui/NotificationManager.ts`
- `src/server/FlightPathHostedServer.ts`
- `src/server/WebPushService.ts`
- `src/ui/webview-react/hooks/useMessageHandler.ts`
- `src/ui/webview-react/utils/browserNotifications.ts`

---

## One Delivery Path

Do not create a second notification delivery stack for hook events.

Add an explicit generic notification dispatch method to the dashboard fan-out layer, for example:

```ts
notifyNotificationEvent(event: FlightPathNotificationEvent): void;
```

Update:

- `src/types/IDashboardSink.ts`
- `src/ui/PostMessageDashboardSink.ts`
- `src/ui/DashboardBroadcastHub.ts`
- `src/ui/FlightPathWebviewProvider.ts`
- `src/ui/NotificationManager.ts`
- `src/server/FlightPathHostedServer.ts`

Implementation shape:

- completion notifications are still _detected_ where they are today
- once built, both completion and hook notifications should flow through the same generic dispatch method
- panel webview delivery should continue to use `MESSAGE_TYPES.NOTIFICATION_EVENT`
- hosted browser delivery should continue to reuse the current broadcast + push code path

---

## Hook Artifact Format

Hook notifications should come from the actual hook invocations, not from inferred workflow state.

### Artifact file

Use a distinct file family inside the existing per-harness notification directory:

```text
{runId}-hook-{timestamp}-{unique}.json
```

`unique` can be:

- `process.pid` for one-shot script processes
- an in-memory increment for the OpenCode plugin

### Artifact payload

```json
{
  "runId": "uuid",
  "timestamp": 1770000000000,
  "workflowId": "uuid",
  "workflowName": "refactor.flightpath.yaml",
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

Rules:

- do not reuse `-start.json` / `-stop.json`
- correlate by `runId`, not by `sessionId`
- `sessionId` is optional metadata, not the primary key
- include `toolName` only when the harness provides one or it can be safely extracted

---

## Runtime Env and Run-ID Plumbing

The run ID needs to exist for both interactive and headless prompt executions.

### Required runtime changes

1. Add a `runId` to `src/flightpath/harness/shared/CliExecutionSession.ts`.
2. Build one hook-notification env object per prompt attempt.
3. Thread that env into both:
   - `CliTransportCoordinator.startInteractiveProcess()`
   - `CliTransportCoordinator.executeHeadless()`
4. Update `CliTransportCoordinator.spawnProcess()` so headless runs can receive per-run env overrides.

### Required env vars

- `FLIGHTPATH_RUN_ID`
- `FLIGHTPATH_WORKFLOW_ID`
- `FLIGHTPATH_WORKFLOW_NAME`
- `FLIGHTPATH_PROMPT_INDEX`
- `FLIGHTPATH_PROMPT_NAME`
- `FLIGHTPATH_HARNESS_ID`
- `FLIGHTPATH_NOTIFY_DIR`
- `FLIGHTPATH_NOTIFY_HOOK_EVENTS`
- `FLIGHTPATH_WORKSPACE_ROOT`

`FLIGHTPATH_NOTIFY_HOOK_EVENTS` should be a comma-separated list of enabled logical hook-event names.

`FLIGHTPATH_WORKSPACE_ROOT` is especially important for OpenCode because the plugin already expects it in comments, but the extension side does not currently inject it.

---

## Headless Hook Setup API

The current provider interface is not quite enough for this feature.

Today:

- interactive mode uses `buildNotificationHookArgs(...)`
- headless mode only uses `buildHeadlessUserHookArgs(...)`, and only when user hooks exist

That is insufficient for hook notifications that must work:

- in headless mode
- with no user hooks configured

### Required API change

Promote headless hook setup to a first-class provider API, for example:

```ts
buildHeadlessHookArgs(
  extensionPath: string,
  workspaceRoot: string,
  promptIndex: number,
  workingFilePath: string | undefined,
  userHooks: UserHookConfig[] | undefined,
  enabledHookNotifications: HookEvent[]
): Promise<string[]>;
```

Then update `src/flightpath/harness/CliIntegration.ts` so headless hook setup runs whenever either of these is true:

- there are user hooks
- at least one hook notification event is enabled

---

## Hook Event Monitor

Add a new shared runtime monitor:

- `src/flightpath/harness/shared/HookEventMonitor.ts`

Responsibilities:

- watch the per-harness notification directory for `*-hook-*.json`
- filter by `runId`
- parse and delete files after successful read
- convert artifacts into generic `FlightPathNotificationEvent` payloads
- dispatch them through the generic notification sink method

This monitor should be started and stopped by `CliExecutionRunner`, not by `CliLogMonitor`, because the feature must work in both interactive and headless modes.

---

## Permission Request Special Handling

`permissionRequest` is a decision hook, not a fire-and-forget hook.

That matters because the hook command's stdout is part of the harness decision flow.

### Required rule

For `permissionRequest`, the built-in FlightPath wrapper must be the only stdout-producing hook entry for that invocation when hook notifications are enabled.

That wrapper must:

1. emit the hook-notification artifact if `permissionRequest` notifications are enabled
2. run the user decision hook, if one exists
3. forward the user hook's stdout unchanged
4. otherwise produce no stdout so the harness falls back to its native permission dialog

### Reuse existing helper

`src/scripts/flightpath-hook-utils.js` already contains `runDecisionHook(...)`.

Reuse it. Do not add a second competing decision-hook helper.

### Why this needs special handling

For Claude and Codex, simply appending a second built-in hook command alongside a user `permissionRequest` command is risky because both may participate in stdout/decision semantics. The notification implementation should special-case this event instead of treating it like `preToolUse`.

---

## Harness-Specific Work

### Claude CLI

Files:

- `src/flightpath/harness/claude/ClaudeNotificationMonitor.ts`
- `src/flightpath/harness/claude/ClaudeCliProvider.ts`
- `src/scripts/flightpath-claude-hook.js`

Changes:

- expand built-in FlightPath registration beyond `SessionStart` / `Stop` based on enabled hook-notification events
- add headless built-in hook setup through the new headless hook API
- extend the script to write hook-event artifacts for selected events
- special-case `PermissionRequest` so artifact emission and user decision-hook stdout forwarding happen in one wrapper path

### Copilot CLI

Files:

- `src/flightpath/harness/copilot/CopilotNotificationMonitor.ts`
- `src/flightpath/harness/copilot/CopilotCliProvider.ts`
- `src/scripts/flightpath-copilot-hook.js`

Changes:

- register selected built-in events using the existing `EVENT_MAP`
- reuse the same script for completion/session detection and hook-event artifact writing
- emit artifacts for selected non-completion events
- `permissionRequest` remains unsupported

### Codex CLI

Files:

- `src/flightpath/harness/codex/CodexNotificationMonitor.ts`
- `src/flightpath/harness/codex/CodexCliProvider.ts`
- `src/flightpath/harness/shared/SettingsJsonHooksTracker.ts`
- `src/scripts/flightpath-codex-notify.js`

Changes:

- expand the FlightPath-managed `.codex/hooks.json` section beyond `SessionStart` / `Stop`
- support the same behavior in headless mode through the new headless hook API
- extend the script to emit hook-event artifacts
- special-case `PermissionRequest` so the built-in wrapper emits the artifact and forwards user decision-hook stdout
- ensure the tracker merge order does not create two competing `PermissionRequest` hook commands for the same run

### Qwen CLI

Files:

- `src/flightpath/harness/qwen/QwenNotificationMonitor.ts`
- `src/flightpath/harness/qwen/QwenCliProvider.ts`
- `src/scripts/flightpath-qwen-hook.js`

Changes:

- expand built-in FlightPath registrations beyond `SessionStart` / `UserPromptSubmit` / `Stop` when selected
- keep settings-file merge and trusted-hook behavior intact
- emit hook-event artifacts from the same script
- `permissionRequest` remains unsupported

### Gemini CLI

Files:

- `src/flightpath/harness/gemini/GeminiNotificationMonitor.ts`
- `src/flightpath/harness/gemini/GeminiCliProvider.ts`
- `src/scripts/flightpath-gemini-hook.js`

Changes:

- expand built-in registrations beyond `SessionStart` / `AfterAgent` when selected
- keep settings-file merge and trusted-hook behavior intact
- emit hook-event artifacts from the same script
- map `BeforeAgent` / `BeforeTool` / `AfterTool` / `AfterAgent` to the logical events
- `permissionRequest` remains unsupported

### OpenCode

Files:

- `src/flightpath/harness/opencode/OpenCodeCliProvider.ts`
- `src/scripts/flightpath-opencode-plugin.ts`

Changes:

- keep OpenCode in the main implementation scope
- have the plugin emit the same normalized hook-event artifacts for:
  - `session.created`
  - `session.status busy`
  - `tool.execute.before`
  - `tool.execute.after`
  - `session.status idle`
  - `permission.asked`
- inject `FLIGHTPATH_NOTIFY_DIR` and `FLIGHTPATH_WORKSPACE_ROOT` in headless runs too so artifact writing is not interactive-only
- keep existing decision-hook behavior for `permission.asked`, but add artifact emission without altering the returned decision object

### Copilot Chat

Unsupported. No implementation work beyond keeping UI copy accurate.

---

## Settings UI

Extend `src/ui/webview-react/components/settings/NotificationsSection.tsx` with a new compact table:

| Event              | Notify   | Meaning                                                  |
| ------------------ | -------- | -------------------------------------------------------- |
| Session Start      | checkbox | AI session started for this prompt                       |
| User Prompt Submit | checkbox | prompt submitted into the harness                        |
| Pre Tool Use       | checkbox | before a tool call                                       |
| Post Tool Use      | checkbox | after a tool call                                        |
| Stop               | checkbox | harness completion hook                                  |
| Permission Request | checkbox | harness is asking for an interactive permission decision |

Behavior:

- each checkbox writes to `notifications.hookEvents.<event>`
- use the shared hook-event metadata constant, not a local array
- helper text above the table should explain that FlightPath can notify even with no user hooks configured
- helper text below the table should explain:
  - notifications require a CLI harness
  - unsupported events are silently skipped
  - `permissionRequest` is only exposed by Claude CLI, Codex CLI, and OpenCode

No special `WebviewSettingsSync` setter logic is needed for the new setting path; the global settings drawer already updates arbitrary dot-paths through `configService`.

---

## Notification Content

Suggested titles:

- `sessionStart` -> `FlightPath - Session Start`
- `userPromptSubmit` -> `FlightPath - Prompt Submitted`
- `preToolUse` -> `FlightPath - Pre Tool Use`
- `postToolUse` -> `FlightPath - Post Tool Use`
- `stop` -> `FlightPath - Stop Hook`
- `permissionRequest` -> `FlightPath - Permission Request`

Body rules:

- honor `includeWorkflowName`
- honor `includePromptName`
- include tool name when available for tool-related events
- do not include output snippets

Dedupe rules:

- dedupe by notification `id`
- a safe v1 ID format is `${workflowId}:hook:${runId}:${timestamp}:${hookEvent}:${toolName ?? ""}`
- do not dedupe hook notifications against prompt/workflow completion notifications

If a user enables both `promptComplete` and `stop`, they should receive both.

---

## File-Level Implementation Checklist

### Types, constants, schema

- `src/types/DashboardConstants.ts`
- `src/types/FlightPathTypes.ts`
- `src/types/FlightPathSettings.ts`
- `src/types/WebviewMessageTypes.ts`
- `schemas/settings-schema.json`
- `schemas/prompt-schema.json` for the pre-existing `permissionRequest` drift

### UI and webview delivery

- `src/ui/webview-react/components/settings/NotificationsSection.tsx`
- `src/ui/webview-react/components/editor/HooksEditor.tsx`
- `src/ui/webview-react/hooks/useMessageHandler.ts`
- `src/ui/webview-react/utils/browserNotifications.ts`

### Generic notification dispatch

- `src/types/IDashboardSink.ts`
- `src/ui/PostMessageDashboardSink.ts`
- `src/ui/DashboardBroadcastHub.ts`
- `src/ui/FlightPathWebviewProvider.ts`
- `src/ui/NotificationManager.ts`
- `src/server/FlightPathHostedServer.ts`
- `src/server/WebPushService.ts`
- `src/ui/notifications/CompletionNotificationFactory.ts`

### Harness runtime and monitoring

- `src/flightpath/harness/shared/CliExecutionSession.ts`
- `src/flightpath/harness/CliIntegration.ts`
- `src/flightpath/harness/shared/CliExecutionRunner.ts`
- `src/flightpath/harness/shared/CliTransportCoordinator.ts`
- `src/flightpath/harness/shared/HookEventMonitor.ts`

### Harness-specific providers, monitors, scripts, plugin

- Claude, Copilot, Codex, Qwen, Gemini provider/monitor pairs
- `src/flightpath/harness/shared/SettingsJsonHooksTracker.ts`
- `src/scripts/flightpath-claude-hook.js`
- `src/scripts/flightpath-copilot-hook.js`
- `src/scripts/flightpath-codex-notify.js`
- `src/scripts/flightpath-qwen-hook.js`
- `src/scripts/flightpath-gemini-hook.js`
- `src/scripts/flightpath-opencode-plugin.ts`

---

## Test Plan

### Automated

- defaults in `FLIGHTPATH_SETTINGS_DEFAULTS.notifications.hookEvents` include all six events
- `schemas/settings-schema.json` accepts valid `notifications.hookEvents` objects and rejects unknown keys
- `schemas/prompt-schema.json` hook-event enum includes `permissionRequest`
- shared hook-event metadata stays in sync with the `HookEvent` type
- `NotificationsSection` renders one row per logical hook event
- toggling a checkbox updates `notifications.hookEvents.<event>`
- `HooksEditor` and `NotificationsSection` both consume the same shared metadata source
- generic notification factory builds hook notifications with the expected title/body/id fields
- `PostMessageDashboardSink` emits `MESSAGE_TYPES.NOTIFICATION_EVENT` for generic notification events
- `useMessageHandler` and `browserNotifications.ts` handle generic notification payloads, not completion-only types
- `HookEventMonitor` filters by `runId`, parses artifacts, dispatches notifications, and deletes files
- `CliExecutionRunner` / `CliTransportCoordinator` pass hook-notification env to both interactive and headless runs
- provider hook builders register only the selected built-in events
- built-in scripts keep writing completion/session files exactly as before
- built-in scripts/plugins emit normalized hook-event artifacts only for enabled events
- `permissionRequest` wrappers on Claude/Codex/OpenCode preserve user decision-hook stdout behavior
- `NotificationManager` shows hook notifications through VS Code toasts when enabled
- `FlightPathHostedServer` broadcasts and pushes hook notifications through the existing browser pipeline

### Manual

- enable only `preToolUse`; verify only tool-start notifications fire
- enable `postToolUse`; verify both tool-start and tool-end notifications fire
- enable `sessionStart`; verify a notification appears at prompt start
- enable `stop` and `promptComplete`; verify both notifications appear
- on Claude or Codex, enable `permissionRequest`; verify the notification fires and the native permission behavior still works
- verify `onlyWhenWindowUnfocused` still suppresses notifications
- verify hosted connected notifications and push notifications still work
- verify headless runs emit hook notifications when enabled

---

## Risks

### Notification spam

`preToolUse` and `postToolUse` can be very noisy. The all-off defaults are the intended mitigation.

### `permissionRequest` semantics

This is the highest-risk part of the feature because stdout matters. It needs explicit tests on Claude, Codex, and OpenCode so notification wrapping does not alter allow/deny behavior.

### Parallel workflow safety

Tracker-based settings-file hook injection must remain parallel-safe. Adding more FlightPath-managed built-in hook registrations cannot regress that behavior.

### Headless parity

If headless runs do not get both hook setup and env injection, the feature will feel randomly broken. Headless parity is part of the initial implementation, not a follow-up.

### Pre-existing schema drift

The repo already has hook-event drift between `FlightPathTypes.ts`, `HooksEditor.tsx`, and `schemas/prompt-schema.json`. The implementation should resolve that drift while touching this area.

---

## Recommended Implementation Order

1. Add shared hook-event metadata and fix the hook-event source-of-truth drift.
2. Add `notifications.hookEvents` to `FlightPathSettings.ts` and `schemas/settings-schema.json`.
3. Generalize the notification event types and add the generic dispatch method through the dashboard sink layer.
4. Update `NotificationsSection.tsx` and the webview/browser notification typing.
5. Add run-ID/env plumbing plus `HookEventMonitor`.
6. Update harness providers and monitors for selected built-in event registration in interactive and headless modes.
7. Update built-in scripts/plugins to emit hook-event artifacts.
8. Special-case and verify `permissionRequest`.
9. Finish with focused unit tests and one end-to-end harness smoke pass.

This yields a plan that matches the current codebase and is ready to implement directly.
