# Weekly `full-suite.yml` CI fails on Linux with 11 extension-host test failures

- **Found:** 2026-10-10 by backlog audit (run `37373416030`, 2026-10-05; every scheduled run since 2026-09-14 has failed)
- **Area:** `.github/workflows/full-suite.yml`, `src/test/unit/**`, `src/core/ContextExpander.ts`, `src/utils/FileAccessPolicy.ts`
- **Resolution:** fixed in this commit. Linux verification unavailable: WSL Ubuntu has no
  Node.js installation.

## Symptom

The extension-host suite on `ubuntu-latest` under Xvfb ends with `5499 passing, 18 pending,
11 failing`. The same suite passes locally on Windows, so CI can't gate a release. The failures
fall into four groups:

1. **Absolute-path quoting in references (8 tests):** `ContextExpander.expandContextSplit`
   "renders the same absolute source path…", four `ContextExpander.sanitizeReferences` cases
   (`#sym:`, `#sym.class:`, `#selection:`, source-store `#sym:`), `CliIntegration`
   "buildPromptSections … rewrites a folder-prefixed #sym: ref", and two
   `ContextMenuReferenceCommands` tests (external and already-trusted targets). The tests expect
   `#selection:"/tmp/…/b.ts":1-2` and `@"/tmp/…/external.ts"`, but the code emits the path
   unquoted on Linux. Either the tests hardcode Windows behavior (quoting because of the `C:`
   drive colon), or the code's "needs quoting" rule differs by platform when it shouldn't. Decide
   which is intended. An unquoted POSIX path inside `#sym:<path>:<symbol>:<range>` is parseable
   only if the parser splits from the right.
2. **`FileConfigBackend` "serializes concurrent writes from backends for the same path":**
   `TypeError: Cannot read properties of undefined (reading 'showCliCommand')` at
   `CtrlYokeConfigService.test.js:706`. A settings read returns `undefined` for a section,
   probably a race or a case-sensitive path difference on Linux.
3. **`CtrlYokeHostedServer` "static fallback blocks NTFS aliases for protected files without a
   token":** `/.%5CINDEX~1.HTM` returns 404 on Linux, but the test expects 401. NTFS short names
   don't exist on ext4, so the request never reaches the token check. The test probably needs to
   accept 404 on non-win32, or be skipped there.
4. **`FileAccessPolicy` "matches a differently-cased candidate against a trusted root on
   win32":** returns `false` on Linux. The test simulates win32 but the code under test probably
   still uses the host's `path` module (`path.posix`), so case folding never happens. Inject
   `path.win32` or the platform into the comparator.

## Steps to Reproduce

1. `gh run view 37373416030 --log-failed`, or trigger `full-suite.yml` manually.
2. Read the `11 failing` block at the end of the extension-host shard.

## Root Cause and Fix

1. **Absolute-path quoting:** the assertions encoded Windows drive-colon quoting. On POSIX, an
   absolute path has no colon or whitespace, so it is intentionally emitted unquoted. The `@`,
   `#selection:`, and `#sym:` parsers round-trip that form; the tests now derive expected strings
   with the shared reference-field serializer, and a parser test covers all three forms.
2. **Concurrent config writes:** backends shared a write queue keyed by `path.resolve()`, but file
   reads and atomic writes still used each backend's original path. A `nested/../settings.json`
   alias fails on POSIX when `nested` does not exist. File I/O now uses the resolved path too.
3. **NTFS aliases:** the alias status assertion applies only on Windows, where NTFS short names and
   alternate data streams exist. The test is skipped on other platforms and retains its Windows
   assertions.
4. **Windows path comparison:** the test changed `process.platform`, but the comparator still used
   the host's `path.sep`. The comparison now accepts injected path and platform semantics; the
   test uses `path.win32` on every host while normal production calls keep the real host defaults.

`npm run typecheck`, `npm run lint`, and `npm test` pass on Windows. Linux execution could not be
verified because the available WSL Ubuntu installation does not have Node.js; the recorded GitHub
Actions failure log was used to confirm the original Linux failures.
