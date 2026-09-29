# read_notes custom view falls back to the generic MCP view when any entry lacks `from.kind`

- **Found:** 2026-09-29 by user, during the MCP tool-call display visual test
- **Area:** `src/ui/webview-react/components/output/ctrlyoke-tools/readNotesModel.ts`, `registry.ts`
- **Severity:** medium

## Symptom

`read_notes` is rendered with the default MCP tool format even though a dedicated `ReadNotesView` exists and is registered.

## Steps to Reproduce

1. In a workspace whose coordination board contains older entries (participants recorded before `from.kind` existed), call `mcp__ctrlyoke__read_notes`.
2. The row shows the generic `MCP: ctrlyoke.read_notes` layout with raw JSON instead of the notes list.

## Root Cause

Not verified by running the UI; found by reading the code and the actual tool result.

`resolveCtrlYokeToolView` (`registry.ts:434-457`) returns `undefined` — and the caller falls back to the generic renderer — whenever `view.parseResult` returns `undefined`. `parseReadNotesResultText` (`readNotesModel.ts:76-101`) requires **every** entry to pass `isEntry`, which requires `isParticipant(entry.from)` (`readNotesModel.ts:20-28`), which requires `typeof from.kind === "string"`.

The real `read_notes` result in this workspace mixes both shapes: entries from earlier runs (seq 9-121) have a `from` object with no `kind` field, while later entries (seq 125+) include `"kind": "ctrlyoke-step"`. One legacy entry fails the `every(isEntry)` check and the whole result is rejected.

## Suggested Fix

Make `from.kind` optional in `isParticipant` (and in the `CoordinationEntry` participant type if it is declared required), or default it when parsing. Consider rendering entries that fail validation with a per-entry fallback instead of rejecting the whole page, since `read_notes` results are persisted board data that outlives schema changes. Add a test with a mixed legacy/current entry list.
