# External run watch can overwrite final output with an older history load

- **Found:** 2026-10-12 by Claude (bug-drain review of ~2e4f60854)
- **Area:** `src/core/orchestration/ExternalRunWatchCoordinator.ts`
- **Severity:** medium

## Symptom

When watching an external (CLI) run, a step card can end up showing truncated streaming output
after the run finishes, with nothing later correcting it.

## Steps to Reproduce

1. Watch a CLI run from the dashboard while a step streams a long response.
2. A `manifest.json` change starts a history load; the run then finishes and the finishing path's
   final history read completes first and sends the final text.
3. The slower, older load completes afterwards and sends its earlier snapshot, which replaces the
   final text in the webview. The session is already dismissed, so no further update arrives.

## Root Cause

Every manifest change starts `loadHistory` with no throttling or ordering
(`ExternalRunWatchCoordinator.ts`, the manifest-change handler and the `.then` that forwards
changed attempts). The `.then` uses the `entry` it captured without checking that the session is
still registered. Before ~2e4f60854 an older load sent nothing because the entry count had not
changed; now its older content hashes differently, so it is forwarded. Also from that commit:
`handleExternalRunFinished` became async but is called without `void`, and the attempt key uses
the literal `"prompt"` instead of the existing `PROMPT` constant in `src/types/DashboardConstants.ts`.

## Suggested Fix

Serialize history loads per session (a promise chain, or a monotonically increasing sequence
number where results older than the latest applied load are dropped), and before forwarding check
`this.externalRunSessions.get(workflowId) === entry`. The finishing path's final read must be the
last load applied. Add `void` to the async call and use the `PROMPT` constant. Add a test where an
older load resolves after the final read and assert the final text is what remains.
