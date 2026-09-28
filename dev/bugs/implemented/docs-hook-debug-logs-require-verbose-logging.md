# Troubleshooting docs say hook debug logs are always written; they need `diagnostics.verboseLogging`

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `docs/troubleshooting/index.md`, `docs/troubleshooting/common-errors.md`
- **Resolution:** fixed in this commit

## Symptom

`docs/troubleshooting/index.md` (log table) describes `ctrlyoke-<harness>-hook-debug.log` as
recording "Every hook invocation for Copilot CLI, Claude Code, Qwen Code, and Antigravity", and
lists the Codex notify and OpenCode plugin logs as equivalents. `docs/troubleshooting/common-errors.md`
("A step never completes") tells users to check those logs and says "No entries at all means the
hook never ran".

With the default settings these files are never created. A user following the guide concludes the
hook never ran, which is a misdiagnosis. The MCP log row on the same page already says it is
written only when `diagnostics.verboseLogging` is on.

## Steps to Reproduce

1. With default settings (`diagnostics.verboseLogging: false`), run any interactive-harness step.
2. `.ctrlyoke/logs/` contains no `*-hook-debug.log`, `ctrlyoke-codex-notify-debug.log`, or
   `ctrlyoke-opencode-plugin-debug.log`, even though the hooks ran and the step completed.

## Root Cause

- `src/scripts/ctrlyoke-hook-utils.js` `initializeLogger` only creates a file logger when
  `process.env.CTRLYOKE_DIAGNOSTIC_LOGS === "true"`. The OpenCode plugin does the same
  (`src/scripts/ctrlyoke-opencode-plugin.ts`).
- That variable is set only when `ConfigurationUtils.isDiagnosticLogsEnabled()` is true
  (`diagnostics.verboseLogging`, default `false`).

## Suggested Fix

In both docs pages, state that these logs are written only when `diagnostics.verboseLogging` is
`true`. Tell users to enable it and reproduce before treating a missing or empty log as "the hook
never ran". The `<debugging>` section of `.github/copilot-instructions.md` describes the hook log
the same way and should get the same qualifier.
