# Copy Metadata Reports a Stale Context Window During a Rerun

- **Found:** 2026-11-08 by smell hunt pass 4
- **Area:** `src/ui/webview-react/utils/stepMetadataClipboard.ts`
- **Resolution:** fixed in this commit

## Symptom

Copy Metadata showed the previous attempt's context window while a step was
rerunning, even though the hover tooltip showed live context-window telemetry.

## Root Cause

The clipboard builder preferred completed output/runtime snapshots over live
telemetry without checking whether the step was currently executing.

## Fix

The clipboard builder now calls `resolveEffectiveContextWindow` with the same
current-step state as the hover tooltip.
