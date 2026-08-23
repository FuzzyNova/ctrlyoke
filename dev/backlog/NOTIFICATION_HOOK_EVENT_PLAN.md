# Notification Hook Event Plan

## Goal

Add a canonical logical hook event named `notification` that can be used in both places where ctrlyoke already consumes hook events:

- workflow/prompt custom hooks configured through `HooksEditor`
- opt-in VS Code/browser notifications configured through `NotificationsSection`

Wire the event for Claude CLI, Copilot CLI, and Qwen Code only. Keep it deliberately unsupported for Codex CLI, Antigravity CLI, and OpenCode CLI; their providers must silently skip custom hooks and notification-source requests for this event, consistent with existing unsupported-hook behavior. OpenCode's `tui.toast.show` event is not a semantic match for "the harness is waiting on input" and must not be aliased to this event (see Non-Goals).

## Motivation

`permissionRequest` is a decision hook and does not reliably represent every point at which an interactive harness is waiting for a person. Current harnesses increasingly ask questions or display input/permission prompts through their notification systems instead. Forwarding those notification events closes the gap between “the process is still running” and “the workflow needs attention.”

The user-visible alert should preserve the harness's notification text. A generic `ctrlyoke - Notification` toast without the native message would technically fire but would not explain what input is needed.

## Confirmed Native Contracts

| Harness         | Native event                                                                       | Relevant payload                                                                                                                                             | Support decision                                           |
| --------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Claude CLI      | `Notification`                                                                     | `message`, optional `title`, `notification_type`; documented types include `permission_prompt`, `idle_prompt`, `elicitation_dialog`, and `agent_needs_input` | Supported                                                  |
| Copilot CLI     | `notification` config key; input reports `hook_event_name: "Notification"`         | `message`, optional `title`, `notification_type`; documented types include `permission_prompt` and `elicitation_dialog`                                      | Supported                                                  |
| Qwen Code       | `Notification`                                                                     | `message`, optional `title`, `notification_type`; documented types include `permission_prompt`, `idle_prompt`, and `auth_success`                            | Supported                                                  |
| OpenCode        | `tui.toast.show` event-bus event (considered and rejected)                         | optional `title`, `message`, `variant`, optional `duration`; no session ID                                                                                     | Unsupported — not a semantic match (see below)             |
| Codex CLI       | No equivalent general notification hook in ctrlyoke's supported Codex hook surface | n/a                                                                                                                                                          | Unsupported                                                |
| Antigravity CLI | No equivalent notification hook in ctrlyoke's supported hook groups                | n/a                                                                                                                                                          | Unsupported                                                |

OpenCode rationale: `tui.toast.show` represents all TUI toasts, not specifically “waiting for input,” and its official event shape has no session identifier. Treating it as equivalent to Claude/Copilot/Qwen's `Notification` hook would misrepresent OpenCode's actual capability and would surface toasts unrelated to any attention-needed state. ctrlyoke instead declares `notification` explicitly unsupported for OpenCode, the same way it already declares other logical events unsupported for harnesses that lack a real analog (e.g. `error` for Antigravity/Codex, `userPromptSubmit` for Antigravity).

## Canonical Model and UX Decisions

- Use lower camel case `notification` as the ctrlyoke logical event, matching the existing `sessionStart`, `preToolUse`, and `permissionRequest` vocabulary.
- Use the label `Notification`.
- Use the shared description: `Fires when the harness displays a notification, including prompts that may require user input.`
- Support is limited to Claude CLI, Copilot CLI, and Qwen CLI. Do not add a new `supportedHarnesses` field to `HookEventMetadata`/`HOOK_EVENT_METADATA`. The existing hooks capability domain (`CapabilityDomainDescriptorMap.hooks: Partial<Record<HookEvent, CapabilityDeclaration>>`, declared per harness beside each `*NotificationMonitor.EVENT_MAP`) is already the single source of truth for per-harness, per-event support: it already feeds the shared compatibility analyzer and already renders warnings in `HooksEditor` and the Hooks-tab badge for existing partially-supported events (`error`, `userPromptSubmit`, etc.). A second, hand-authored support list would let the two drift. See "Compatibility Integration" below.
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
       ┌─────────────────┴───────────────────┐
       ▼                                      ▼
