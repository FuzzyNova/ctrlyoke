# `ctrlyoke step edit` reports "exactly one workflow step" for missing/invalid files

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/cli/StepCommands.ts`
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke step edit missing.yaml --workflow <key> --run 1 --index 3` (file does not exist) and the same command with a schema-invalid file both print `Error: Edit source must contain exactly one workflow step` (exit 2), hiding the real cause.

## Steps to Reproduce

1. Run the command above with a nonexistent path, or with a file containing `harness: bogus-cli`.
2. Observe the misleading error.

## Root Cause

The edit-source loader returns `parsed?.steps ?? []`, collapsing a `null` parse result (missing file, schema failure) into an empty step list; the parser has no feedback sink so its real error only reaches the log.

## Suggested Fix

Mirror `parseAppendTail` in `src/cli.ts`: pass a `ConsoleUserFeedbackSink` to the parser and on a `null` result throw the parser's error (or `Failed to load step file: <path>`). Ideally share one helper between append and step edit.
