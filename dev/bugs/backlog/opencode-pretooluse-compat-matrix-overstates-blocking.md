# Compatibility matrix marks OpenCode Pre Tool Use fully supported, but its hooks cannot block

- **Found:** 2026-10-17 by release-ready audit workflow (Claude, backlog auditor)
- **Area:** `src/scripts/ctrlyoke-opencode-plugin.ts` (~L149-163, ~L749), hook caveat registry (`HOOK_CAVEAT_CODES`), generated `docs/harnesses/compatibility.md` (~L33)
- **Severity:** medium

## Symptom

`docs/harnesses/compatibility.md` shows Pre Tool Use as ✅ on all six harnesses. On `opencode-cli`
a `preToolUse` hook fires, but neither its exit code nor its stdout can stop the tool call. A user
who writes a guard script from the public matrix (e.g. deny `rm -rf`, or block writes outside `src/`)
gets no protection, and nothing tells them.

## Steps to Reproduce

1. Configure a `preToolUse` hook that exits non-zero or prints a deny decision.
2. Run a step on `opencode-cli` that triggers the tool.
3. The tool still runs.

## Root Cause

`_runUserHooks("preToolUse", …)` in the OpenCode plugin runs each hook with `captureStdout: false`
inside `try { … } catch (_e) {}`, so the result is discarded. Only OpenCode's `permissionRequest`
carries a caveat (`HOOK_CAVEAT_CODES.UNVERIFIED_DECISION_CONTRACT`). `dev/backlog/HOOK_DECISION_FORMAT_PLAN.md`
already describes the gap but does not change the matrix.

## Suggested Fix

Register a caveat for OpenCode `preToolUse`, either a new code such as `CANNOT_BLOCK` or the
existing partial-support mechanism, so the cell renders ◐ with a footnote like "fires, but cannot
block the tool call". Then regenerate with `scripts/generate-compatibility-docs.mjs`. Real blocking
support stays in HOOK_DECISION_FORMAT_PLAN Phases 1+.
