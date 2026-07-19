# Notification Hook Event Plan

## Goal

Add a canonical logical hook event named `notification` that can be used in both places where ctrlyoke already consumes hook events:

- workflow/prompt custom hooks configured through `HooksEditor`
- opt-in VS Code/browser notifications configured through `NotificationsSection`

Wire the event for Claude CLI, Copilot CLI, Qwen Code, and OpenCode. Keep it deliberately unsupported for Codex CLI and Antigravity CLI; their providers must silently skip custom hooks and notification-source requests for this event, consistent with existing unsupported-hook behavior.

## Motivation

`permissionRequest` is a decision hook and does not reliably represent every point at which an interactive harness is waiting for a person. Current harnesses increasingly ask questions or display input/permission prompts through their notification systems instead. Forwarding those notification events closes the gap between “the process is still running” and “the workflow needs attention.”

The user-visible alert should preserve the harness's notification text. A generic `ctrlyoke - Notification` toast without the native message would technically fire but would not explain what input is needed.

## Confirmed Native Contracts

| Harness         | Native event                                                                       | Relevant payload                                                                                                                                             | Support decision                                           |
| --------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Claude CLI      | `Notification`                                                                     | `message`, optional `title`, `notification_type`; documented types include `permission_prompt`, `idle_prompt`, `elicitation_dialog`, and `agent_needs_input` | Supported                                                  |
| Copilot CLI     | `notification` config key; input reports `hook_event_name: "Notification"`         | `message`, optional `title`, `notification_type`; documented types include `permission_prompt` and `elicitation_dialog`                                      | Supported                                                  |
| Qwen Code       | `Notification`                                                                     | `message`, optional `title`, `notification_type`; documented types include `permission_prompt`, `idle_prompt`, and `auth_success`                            | Supported                                                  |
| OpenCode        | `tui.toast.show` event-bus event                                                   | optional `title`, `message`, `variant`, optional `duration`; no session ID                                                                                   | Supported as the closest analog, not exact semantic parity |
| Codex CLI       | No equivalent general notification hook in ctrlyoke's supported Codex hook surface | n/a                                                                                                                                                          | Unsupported                                                |
| Antigravity CLI | No equivalent notification hook in ctrlyoke's supported hook groups                | n/a                                                                                                                                                          | Unsupported                                                |

OpenCode caveat: `tui.toast.show` represents all TUI toasts, not specifically “waiting for input,” and its official event shape has no session identifier. ctrlyoke should forward it using the per-run metadata already attached to hook artifacts and leave `sessionId` unset. Do not infer a session by racing against other plugin events.

## Canonical Model and UX Decisions

- Use lower camel case `notification` as the ctrlyoke logical event, matching the existing `sessionStart`, `preToolUse`, and `permissionRequest` vocabulary.
- Use the label `Notification`.
- Use the shared description: `Fires when the harness displays a notification, including prompts that may require user input.`
- Set `supportedHarnesses` to Claude CLI, Copilot CLI, Qwen CLI, and OpenCode CLI only. This metadata is the single source for support messaging.
- Register notification hooks without a matcher in v1 so all native notification/toast variants are forwarded. Per-notification-type filtering is a separate enhancement.
- Keep hook notification settings opt-in. The new default is `false`, so upgrading does not add notification noise.
- Preserve existing behavior when a workflow/prompt explicitly sets `hooks: null`: inherited custom hooks and hook-based notification sources remain suppressed for that step.
- Keep native hook output behavior unchanged. The ctrlyoke forwarding hook is side-effect-only; custom user hooks remain separate native entries where the harness supports them.

## End-to-End Data Flow

```text
notifications.events.hookEvents.notification = true
                         │
                         ▼
CliIntegration selects logical `notification`
                         │
       ┌─────────────────┼──────────────────┐
       ▼                 ▼                  ▼
Claude/Copilot/Qwen   OpenCode plugin   Codex/Antigravity
native hook config    tui.toast.show    no native mapping
       │                 │                  │
       └──────────┬──────┘                  └─ silently skipped
                  ▼
normalized hook artifact
  event + native event + message/title/type + run metadata
                  ▼
HookEventMonitor → CompletionNotificationFactory
                  ▼
VS Code toast / hosted browser / web push
```

The same native mappings also drive custom hooks selected in `HooksEditor`; those commands run independently of whether ctrlyoke notifications are enabled.

## Phase 1: Shared Contract, Defaults, and Schemas

### `src/types/DashboardConstants.ts`

- Add `notification` to `HookEvent` and `HOOK_EVENT_ORDER`, positioned after `permissionRequest` and before `error`.
- Add `Notification` metadata with the supported harness list above.
- Extend the logical-to-native mapping table:
  - Claude/Qwen: `Notification`
  - Copilot: `notification`
  - OpenCode: `tui.toast.show`
  - Codex/Antigravity: `n/a`
- Do not duplicate support lists or unsupported-harness strings in individual settings components.

### `src/types/CtrlYokeSettings.ts`

