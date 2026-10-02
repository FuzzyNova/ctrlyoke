# Session docs say a literal `sessionId` is passed through unchecked

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli)
- **Area:** `docs/workflows/session-management.md`
- **Resolution:** fixed in this commit

## Symptom

`docs/workflows/session-management.md` ~81 says "A literal session ID is the
exception — it is passed through unchecked", and ~69 says "A literal ID is
passed straight to the harness". In practice every resolved session ID,
including literal ones, is format-validated per harness, and an invalid one is
silently dropped in favour of a new session.

## Steps to Reproduce

1. On a `claude-cli` step, set `sessionId: ses_abc123` (an OpenCode-format ID).
2. Run it. The session log shows "Starting new session due to invalid session ID
   format" and the step starts a fresh session instead of passing the ID on.

## Root Cause

`src/core/harness/shared/CliSessionResolverAdapter.ts` (~47-54) runs every
resolved ID through `SessionValidator.validate(resolvedSessionId, harness)`
(`src/utils/SessionValidator.ts`: UUID v4 for copilot/claude/qwen/antigravity,
`ses_…` for opencode). The docs predate or ignore that check.

## Suggested Fix

Correct the docs: a literal ID is not checked against which harness created it,
but it must match the target harness's session-ID format, or ctrlyoke starts a new
session (and logs why). Verify the per-harness formats against
`SessionValidator.ts` before stating them.
