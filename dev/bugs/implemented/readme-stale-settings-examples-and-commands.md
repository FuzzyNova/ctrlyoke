# README.md documents nonexistent settings, commands and placeholders, and has invalid workflow examples

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `README.md`
- **Resolution:** fixed in 1834a326

## Symptom

The README (also the Marketplace page) contains many concrete claims that are false for the
current code:

- **Setting names that don't exist.** `{ "ctrlyoke.harness": "claude-cli" }` (line 41),
  `ctrlyoke.cliExecutionMode` (line 44), `ctrlyoke.respectGitignoreForCompletions` (line 271),
  and the whole Settings section (around lines 327-423), which says "All settings use the
  `ctrlyoke.` prefix" and lists `cliToolPermissions`, `scriptTimeout`, `maxPromptExecutionTime`,
  `copilotCliModel`, etc. Only `ctrlyoke.workspaceDirectory` is a VS Code setting. Everything else
  lives in `.ctrlyoke/settings.json` as `defaults.harness`, `defaults.executionMode`,
  `ui.respectGitignoreForCompletions`, `defaults.toolPermissions`, `execution.scriptTimeoutSec`,
  `execution.maxPromptTimeoutSec`, `defaults.models.<harness>` (see `schemas/settings-schema.json`).
- **Wrong defaults** in that table: `scriptTimeout` 30 (schema: 3600), `maxPromptExecutionTime`
  10800 (schema: -1), `showCliCommand` false (schema: true), and stale per-harness default models.
- **Invalid end-condition example** (around line 163): `timeout: 60000 # ms`. The field is
  `timeoutSec`, in seconds. `ctrlyoke validate --strict` reports
  `Unknown property 'timeout' at /endCondition/timeout. Did you mean 'timeoutSec'?`.
- **Retry placeholders that are never substituted** (around lines 127-128 and 166):
  `{retryCount}`, `{maxRetries}`, `{scriptOutput}`, `{error}`. `EndConditionHandler.buildRetryPrompt`
  passes the template through unchanged; the supported substitutions are `$endCondition:<field>`
  and `$preCondition:<field>`. The AI receives the braces literally.
- **Wrong `~` reference** (line 269): `~src/main.ts`. `~` only supports `~diff`, `~staged`,
  `~stash:N` and a 7–40 character commit hash (`src/utils/ReferencePatterns.ts`).
- **Session example without `resumeSession`** (line 256): `sessionId: 1 # resume the session…`
  alone is ignored, because resuming requires `resumeSession: true`
  (`docs/workflows/session-management.md` states this correctly).
- **Panel location** (line 56): "opens in the bottom tab area". `package.json` contributes the view
  container to the secondary side bar, as README line 275 and `docs/guide/installation.md` say.
- **Nonexistent commands** (around lines 317-319): `ctrlyoke: Import ctrlyoke Agents`,
  `ctrlyoke: Import Workflow Templates`, `ctrlyoke: Create End Condition Script` are not in
  `package.json` `contributes.commands`.
- **Understated MCP tool set** (lines 13 and 190): only `append_step` and `workflow_status` are
  named; the server registers 13 tools (`src/utils/McpToolDefinitions.ts`).

## Steps to Reproduce

1. Copy the README's end-condition example into a workflow and run `ctrlyoke validate --strict` on
   it. It fails with the unknown `timeout` property.
2. Add `"ctrlyoke.harness": "codex-cli"` to VS Code settings as the README says. Nothing changes.

## Root Cause

The README was not updated when settings moved to `.ctrlyoke/settings.json`, when `timeout` became
`timeoutSec`, and when commands were removed.

## Suggested Fix

Replace the README's settings table and command list with short summaries that link to the
generated `docs/reference/settings.md` and `docs/reference/commands.md`, so they can't drift
again. Fix each example: `timeoutSec: 60`, `$endCondition:stdout`/`$endCondition:stderr` instead
of brace placeholders, add `resumeSession: true`, use `~diff`, say "secondary side bar", and list
or link the full MCP tool set. Validate every YAML example with `ctrlyoke validate --strict`.
