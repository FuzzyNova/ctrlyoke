# OpenCode user hooks get no event payload except `permissionRequest`

- **Found:** 2026-10-12 by Claude while writing `docs/workflows/hooks.md`
- **Area:** `src/scripts/ctrlyoke-opencode-plugin.ts`
- **Severity:** low

## Symptom

On every other harness, a hook receives the harness's JSON description of the event on stdin
(session ID, tool name and arguments, and so on). On OpenCode, `sessionStart`,
`userPromptSubmit`, `preToolUse`, `postToolUse`, `stop` and `error` hooks get nothing on stdin,
so a `preToolUse` hook cannot tell which tool is about to run. Only `permissionRequest` receives
its payload. `docs/workflows/hooks.md:98-99` currently documents this gap as behavior.

The non-decision hooks also run with `stdio: "inherit"`. In an interactive OpenCode session,
that hands the hook the TUI's own stdin, so a hook that reads stdin can block on, or consume,
the user's keystrokes.

The plugin's header comment (`:126`) lists only five events
(`stop|sessionStart|preToolUse|postToolUse|userPromptSubmit`), although the plugin also
dispatches `error` (`:585`) and `permissionRequest` (`:599-602`).

## Steps to Reproduce

1. Add a hook `{ event: preToolUse, command: node ./scripts/dump-stdin.js }` to an OpenCode
   step, where the script writes whatever arrives on stdin to a file.
2. Run a prompt that makes OpenCode call a tool.
3. The file is empty (headless), or the hook waits on the terminal (interactive). The same hook
   on Claude Code records the tool call JSON.

## Root Cause

`_runUserHooks(event)` takes only the event name and runs each matching command with
`execSync(hook.command, { stdio: "inherit", cwd })`
(`src/scripts/ctrlyoke-opencode-plugin.ts:141-149`). Every call site has the event data
available but discards it: `session.created` (`:470`), `session.status` busy and idle (`:529`,
`:561`), `session.error` (`:585`), and `tool.execute.before`/`after` (`:626`, `:646`). Only the
decision path `_runDecisionUserHook` pipes a payload through `spawnSync({ input })` (`:159-196`).

## Suggested Fix

Give `_runUserHooks` a `payload` argument and run hooks with
`spawnSync(command, { input: JSON.stringify(payload), shell: true, stdio: ["pipe", "inherit", "inherit"], cwd })`.
Pass the same object each call site already gives `_writeHookArtifact` (for tools, include the
`args`/`output` from the trigger hook's second parameter). Use one documented, stable shape,
for example `{ hook_event_name, session_id, tool_name, tool_input, ... }`. Add the missing
events to the header comment, and update `docs/workflows/hooks.md:98-99` and the OpenCode Hooks
rows of the compatibility matrix.
