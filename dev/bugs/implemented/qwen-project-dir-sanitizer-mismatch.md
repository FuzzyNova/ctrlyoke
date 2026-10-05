# Qwen log discovery computes the wrong project directory for paths containing `.`, `_`, spaces, or uppercase on POSIX

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli); verified against `~/.qwen/projects` on this machine
- **Area:** `src/core/harness/qwen/QwenLogParser.ts` (`getQwenProjectDirectory` ~1236-1245)
- **Resolution:** fixed in this commit

## Symptom

For workspace `C:\dev\ctrlyoke.worktrees\small-feature`, Qwen writes logs to
`~/.qwen/projects/c--dev-ctrlyoke-worktrees-small-feature`, but ctrlyoke looks in
`c--dev-ctrlyokeworktrees-small-feature`, which doesn't exist. Prompt-matching
discovery (`discoverSessionLog` with no session ID, used by `resolveWithoutSessionStart`
or when a hook never fires) returns null, so Qwen output and completion detection fail in
that fallback.

## Root Cause

ctrlyoke lowercases the path unconditionally, turns only `: \ /` into `-`, and _deletes_
every other non-alphanumeric character. Qwen's `sanitizeCwd` (qwen 0.24.x) replaces
every non-alphanumeric character with `-` and lowercases only on win32.

## Suggested Fix

Match Qwen exactly: `(process.platform === "win32" ? p.toLowerCase() : p).replace(/[^a-zA-Z0-9]/g, "-")`.
Update the comment and add unit tests for dotted, underscored and spaced paths.
