# The prompt editor's first `!` secret completion takes about ten seconds to open

- **Found:** 2026-10-19 by Claude Code while recording the prompt editor clip (`npm run media -- prompt-editor`)
- **Area:** `src/ui/SecretRegistryService.ts`, the prompt editor's `!` completion source
- **Resolution:** fixed in this commit

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

Not profiled. The likely cause: the first completion request built the full registry for both
scopes (`getCompletionNames` → `list(USER)` and `list(WORKSPACE)`). That scanned every workflow
file in the workspace twice, and read each name's value and metadata from the OS credential
store (`ensureCredentialSnapshot`). On Windows that is one Credential Manager call per key, and
the capture host also had this machine's real user-scope secrets to read.

A second problem made it look worse: the `!CODEC` text became a chip as soon as it matched,
while the list was still loading, so the editor looked finished with nothing to offer.

## Fix

- `getCompletionNames` now collects names only, through the same `collectScopeNames` that
  `list` uses: the managed-name index (one `keys()` call) plus the workflow and MCP references.
  It reads no credential value or metadata, and it scans the workflow files once for both scopes.
- The prompt editor no longer turns the reference being typed into a chip
  (`createAtomicReferenceExtension` in `CodeMirrorEditor.tsx`). It stays text while the caret is
  typing at it, or while a completion list is open or loading there. It becomes a chip when a
  space follows, a completion is picked, or the caret moves away. `Ctrl+Space` with the caret at
  a chip's end shows the chip as text with its list open.
