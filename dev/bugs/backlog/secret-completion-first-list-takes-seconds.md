# The prompt editor's first `!` secret completion takes about ten seconds to open

- **Found:** 2026-10-19 by Claude Code while recording the prompt editor clip (`npm run media -- prompt-editor`)
- **Area:** `src/ui/SecretRegistryService.ts`, the prompt editor's `!` completion source
- **Severity:** medium

## Symptom

In a freshly started host, typing `!CODEC` in the prompt editor turned the text into a chip at
once, but the completion list did not appear for about 10 s (the take's `secret-open:typed` and
`secret-open:listed` beats were 11.6 s apart, during which nothing else ran). Every other trigger
(`#`, `@`, `$`, `~`, `/`) listed in well under a second. A person sees a dead editor and assumes
there are no secrets.

## Steps to Reproduce

1. `npm run media -- host prompt-editor` (or any fresh dev host on Windows), open the dashboard.
2. Load any workflow, click the prompt editor and type `!`.
3. The list takes several seconds to appear the first time; later `!` lists are fast.

## Root Cause

Not yet confirmed. The first completion request builds the registry for both scopes
(`getCompletionNames` → `list(USER)` and `list(WORKSPACE)`), which scans every workflow file in
the workspace and reads each name's value and metadata from the OS credential store
(`ensureCredentialSnapshot`). On Windows that is one Credential Manager call per key, and the
capture host also had this machine's real user-scope secrets to read.

## Suggested Fix

Profile the first `getCompletionNames` call. The completion only needs names, so it should not
wait on credential values or metadata. Return names from the managed-name index and workflow
scan first, and fill state in afterwards, or warm the registry when the dashboard starts.
