# claim_paths tool view falls back to generic JSON when a denied owner lacks `kind`

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/ui/webview-react/components/output/ctrlyoke-tools/claimPathsModel.ts`
- **Severity:** low

## Symptom

A `claim_paths` result whose denied entry's `owner` has no `kind` (participants stored before `kind` existed) makes `parseClaimPathsResultText` return `undefined`, so the row renders as raw generic MCP JSON and the denial warning is lost.

## Steps to Reproduce

1. Parse `{"granted":[],"denied":[{"path":"a","owner":{"participantId":"p","label":"l","attested":true,"attribution":"…"}}],"claims":[]}`.
2. Result is `undefined`.

## Root Cause

`parseOwner` requires `kind` to be one of the two known participant kinds. The server passes stored participants through unchanged (`serializeParticipant`) and itself tolerates a missing kind via `resolveCoordinationParticipantKind` (`src/utils/CoordinationAttribution.ts`). Same class as the fixed `read-notes-view-rejects-entries-without-participant-kind.md`, but in a different parser.

## Suggested Fix

Accept a missing `kind` and resolve it the same way `readNotesModel.ts` / `resolveCoordinationParticipantKind` do; ideally share one participant parser between both models.
