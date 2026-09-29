# edit/remove/reorder step tool views report no-op mutations as applied

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/ui/webview-react/components/output/ctrlyoke-tools/stepMutationModel.ts`, `StepMutationViews.tsx`
- **Severity:** medium

## Symptom

When `edit_step`/`remove_step`/`reorder_steps` succeed but change nothing, the MCP server returns `{"success":true,"changed":false,"note":"edit_step wrote nothing: …"}`. The dashboard view still summarizes it as e.g. `Edited step #3 — model` and shows a before→after diff, as if the edit applied.

## Steps to Reproduce

1. Render the edit_step view with params `{index:2, updates:{model:"x"}}` and result `{"success":true,"operation":"edit_step","changed":false,"note":"edit_step wrote nothing…","index":2}`.
2. Summary reads "Edited step #3 — model"; no indication it was a no-op.

## Root Cause

`CtrlYokeMCPServer.mutationResponse` (`src/mcp-server.ts`) deliberately emits `changed`/`note` so a no-op is not mistaken for success, but the result parsers in `stepMutationModel.ts` drop both fields and the views never consult them.

## Suggested Fix

Parse `changed` and `note` into the result types; when `changed === false`, use a "No change" summary, show the note, and flag the row as a warning (as `claim_paths` does for denials).