Claude/Copilot/Qwen                  Codex/Antigravity/OpenCode
native hook config                   no native mapping — unsupported
       │                                      │
       ▼                                      └─ silently skipped;
normalized hook artifact                          capability declared
  event + native event                            `unsupported`/`none`
  + message/title/type + run metadata
                  ▼
HookEventMonitor → CompletionNotificationFactory
                  ▼
VS Code toast / hosted browser / web push
```

The same native mappings also drive custom hooks selected in `HooksEditor`; those commands run independently of whether ctrlyoke notifications are enabled.

## Compatibility Integration (Required, Not Optional)

Adding a new logical `HookEvent` is not solely a Phase 1 metadata/schema change. `HarnessCapabilityRegistry.validateCompleteness()` requires every harness's `capabilities.hooks` descriptor to include a `CapabilityDeclaration` for **every** member of `HOOK_EVENT_ORDER`, and throws at registry construction — not just at UI review time — if one is missing. Concretely, adding `notification` requires a matching entry in all six `*NotificationMonitor.CAPABILITIES` maps in the same change as the `HookEvent`/`HOOK_EVENT_ORDER` update:

- `ClaudeNotificationMonitor`, `CopilotNotificationMonitor`, `QwenNotificationMonitor`: `notification` declared supported (`fidelity: "exact"`, a real `mechanism`, and verification evidence), following each file's existing declaration pattern for its other events.
- `CodexNotificationMonitor`, `AntigravityNotificationMonitor`, `OpenCodeNotificationMonitor`: `notification` declared `unsupportedHook()` (`fidelity: "unsupported"`, `mechanism: "none"`).

This single integration point is also what makes Phase 5 (below) require no new UI code: `HooksEditor` and `NotificationsSection` already consume this registry through the shared analyzer.

## Phase 1: Shared Contract, Defaults, and Schemas

### `src/types/DashboardConstants.ts`

- Add `notification` to `HookEvent` and `HOOK_EVENT_ORDER`, positioned after `permissionRequest` and before `error`.
- Add `Notification` metadata (label + shared description only — no `supportedHarnesses` field; see "Canonical Model and UX Decisions" above).
- Extend the logical-to-native mapping table comment:
  - Claude/Qwen: `Notification`
  - Copilot: `notification`
  - Codex/Antigravity/OpenCode: `n/a`
- Do not duplicate support lists or unsupported-harness strings in individual settings components.

### `src/types/CtrlYokeSettings.ts`

- Add `notification: false` to `CTRLYOKE_SETTINGS_DEFAULTS.notifications.events.hookEvents`.
- The mapped `HookEvent` settings type will then require the new key at compile time.
- No persisted-settings migration is required: config resolution deep-merges stored partial settings over defaults, so existing files inherit `false`.

### Schemas

- Add `notification` to `schemas/workflow-schema.json`'s `userHookConfig.event` enum and update its native-mapping description.
- Regenerate `schemas/workflow-schema.yaml` with `npm run generate-schema`; do not edit the YAML by hand.
- Add the boolean `notifications.events.hookEvents.notification` property to `schemas/settings-schema.json`, defaulting behavior through the TypeScript settings default rather than a second schema default.

### Harness capability declarations (all six harnesses)

- Add a `notification` entry to all six `*NotificationMonitor.CAPABILITIES` maps in the same change as the `HookEvent`/`HOOK_EVENT_ORDER` update (see "Compatibility Integration" above) — `HarnessCapabilityRegistry.validateCompleteness()` fails closed otherwise.
- Claude, Copilot, Qwen: add `notification: { fidelity: EXACT, mechanism: WORKSPACE_CONFIG, verification: {...} }`, following the exact `verifiedHook()`/inline-object pattern each file already uses for its other supported events, with `verifiedVersions` matching that harness's already-recorded CLI version evidence.
- Codex, Antigravity: add `notification: unsupportedHook()` using each file's existing private `unsupportedHook()` helper. Do not add `notification` to their `EVENT_MAP`s — they already omit other unsupported events (e.g. `error`) from that partial map, and `notification` should follow the same convention.
- OpenCode: add `notification: unsupportedHook()`. `OpenCodeNotificationMonitor` does not yet have an `unsupportedHook()` helper — all seven of its current events are `verifiedHook()`/`partialHook()` — so add one following the Codex/Antigravity/Qwen convention. Its `EVENT_MAP` is currently a full `Record<HookEvent, string>` (every existing logical event maps to a native OpenCode event); adding `notification` to `HookEvent` without a corresponding map entry will fail to typecheck, so change the declared type to `Partial<Record<HookEvent, string>>` (matching the pattern Codex/Antigravity/Qwen already use for the same reason) and leave `notification` absent from the map.

## Phase 2: Claude, Copilot, and Qwen Hook Registration

### Native event maps and capability declarations

- `ClaudeNotificationMonitor.EVENT_MAP`: map `notification` to `Notification`. Add the matching `notification` entry to `ClaudeNotificationMonitor.CAPABILITIES` (see "Harness capability declarations" above).
- `CopilotNotificationMonitor.EVENT_MAP`: map `notification` to the lowercase config key `notification`. Add the matching `notification` entry to `CopilotNotificationMonitor.CAPABILITIES`.
- `QwenNotificationMonitor.EVENT_MAP`: map `notification` to `Notification`. Add the matching `notification` entry to `QwenNotificationMonitor.CAPABILITIES`.

These maps already serve both user-only/headless custom hooks and ctrlyoke notification hook configuration, so extending them keeps the behavior DRY. The capability declaration is what actually drives compatibility diagnostics; the event map alone does not.

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

## Phase 3: Explicit Non-Support for Codex, Antigravity, and OpenCode

No script or plugin changes are required for these three harnesses — there is no native event to wire. This phase is limited to the capability declarations already specified above:

- `CodexNotificationMonitor.CAPABILITIES.notification` and `AntigravityNotificationMonitor.CAPABILITIES.notification`: `unsupportedHook()`.
- `OpenCodeNotificationMonitor.CAPABILITIES.notification`: new `unsupportedHook()` helper, added alongside the existing `verifiedHook()`/`partialHook()` helpers.
- Do not touch `src/scripts/ctrlyoke-opencode-plugin.ts`. Its `tui.toast.show` event remains unmapped to any logical ctrlyoke hook event; it is not equivalent to "the harness is waiting for input" and forwarding it under the `notification` name would misrepresent OpenCode's actual capability (see Non-Goals).
- Verify `OpenCodeCliProvider`'s existing plugin-deployment condition (activates when custom hooks or any hook-notification setting is enabled) still behaves correctly when `notification` is the only enabled setting for a workflow targeting OpenCode: the plugin must not deploy a `notification` handler, and `HooksEditor`/`NotificationsSection` must both report it unsupported through the shared capability diagnostics rather than silently doing nothing.

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
- `HooksEditor` already types its hook rows via `UserHookConfig["event"]`, which is already `HookEvent` (not `string`) — no type-narrowing change is needed here; the existing `e.target.value as UserHookConfig["event"]` cast at the event `<select>` already accepts `notification` once it's added to `HOOK_EVENT_METADATA`.
- Do not add bespoke "Not supported in ..." helper text or a `HARNESS_INFO`-complement derivation for this event. `HooksEditor` already renders `diagnostics` (`CompatibilityDiagnostic[]`) through `toFieldDiagnostic`/`FieldDiagnostic`, and the shared analyzer already emits `compatibility.hooks.event.unsupported` for any configured event whose target harness's `CAPABILITIES` map marks it `unsupported` — the same mechanism that already flags e.g. `error` on Antigravity/Codex today. Once the Phase 1 capability declarations exist, selecting `notification` against Codex, Antigravity, or OpenCode surfaces a warning through this existing path with no new component logic.
- Keep existing inherited/none/custom tri-state behavior unchanged.

### `src/ui/webview-react/components/settings/NotificationsSection.tsx`

- The existing `HOOK_EVENT_ORDER` loop will render the new toggle automatically.
- Use the shared notification metadata description so the setting explains that the event can represent a harness waiting for input.
- Keep the existing generic sentence ("Requires the corresponding harness to support each event") rather than adding a per-event unsupported-harness list here. This setting is a global, harness-agnostic toggle, not tied to any one workflow's target harness, and today's UI does not enumerate per-harness support for its other partially-supported events (`error`, `userPromptSubmit`) either — `notification` should follow the same precedent instead of introducing a new, inconsistent pattern for one event.
- Keep the setting path `notifications.events.hookEvents.notification` and its default unchecked.

Do not add a `formatUnsupportedHarnesses`/`supportedHarnesses` helper anywhere in this phase; see "Compatibility Integration" above for why the capability registry is the single source of truth instead.

## Phase 6: Tests and Verification

### Contract and settings tests

- Extend `src/test/unit/NotificationSettings.test.ts` to assert that `notification` exists and defaults to `false`.
- Add an assertion that `HOOK_EVENT_ORDER` and `HOOK_EVENT_METADATA` stay aligned (one entry each), and that all six harnesses' `CAPABILITIES` maps declare `notification` (covered concretely by the `HarnessCapabilityRegistry` test below).
- Validate workflow and settings schema acceptance for the new keys and rejection of unknown events.

### Harness configuration tests

- Claude: `notification` produces a `Notification` command group in both combined and user-only configs.
- Copilot: `notification` produces the lowercase `notification` hook key and passes that native key to the wrapper command.
- Qwen: `notification` produces a `Notification` hook group and participates in trusted-hook registration.
- Codex, Antigravity, OpenCode: explicit negative tests confirm that a `notification` user hook or selected notification source produces no native registration (no `EVENT_MAP` entry, no plugin/script wiring), and that each harness's `CAPABILITIES.notification` reports `fidelity: "unsupported"` / `mechanism: "none"`. This protects the support boundary from accidental aliasing.
- `HarnessCapabilityRegistry`: confirm the existing completeness test still passes with `notification` present in `HOOK_EVENT_ORDER` for all six harnesses, and add a targeted assertion that the shared analyzer emits `HOOK_EVENT_UNSUPPORTED` for `notification` on Codex/Antigravity/OpenCode, matching the existing assertions for other partially-supported events.

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

### Webview tests

- Add a `HooksEditor` test that selects `Notification`, persists `{ event: "notification", command }`, and — given a target-harness diagnostics fixture for Codex/Antigravity/OpenCode — renders the existing compatibility warning through `FieldDiagnostic`, reusing the same assertion pattern as existing coverage for other partially-supported events.
- Extend `NotificationsSection.test.tsx` to assert the new unchecked toggle and description text (no per-harness support text change, per Phase 5).

### Commands

Use focused tests during implementation, then run:

```text
npm run generate-schema
npm run typecheck
npm run lint
npm run format:check
npm test
```

Do not make `notification` a universally required event in the live harness suite: notification hooks are stimulus-dependent and may not fire in a normal successful prompt. Add or run targeted live/manual scenarios that explicitly cause an input or permission prompt for Claude, Copilot, and Qwen. Record unsupported behavior for Codex, Antigravity, and OpenCode as a skip, not a failure.

## Acceptance Criteria

- `notification` is accepted by workflow schemas and typed as a canonical `HookEvent`.
- `HooksEditor` offers `Notification` for custom hooks and, through the existing shared-analyzer diagnostics, surfaces a compatibility warning when the workflow targets Codex, Antigravity, or OpenCode.
- `NotificationsSection` offers an opt-in Notification source, defaulting to off, using the same generic support-messaging pattern as its other partially-supported events.
- Claude, Copilot, and Qwen register their exact native notification event names in interactive and headless execution.
- Native notification text reaches VS Code/browser/web-push content.
- Custom notification hooks and ctrlyoke notification forwarding can coexist for one event.
- Codex, Antigravity, and OpenCode silently skip the logical event, declare it `unsupported`/`none` in their `CAPABILITIES` map, and have regression tests proving both that no native hook is installed and that the shared analyzer reports it unsupported.
- Existing start/stop completion detection and decision-hook stdout behavior remain unchanged.

## Non-Goals and Follow-Ups

- Adding Notification support to Codex, Antigravity, or OpenCode without a real, semantically-equivalent native event.
- Wiring OpenCode's `tui.toast.show` event-bus event to the `notification` logical event. It represents all TUI toasts, not specifically "waiting for input," has no session ID, and treating it as equivalent would misrepresent OpenCode's actual capability rather than honestly report it unsupported. This is a considered rejection, not a deferral — revisit only if OpenCode ships a narrower, input-specific event.
- Adding matcher/filter UI for `notification_type` variants in v1.
- Automatically answering questions or granting permissions. Notification hooks surface attention state; decision hooks remain separate.
- Deduplicating semantically overlapping `permissionRequest` and `notification` events. Users who enable both may receive both when a harness emits both, which should be documented as expected until event-type filters exist.
- Broadening the logical `HookEvent` vocabulary toward exhaustive parity with any single harness's full native hook list. See "Sanity Check" below for why this was considered and rejected.

## Sanity Check: Should Hook Support Be Redesigned for Exhaustive Per-Harness Coverage?

Claude Code's native hook surface is larger than ctrlyoke's seven (soon eight) logical events — it also exposes `PreCompact`, `SessionEnd`, `SubagentStart`, and `SubagentStop` ([hooks reference](https://code.claude.com/docs/en/hooks)). This raised the question of whether ctrlyoke's hook system needs a broader redesign so every native hook, on every harness, is representable, backed by a compatibility table.

**Conclusion: no redesign is needed, and this plan does not attempt one.**

- The infrastructure this plan already relies on — `HookEvent`/`HOOK_EVENT_ORDER`/`HOOK_EVENT_METADATA` in `DashboardConstants.ts`, per-harness `EVENT_MAP` + `CAPABILITIES` colocated in each `*NotificationMonitor`, and the shared `HarnessCapabilityRegistry`/`CompatibilityAnalyzer` — **is** the compatibility table the question is asking for. It already requires every harness to declare fidelity/mechanism/evidence for every logical event (enforced by `validateCompleteness()`), already reports `unsupported`/`partial`/`unverified` findings through one analyzer, and already renders them through one shared `HooksEditor`/Hooks-tab badge path. Adding `notification` in this plan is the same mechanical, per-event process as adding any of the existing seven events — it needs no new plumbing, which is itself evidence the architecture already generalizes.
- ctrlyoke's `HookEvent` union is deliberately a small, cross-harness **common vocabulary**, not a mirror of any one harness's native hook list. Claude-only hooks like `PreCompact` (context compaction) and `SubagentStart`/`SubagentStop` (Claude's Task-tool subagent lifecycle) have no analog in Copilot, Qwen, Codex, Antigravity, or OpenCode today. Adding them as logical events now would mean five of six harnesses immediately declare them `unsupported`, growing the completeness matrix without giving any workflow author a new cross-harness capability — pure surface area for no behavior.
- The right trigger for adding a new logical event is the same one that motivated `notification`: a real, currently-unserved use case with at least one concrete supported harness and confirmed native-contract evidence (as this plan collects in "Confirmed Native Contracts"), not an exhaustiveness goal. If a future workflow need requires `SessionEnd` or a subagent-lifecycle hook, add it the same way — one small, self-contained plan — rather than batching every possible native hook into one redesign.
- No action item follows from this sanity check beyond the Non-Goal recorded above.

## Sources

- [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference#notification-hook)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks#notification)
- [Qwen Code hooks reference](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/#notification)
- [OpenCode plugin events](https://opencode.ai/docs/plugins/#events) — reviewed and rejected as a `notification` source; see Non-Goals.
- [OpenCode generated event type for `tui.toast.show`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts) — evidence for the rejection above, kept for context.
