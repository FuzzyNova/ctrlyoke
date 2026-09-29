# Ctrl+click does nothing on `#sym:` references with `./` or `../` paths

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/completions/PromptLinkProvider.ts` (around lines 156-165, `findSymbolLinks`)
- **Severity:** low

## Symptom

In a workflow file, `#selection:./a.ts:1-5` is a clickable link but `#sym:./a.ts:foo:1-5` is not.
At run time the `#sym:` reference expands correctly (`ContextExpander.resolveReference` passes the
definition directory), so only editor navigation is broken.

## Root Cause

`provideDocumentLinks` passes `sourceDefinitionDir` to every link finder except `findSymbolLinks`.
`resolveReferencePath` throws for definition-relative (`./`, `../`) paths when no source definition
directory is provided, and the link is silently dropped.

## Suggested Fix

Thread `sourceDefinitionDir` into `findSymbolLinks` and on to its `resolveReferencePath` call, the
same way the other finders do. Add a link-provider test for `#sym:./a.ts:foo:1-5`.
