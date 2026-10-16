# Qwen receives `@"quoted path"` references, which its parser can't read

- **Found:** 2026-10-15 by Claude Code (bug-hunt final step; read from the installed Qwen 0.25.1 bundle, not run)
- **Area:** `src/core/harness/CliIntegration.ts` (`formatFileReference`/`formatTempFileRef`), `src/core/harness/qwen/QwenCliProvider.ts`
- **Severity:** medium

## Symptom

A path with a space reaches Qwen as `@"docs/Design Notes.md"`, and Qwen reads it as the path
`"docs/Design`. Nothing is attached and no error is shown. Qwen logs the failed lookup only at
debug level. This also hits ctrlyoke's own prompt, agent and skill temp files when absolute paths
are on and the workspace path contains a space (e.g. `C:\Users\John Smith\proj`).

## Steps to Reproduce

1. Use a workspace path containing a space, with `ui.useAbsolutePathReferences` on (or a
   multi-root workspace).
2. Run a `qwen-cli` step.
3. The temp prompt file reference is quoted, and Qwen doesn't attach it.

## Root Cause

`CliIntegration.ts:483` and `:501` wrap paths containing a space in double quotes for every
harness, and `QwenCliProvider.formatFileReference` (`:849-850`) prefixes `@`. Qwen's
`parseAllAtCommands` ends a path at any unescaped whitespace and doesn't strip quotes, and its
`unescapePath` does nothing on win32. Claude does parse `@"…"`.

## Suggested Fix

Give providers control over quoting, so Qwen can backslash-escape spaces on POSIX. Windows has no
`@` form that can express a space, so Qwen needs a fallback there: a plain path for the model to
read itself, or inline content. **Not queued:** the Windows fallback is a design choice, and this
hasn't been verified end to end against a live Qwen.
