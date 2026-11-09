# Hosted workspace viewer routes returned inconsistent error statuses

- **Found:** 2026-11-08 by smell-hunt pass 4
- **Area:** `src/server/CtrlYokeHostedServer.ts`
- **Resolution:** fixed in this commit

## Symptom

Some workspace-viewer routes returned generic 500 or mutation 400 responses for
errors that other routes already mapped to their intended HTTP status.

## Root Cause

Route handlers duplicated error mapping. The three entry mutations returned 400
for `Path not allowed`; `/git-ref-diff` returned 500 for `WorkspaceTreeHttpError`
while its paged sibling preserved its status.

## Resolution

The shared known-error mapping now returns 403 for DELETE `/entry`, POST `/copy`,
and POST `/move`, and preserves `WorkspaceTreeHttpError` status on GET
`/git-ref-diff`. The dashboard client does not branch on 400 versus 403 for
these routes.