- Add `notification: false` to `CTRLYOKE_SETTINGS_DEFAULTS.notifications.events.hookEvents`.
- The mapped `HookEvent` settings type will then require the new key at compile time.
- No persisted-settings migration is required: config resolution deep-merges stored partial settings over defaults, so existing files inherit `false`.

### Schemas

- Add `notification` to `schemas/workflow-schema.json`'s `userHookConfig.event` enum and update its native-mapping description.
- Regenerate `schemas/workflow-schema.yaml` with `npm run generate-schema`; do not edit the YAML by hand.
- Add the boolean `notifications.events.hookEvents.notification` property to `schemas/settings-schema.json`, defaulting behavior through the TypeScript settings default rather than a second schema default.

## Phase 2: Claude, Copilot, and Qwen Hook Registration

### Native event maps

- `ClaudeNotificationMonitor.EVENT_MAP`: map `notification` to `Notification`.
- `CopilotNotificationMonitor.EVENT_MAP`: map `notification` to the lowercase config key `notification`.
- `QwenNotificationMonitor.EVENT_MAP`: map `notification` to `Notification`.

These maps already serve both user-only/headless custom hooks and ctrlyoke notification hook configuration, so extending them keeps the behavior DRY.

### Shared stdin-hook event mapping

In `src/scripts/ctrlyoke-hook-utils.js`:

- Add `Notification: "notification"` to `STANDARD_LOGICAL_EVENT_MAP`; `STANDARD_HANDLED_EVENTS` will derive support automatically.
- Extend `maybeWriteHookArtifact` (or a small shared normalization helper it calls) to accept optional notification details:
  - `notificationTitle`
  - `notificationMessage`
  - `notificationType`
- Keep `rawHookData` intact for diagnostics and forward compatibility.

In `src/scripts/ctrlyoke-claude-hook.js` and `src/scripts/ctrlyoke-qwen-hook.js`:

- Treat `Notification` like the existing side-effect-only events after writing the hook artifact. It must exit successfully without creating a start/stop lifecycle file and without requiring a session ID.
- Normalize `title`, `message`, and `notification_type` into the artifact fields above.
- Update event lists/comments so the script contract is discoverable.

In `src/scripts/ctrlyoke-copilot-hook.js`:

- Add `notification: "notification"` to its Copilot-native logical event map.
- Normalize the same notification fields from stdin.
- Continue through the existing non-lifecycle branch so no start/stop file is written.
- Keep the lowercase `notification` argv/config key distinct from the PascalCase `hook_event_name` found in the payload.

### Custom-hook behavior

Verify that selecting `Notification` in `HooksEditor` creates an additional user command entry for the same native event even when ctrlyoke's own notification forwarding entry is also installed. Do not collapse the two commands or let the forwarding script consume user-hook stdout.

## Phase 3: OpenCode Toast Mapping

### `src/scripts/ctrlyoke-opencode-plugin.ts`

Extend the existing `event` callback:

- On `event.type === "tui.toast.show"`, write a logical `notification` artifact with native event `tui.toast.show`.
- Normalize `properties.title`, `properties.message`, and `properties.variant` into `notificationTitle`, `notificationMessage`, and `notificationType` respectively.
- Leave `sessionId` undefined because the native event does not provide one.
- Invoke `_runUserHooks("notification")` so OpenCode custom hooks selected in `HooksEditor` receive the same fire-and-forget treatment as its other non-decision events.
- Preserve the complete `event.properties` object as `rawHookData`.

Extend the local `HookArtifact` and `_writeHookArtifact` extras types with the normalized notification fields. The OpenCode plugin is deployed verbatim and cannot import the CommonJS stdin-hook utility, so this small representation must stay structurally aligned with `CompletionNotificationFactory.HookArtifact` and be covered by tests.

No new `OpenCodeCliProvider` mapping table is necessary. Its existing plugin deployment condition already activates when either custom hooks or any hook-notification setting is enabled, and its sidecar stores logical event names without filtering them.

## Phase 4: Actionable ctrlyoke Notification Content

### `src/ui/notifications/CompletionNotificationFactory.ts`

- Add the optional normalized notification fields to `HookArtifact`.
- For `artifact.hookEvent === "notification"`, include the native title/message in the generated body while retaining the configured workflow and prompt context.
- Prefer the native message as the actionable detail. Include the native title only when it is non-empty and not a duplicate of the message.
- Fall back to `notificationType`, then the shared `Notification` label, when a harness omits a message.
- Keep the ctrlyoke title stable (`ctrlyoke - Notification`) so notification grouping/tagging stays predictable.
- Do not expose the entire raw hook payload in a user-facing notification.

No changes should be needed in `HookEventMonitor`, `NotificationManager`, `WebPushService`, or the webview message payload: they already transport the factory's generic title/body event. Confirm this assumption with typecheck and focused tests rather than adding parallel notification-specific paths.

## Phase 5: Editor and Settings UI

### `src/ui/webview-react/components/editor/HooksEditor.tsx`

- The shared metadata addition will put `Notification` in the native select automatically.
- Type `HookEntry.event` as `HookEvent` rather than `string`, and narrow the select value before calling `onChange`, so the editor does not weaken the shared enum at its boundary.
- When a row selects `notification`, render compact helper text directly under that row's event/command controls:

  `Not supported in Codex or Antigravity.`

