# VS Code prompt diagnostics run unused symbol lookups and miss trust changes

- **Found:** 2026-10-08 by Claude (claude-cli), Wave 2 review of D2 (`5e23a74c9`)
- **Area:** `src/completions/PromptDiagnosticsProvider.ts`, `src/ui/PromptEditorSupportService.ts`
- **Resolution:** fixed in this commit. The open question is answered: a `.prompt.md` named by a step is expanded like inline text, so its body is now linted with the most permissive position context.

## Symptom

1. **Wasted symbol lookups.** Each debounced pass validates every `#sym:` reference through
   `PromptEditorSupportService.validateContextReferences`. That also resolves the symbol's
   kind for the dashboard's chip icon: `findSymbolKindForReference` runs a document-symbol
   query and, on a miss, a workspace-symbol query. The diagnostics provider never reads the
   kind.
   - A file with N `#sym:` references costs N document-symbol requests every 300 ms while
     typing.
   - The same work repeats for every open ctrlyoke file whenever a workspace file is created
     or deleted.
2. **No refresh when trust or settings change.** Approving an external root in the dashboard,
   or changing a setting that affects reference resolution, doesn't re-run diagnostics.
   "Outside approved roots" or "not found" warnings stay until the next edit or save.

## Steps to Reproduce

1. Open a workflow with several `#sym:` references and type in it. The extension host's
   symbol-provider traffic rises with each keystroke burst.
2. With a reference to a file under an untrusted external root, approve that root from the
   dashboard. The squiggle in the open VS Code editor stays.

## Root Cause

1. The provider's validator, wired in `extension.ts` (`new PromptDiagnosticsProvider(...)`),
   calls the same `validateContextReferences` the dashboard uses. Its per-reference
   `validateContextReference` always resolves the symbol kind.
2. `PromptDiagnosticsProvider` subscribes only to document, save and file-system events.

## Suggested Fix

1. Add an option, such as `{ resolveSymbolKind: false }`, on the path the provider uses,
   and/or cache the kind per (path, mtime).
2. Subscribe to the trust store and to `configService`, and call the provider's (debounced)
   refresh-all.

Open question from the same review, not confirmed: a `.prompt.md` body is linted as a single
step, so `$previous` and `$step:N` always warn. When a workflow step's `prompt` points at a
`.prompt.md` file, those references may be valid at runtime. Check whether file-loaded prompts
get prior-context expansion before treating it as a bug.
