# LSP Server Root Misses Marker on Drive Letter Case

- **Found:** 2026-11-08 by smell-hunt pass 4
- **Area:** `src/server/lsp/ManagedLanguageServerBackend.ts`
- **Resolution:** fixed in this commit

## Symptom

On Windows, opening a file whose URI uses a lowercase drive letter can cause the
language server to use the workspace root instead of the nearest project root
marker.

## Steps to Reproduce

1. Open a workspace containing a nested project marker such as `app.sln`.
2. Open a source file beneath that project through a URI with a lowercase drive
   letter while the real workspace path has an uppercase drive letter.
3. Observe that the language server is started with the workspace root instead
   of the nested project root.

## Root Cause

`findServerRoot` compared roots and file paths with case-sensitive relative-path
and string-prefix checks. Windows file URIs can lowercase the drive letter while
`fs.realpathSync` returns the native casing, so containment failed and the
nearest marker walk did not run.

## Resolution

Both containment checks now use `isPathWithinDirectory`, which folds case on
Windows. Root path resolution also uses the shared `realpathOrSelf` helper.
