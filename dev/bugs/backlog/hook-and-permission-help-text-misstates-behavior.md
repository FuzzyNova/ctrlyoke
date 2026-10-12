# Schema and settings help text misstate hook inheritance, Codex's stop event and Antigravity's Allow All

- **Found:** 2026-10-12 by Claude while writing `docs/workflows/hooks.md` and `docs/workflows/permissions.md`
- **Area:** `schemas/workflow-schema.json`, `src/ui/webview-react/components/settings/AdvancedPermissionsSection.tsx`
- **Severity:** low

## Symptom

Three pieces of user-facing text (IntelliSense hovers, the generated reference docs and the
settings page) describe behavior the code doesn't have:

1. **Hook inheritance.** The `hooks` array description says "Per-event override: events present
   replace the tier below for that event; absent events inherit"
   (`schemas/workflow-schema.json:699`). The same definition is used at both the workflow and
   step level. That is true between a step and its workflow, but a workflow's `hooks` replaces
   `defaults.hooks` from settings entirely. A workflow that sets only a `stop` hook loses a
   `postToolUse` hook defined in `defaults.hooks`.
2. **Codex stop event.** `userHookConfig.event` says `'stop'` maps to "notify (Codex)"
   (`schemas/workflow-schema.json:1800`). Codex user hooks are registered on Codex's `Stop` hook
   event; `notify` is not used.
3. **Antigravity Allow All.** The settings page says "Allow All passes
   --dangerously-skip-permissions" for Antigravity
   (`AdvancedPermissionsSection.tsx:200-202`). Allow All passes no flags on Antigravity. Only
   `dangerouslyAllowAll` passes `--dangerously-skip-permissions`.

## Steps to Reproduce

1. Put `"defaults": { "hooks": [{ "event": "postToolUse", "command": "npm run lint" }] }` in
   `.ctrlyoke/settings.json`, and give a workflow `hooks: [{ event: stop, command: ... }]`.
   Run a step. Only the `stop` hook is registered, despite the hover text.
2. Hover `event: stop` in a workflow YAML file and read "notify (Codex)". Compare with
   `CodexNotificationMonitor.EVENT_MAP`.
3. Open Settings → Permissions, read the Antigravity paragraph, and compare it with the CLI
   arguments of an Antigravity step in `allowAll` mode.

## Root Cause

1. Settings defaults are copied into the working file as whole workflow-level properties when
   the workflow doesn't define them (`PromptFileLoader.populateSettingsDefaults`,
   `src/core/orchestration/PromptFileLoader.ts:584-586`, applied at `:233-237`). Resolution
   then falls back from workflow to defaults wholesale (`workflow.hooks ?? defaults.hooks`,
   `src/types/ExecutionPropertyResolver.ts:216`). The per-event merge only exists between step
   and workflow (`:224-236`).
2. `CodexNotificationMonitor.EVENT_MAP` maps `stop: "Stop"`
   (`src/core/harness/codex/CodexNotificationMonitor.ts:55-62`), and user hooks go through
   `CodexCliProvider.buildUserHooksSection` with that map (`CodexCliProvider.ts:665`). The
   schema text predates Codex's hooks support.
3. `AntigravityToolPermissionMapper.prepare` deliberately returns no args for `ALLOW_ALL`, so
   the deny list isn't silently bypassed
   (`src/core/harness/antigravity/AntigravityToolPermissionMapper.ts:58-65`). The settings copy
   was not updated with it.

## Suggested Fix

1. Reword the `hooks` array description to describe both tiers. A step's hooks replace the
   workflow's per event. A workflow's `hooks` replaces `defaults.hooks` entirely. (This matches
   `docs/workflows/hooks.md:74-82`. If per-event merging from settings is wanted instead, that
   is a code change in `populateSettingsDefaults` and `resolveHooks`.)
2. Change "notify (Codex)" to "Stop (Codex)" in the `event` description.
3. Change the Antigravity paragraph to: "Dangerously Allow All passes
   --dangerously-skip-permissions, Allow All passes no flags, Custom passes --sandbox, and
   individual allow/deny tool patterns are ignored."

Run `npm run schema:update` after the schema edits so `SchemaDescriptions.ts` and
`docs/reference/workflow-schema.md` follow.
