# Statusline Enabled After a Declined Install

- **Found:** 2026-11-08 by smell-hunt pass 3
- **Area:** `src/core/harness/shared/ProviderStatuslineRegistration.ts`
- **Resolution:** fixed in this commit

## Symptom

Claude and Antigravity set statusline environment variables and start a sidecar
even when the user keeps their existing statusline command. No ctrlyoke wrapper
runs in that case, so the sidecar watches a snapshot file that will never be
written.

## Steps to Reproduce

1. Enable statusline tracking for Claude or Antigravity while the harness has an
   existing custom statusline command that makes installation decline.
2. Start a workflow prompt.
3. Observe the statusline environment variables and sidecar despite the declined
   install.

## Root Cause

Claude and Antigravity enabled prompt tracking after every successful return
from `StatuslineManager.install`, including a `declined` result. Copilot and
Qwen already avoided that state because their wrapper is not installed after a
decline.

## Suggested Fix

Enable prompt tracking only when installation does not return
`PERSISTENT_VALUE_INSTALL_RESULT_KINDS.DECLINED`.