- Derive those names from `HOOK_EVENT_METADATA` plus `HARNESS_INFO` (the complement of `supportedHarnesses`) instead of hardcoding two harness names in the component. This keeps the message correct if support changes later.
- Keep existing inherited/none/custom tri-state behavior unchanged.

### `src/ui/webview-react/components/settings/NotificationsSection.tsx`

- The existing `HOOK_EVENT_ORDER` loop will render the new toggle automatically.
- Use the shared notification metadata description so the setting explains that the event can represent a harness waiting for input.
- Append the same derived unsupported-harness subtext for events that are not universal, or at minimum for `notification`; do not create a second hardcoded support matrix in this component.
- Keep the setting path `notifications.events.hookEvents.notification` and its default unchecked.

If support text is needed in both components, extract a small webview helper such as `formatUnsupportedHarnesses(metadata)` rather than duplicating complement/list grammar.

## Phase 6: Tests and Verification

### Contract and settings tests

- Extend `src/test/unit/NotificationSettings.test.ts` to assert that `notification` exists and defaults to `false`.
- Add assertions that `HOOK_EVENT_ORDER`, `HOOK_EVENT_METADATA`, and the supported harness set stay aligned.
- Validate workflow and settings schema acceptance for the new keys and rejection of unknown events.

### Harness configuration tests

- Claude: `notification` produces a `Notification` command group in both combined and user-only configs.
- Copilot: `notification` produces the lowercase `notification` hook key and passes that native key to the wrapper command.
- Qwen: `notification` produces a `Notification` hook group and participates in trusted-hook registration.
- OpenCode: deployment preserves `notification` in the sidecar; a focused plugin fixture/test drives a `tui.toast.show` payload and verifies both artifact normalization and user-hook dispatch.
- Codex and Antigravity: explicit negative tests confirm that a `notification` user hook or selected notification source produces no native registration. This protects the support boundary from accidental aliasing.

### Script/artifact tests

Run the three stdin scripts against representative official payloads in temporary directories and assert:

- one `{runId}-hook-*.json` artifact is produced when `CTRLYOKE_NOTIFY_HOOK_EVENTS` contains `notification`
- normalized title/message/type and raw payload are preserved
- no `*-start.json`, `*-stop.json`, or `*-error.json` lifecycle file is produced
- no artifact is produced when the setting is disabled

### Notification factory tests

Extend `src/test/unit/CompletionNotificationFactory.test.ts` to cover:

- disabled notification hook events are suppressed
- enabled events include native message content plus workflow/prompt context
- missing title/message uses the type/label fallback
- OpenCode's missing session ID does not prevent event construction

### Webview tests

- Add a `HooksEditor` test that selects `Notification`, persists `{ event: "notification", command }`, and displays derived Codex/Antigravity support text.
- Extend `NotificationsSection.test.tsx` to assert the new unchecked toggle, description/support text, and exact update path when enabled.

### Commands

Use focused tests during implementation, then run:

```text
npm run generate-schema
npm run typecheck
npm run lint
npm run format:check
npm test
```

Do not make `notification` a universally required event in the live harness suite: notification hooks are stimulus-dependent and may not fire in a normal successful prompt. Add or run targeted live/manual scenarios that explicitly cause an input or permission prompt for Claude, Copilot, and Qwen, plus a known OpenCode toast. Record unsupported behavior for Codex and Antigravity as a skip, not a failure.

## Acceptance Criteria

- `notification` is accepted by workflow schemas and typed as a canonical `HookEvent`.
- `HooksEditor` offers `Notification` for custom hooks and clearly says Codex and Antigravity do not support it.
- `NotificationsSection` offers an opt-in Notification source, defaulting to off, with accurate support messaging.
- Claude, Copilot, and Qwen register their exact native notification event names in interactive and headless execution.
- OpenCode maps `tui.toast.show` without inventing a session ID.
- Native notification text reaches VS Code/browser/web-push content.
- Custom notification hooks and ctrlyoke notification forwarding can coexist for one event.
- Codex and Antigravity silently skip the logical event and have regression tests proving no native hook is installed.
- Existing start/stop completion detection and decision-hook stdout behavior remain unchanged.

## Non-Goals and Follow-Ups

- Adding Notification support to Codex or Antigravity without a real native event.
- Treating OpenCode's broad toast event as proof that the harness is waiting for input.
- Adding matcher/filter UI for `notification_type` or OpenCode toast variants in v1.
- Automatically answering questions or granting permissions. Notification hooks surface attention state; decision hooks remain separate.
- Deduplicating semantically overlapping `permissionRequest` and `notification` events. Users who enable both may receive both when a harness emits both, which should be documented as expected until event-type filters exist.

## Sources

- [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference#notification-hook)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks#notification)
- [Qwen Code hooks reference](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/#notification)
- [OpenCode plugin events](https://opencode.ai/docs/plugins/#events)
- [OpenCode generated event type for `tui.toast.show`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)
