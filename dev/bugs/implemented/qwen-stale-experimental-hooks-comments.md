# Stale `--experimental-hooks` comments in the Qwen provider

- **Found:** 2026-10-21 by a research subagent (Qwen minimum-version review)
- **Area:** `src/core/harness/qwen/QwenCliProvider.ts` (NOTE in `buildCliArgs`), `src/core/harness/qwen/QwenNotificationMonitor.ts` (class comment)
- **Resolution:** fixed in this commit

## Symptom

Two comments say Qwen hooks need the `--experimental-hooks` flag and that
`buildHeadlessUserHookArgs` returns it. Neither is true: the method returns no CLI args, and Qwen
removed the flag in 0.14.0 (hooks are on by default), below the 0.15.5 minimum.

## Steps to Reproduce

1. Read `QwenCliProvider.ts` near the `buildHeadlessUserHookArgs` NOTE and the
   `QwenNotificationMonitor` class comment.

## Root Cause

The comments predate Qwen 0.14.0.

## Suggested Fix

Delete or rewrite both comments: hooks are registered in workspace `.qwen/settings.json` and are
enabled by default from Qwen 0.14.0.
