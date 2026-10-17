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

Give providers control over quoting, so Qwen can backslash-escape spaces on POSIX.

**Decision (2026-10-16):** on Windows, a path containing a space is sent to Qwen as a plain path
with no `@` (quoted, so the model can read the whole path), and the model reads the file itself
with its own tools. Paths without a space keep the `@` form. Content is not inlined.

- The plain-path form needs a short instruction around it (e.g. "Read the file at …") when it
  replaces a temp prompt, agent or skill file reference, because the model must act on it.
- Verify against a live Qwen first: that `\ ` escaping attaches the file on POSIX, and that the
  plain-path fallback is read on Windows. The finding came from reading the Qwen 0.25.1 bundle.
- Tests: `QwenCliProvider` formats a spaced path as an escaped `@` reference on POSIX and as a
  plain path on win32; unspaced paths are unchanged; other providers keep `@"…"`.
