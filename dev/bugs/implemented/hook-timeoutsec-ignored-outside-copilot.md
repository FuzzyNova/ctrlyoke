# A hook's `timeoutSec` is dropped on every harness except Copilot

- **Found:** 2026-10-12 by Claude while writing `docs/workflows/hooks.md`
- **Area:** `src/core/harness/shared/interfaces/INotificationMonitor.ts`
- **Resolution:** fixed in this commit

## Symptom

The schema says `timeoutSec` is "Only respected by CLIs that support per-hook timeouts"
(`schemas/workflow-schema.json:1816`). Claude Code, Codex, Qwen Code and Antigravity all accept
a per-hook `timeout` in their hook entries, but ctrlyoke passes `timeoutSec` only to Copilot
CLI. On the other harnesses the hook runs with the harness default timeout. On Antigravity, it
runs with a hard-coded `timeout: 0`. A long-running hook can be killed early, or a hanging hook
can stall the turn longer than the user configured. Nothing warns that the value was ignored.
`docs/workflows/hooks.md:64` currently documents "Only Copilot honors it" as the behavior.

## Steps to Reproduce

1. Add a hook with `event: stop`, `command: node ./scripts/slow.js` and `timeoutSec: 5` to a
   Claude Code step.
2. Run the step, then open the `--settings` JSON that ctrlyoke passed to Claude (or the
   session log).
3. The hook entry is `{ "type": "command", "command": "..." }` with no `timeout`.

## Root Cause

User hook entries are built in several places, and only Copilot's copies `timeoutSec`:

- Copilot: `src/core/harness/copilot/CopilotNotificationMonitor.ts:79` and `:168` (`timeoutSec: uh.timeoutSec ?? 10`).
- Claude interactive: the shared `buildCommandHooks` default group builder
  (`src/core/harness/shared/interfaces/INotificationMonitor.ts:587-592`, `:617`) is given only
  `uh.command`.
- Claude headless: `ClaudeNotificationMonitor.buildUserOnlyConfig`
  (`src/core/harness/claude/ClaudeNotificationMonitor.ts:69-80`).
- Codex: `CodexCliProvider.buildUserHooksSection` (`src/core/harness/codex/CodexCliProvider.ts:653-673`)
  calls `createCodexCommandHookGroup(nativeEvent, uh.command)`
  (`src/core/harness/shared/CodexHookUtils.ts:17-26`), which has no timeout parameter.
  `CodexInlineHooksBuilder` then fills in 600 s (`CodexInlineHooksBuilder.ts:295-302`).
- Qwen: `QwenCliProvider.buildUserHooksSection` (`src/core/harness/qwen/QwenCliProvider.ts:684-706`).
- Antigravity: `pushHandler` writes `timeout: 0` for every handler, including user hooks
  (`src/core/harness/antigravity/AntigravityNotificationMonitor.ts:106-116`, `:141-149`).
- OpenCode: the plugin runs user hooks with `execSync` and no `timeout` option
  (`src/scripts/ctrlyoke-opencode-plugin.ts:141-149`). A hanging hook there blocks OpenCode's
  plugin event loop indefinitely.

## Suggested Fix

Pass the whole `UserHookConfig` (not just `command`) into the hook group builders. Then emit
each harness's native timeout field when `timeoutSec` is set, converting units where needed:
Claude and Codex use seconds, while Qwen's Gemini-derived hook runner uses milliseconds. Verify
Antigravity's unit and what `0` means before changing it. In the OpenCode plugin, pass
`timeout: timeoutSec * 1000` to `execSync`/`spawnSync`. Single-source the conversion in one
helper next to `buildCommandHooks`. Then update the schema description and
`docs/workflows/hooks.md:64`.
