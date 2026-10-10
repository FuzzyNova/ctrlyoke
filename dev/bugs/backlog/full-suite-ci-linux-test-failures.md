# Weekly `full-suite.yml` CI fails on Linux with 11 extension-host test failures

- **Found:** 2026-10-10 by backlog audit (run `37373416030`, 2026-10-05; every scheduled run since 2026-09-14 has failed)
- **Area:** `.github/workflows/full-suite.yml`, `src/test/unit/**`, `src/core/ContextExpander.ts`, `src/utils/FileAccessPolicy.ts`
- **Severity:** high

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

## Root Cause

Not yet triaged per group; see the hypotheses above. Groups 3 and 4 look like test-only platform
assumptions. Group 1 may be a real behavior difference between Windows and POSIX in reference
serialization and should be decided before the reference syntax is public.

## Suggested Fix

Triage each group on Linux (WSL or a Linux container is enough). Fix the code wherever the
POSIX behavior is wrong. Make tests platform-aware wherever they encode Windows-only behavior.
Then make sure `full-suite.yml` is green before relying on it for releases (RELEASE_CHECKLIST
Phase 13).
