# Claude interactive `custom` mode inherits the user's `defaultMode`

- **Found:** 2026-10-22 by Claude (harness capability suite), with Claude Code 2.1.308
- **Area:** `src/core/harness/claude/ClaudeToolPermissionMapper.ts`
- **Resolution:** fixed in this commit

## Symptom

An interactive Claude step in `custom` permission mode ran `node mark.js` without asking, although
`node` was not on its allow list. The `permissionRequest` and `notification` hooks never fired,
because no approval was ever requested.

## Steps to Reproduce

1. Set `"permissions": {"defaultMode": "bypassPermissions"}` in `~/.claude/settings.json`.
2. Run an interactive Claude step with `toolPermissions: {mode: custom, allowedTools: [], deniedTools: []}`
   that asks for a shell command.
3. The command runs without a prompt.

## Root Cause

For interactive `custom` runs the mapper passed no `--permission-mode`, intending Claude's default
prompting mode. Without the flag Claude uses the user's own `permissions.defaultMode`, so
`bypassPermissions` (or `acceptEdits`, for edits) skipped the prompts that `custom` relies on.

## Fix

Interactive `custom` runs now pass `--permission-mode default` explicitly; headless runs keep
`dontAsk`.
