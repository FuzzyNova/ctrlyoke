# Hooks with `env` get a launcher command that only cmd.exe can parse

- **Found:** 2026-10-12 by Claude (bug-drain review of ~33d934f87)
- **Area:** `src/core/harness/shared/UserHookEnvironment.ts`
- **Severity:** high

## Symptom

A user hook that sets a non-empty `env` fails to start on most harnesses. ~33d934f87 rewrites the
hook's command to `node <ctrlyoke-hook-run.js> <envFile> <hookId> <base64 command>`, quoted by
`buildLauncherCommand` (`src/core/harness/shared/UserHookEnvironment.ts:82-96`):

- On Windows each argument goes through `escapeCmdArgument`, producing `^"node^" ^"C:\...^" ...`.
  That form only parses under cmd.exe. Running the exact string under Git Bash, pwsh and
  Windows PowerShell 5 fails with `'^node^' is not recognized` / `command not found`.
  - Copilot CLI on Windows runs user hooks from the `powershell:` field
    (`CopilotNotificationMonitor.ts`), so the hook fails.
  - Claude Code runs hooks through Git Bash on Windows, so the hook fails.
  - Qwen runs `spawn(cmd.exe, ['/d','/s','/c', command])` without verbatim arguments, so Node
    escapes every `"` to `\"`; the comment in `QwenNotificationMonitor.ts` already warns that
    quotes break that path.
- Antigravity splits the command on whitespace and keeps quote characters literally (see the
  comment in `AntigravityNotificationMonitor.ts` and `harness-cli-providers.instructions.md`). The
  POSIX branch's `'node'` reaches agy with literal quotes, so the hook fails on every platform.

## Steps to Reproduce

1. On Windows, add a step hook `{ event: stop, command: "node -e \"console.log(process.env.FOO)\"", env: { FOO: bar } }`.
2. Run the step with `copilot-cli`, `claude-cli`, `qwen-cli` or `antigravity-cli`.
3. The hook reports `not recognized` / `command not found` and never runs.

## Root Cause

`buildLauncherCommand` picks quoting by OS, not by harness. Every other ctrlyoke hook command
already uses the per-harness convention of `CliNotificationMonitor.buildNodeCommand(script, dir, quoted)`
(`src/core/harness/shared/CliNotificationMonitor.ts:45-53`): forward slashes and plain double
quotes, or unquoted for Qwen and Antigravity. The tests in `src/test/unit/UserHookEnvironment.test.ts`
call the launcher with an argv array and never run the generated command string, so the breakage
went unnoticed.

`UserHookEnvironment.ts:47` and `OpenCodeCliProvider.ts` also carry `envFile`/`envId` on
`UserHookConfig` via casts instead of a declared type, against the "make structural relationships
nominal" rule in `.github/copilot-instructions.md`.

## Suggested Fix

Build the launcher command with the same convention as `buildNodeCommand`: forward-slash paths,
plain double quotes for harnesses that run a shell, unquoted for Qwen and Antigravity (the base64
argument, hook id and paths need no quoting when the paths are space-free; ctrlyoke's own hooks
already make that assumption). Single-source the "quoted or not" decision per harness rather than
re-deriving it in `UserHookEnvironment.ts`. Declare `envFile`/`envId` on a real type (e.g. an
`OpenCodeUserHookConfig extends UserHookConfig`) and drop the casts. Add a test that executes the
generated command string through each shell the harnesses use where available (cmd.exe and
PowerShell on Windows, `/bin/sh` on POSIX), and asserts the Qwen/Antigravity form contains no
quote characters.
