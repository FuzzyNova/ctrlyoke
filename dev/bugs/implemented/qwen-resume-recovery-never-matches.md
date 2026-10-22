# Qwen resume-error recovery never matches Qwen's error text

- **Found:** 2026-10-21 by a research subagent (Qwen minimum-version review), from Qwen Code source 0.14.0–0.25.3
- **Area:** `src/core/harness/qwen/QwenCliProvider.ts` (`isRecoverableSessionError`)
- **Resolution:** fixed in this commit

## Symptom

When a resumed Qwen session no longer exists, the step fails instead of falling back to a new
session, as other harnesses do.

## Steps to Reproduce

1. Run a Qwen step that resumes a session ID Qwen no longer has (delete it from
   `~/.qwen/projects/<cwd>/chats/`).
2. Qwen prints ``No saved session found with ID <id>. Run `qwen --resume` without an ID…``.
3. ctrlyoke does not retry without `--resume`; the step fails.

## Root Cause

`QwenCliProvider.isRecoverableSessionError()` looks for `invalid session`, `session not found`
and `--resume requires a valid session`. None of them matches Qwen's actual message, which has
been the same from 0.14.0 through 0.25.3.

## Suggested Fix

Match `No saved session found with ID` (keep the existing patterns), and add a unit test with the
real message. Confirm the text against the installed Qwen before fixing.
