# Pre-run near-limit warning still fires with usage tracking turned off

- **Found:** 2026-10-11 by Claude while writing `docs/guide/usage-and-stats.md`
- **Area:** `src/core/orchestration/WorkflowStartupPipeline.ts`
- **Resolution:** not reproducible — `warnBeforeWorkflowStart` already returned early when `shouldTrackHarnessUsage()` was false (since cdea0c63f); 31907f092 only added regression tests and a redundant `usageTrackingEnabled` pass-through

## Symptom

With **Track harness usage** (`usageTracking.enabled`) turned off, starting a workflow can still
show the "near its usage limit" warning, if a quota snapshot taken before tracking was turned
off is still fresh.

## Steps to Reproduce

1. With usage tracking on, let a harness report a quota window above
   `usageTracking.warningPercentUsed`. Lower the threshold to make this easy.
2. Turn off **Track harness usage**.
3. Within the snapshot's freshness window, run a workflow on that harness. The warning appears.

## Root Cause

`buildUsageSelectionWarning` (`UsageSelectionAssist.ts:61`) returns early when
`input.usageTrackingEnabled === false`. The only production caller,
`WorkflowStartupPipeline.ts:1091-1096`, passes `queuedAttempts`, `snapshots` and
`warningPercentUsed`, but never `usageTrackingEnabled`. So the guard is always `undefined`
and never applies.

## Suggested Fix

Pass `usageTrackingEnabled: ConfigurationUtils.shouldTrackHarnessUsage()` into the call, and add a startup-pipeline test for the disabled case.
