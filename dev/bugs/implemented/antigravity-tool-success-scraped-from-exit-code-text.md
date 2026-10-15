# Tool success is inferred by scraping 'exit code: N' from any tool result's content, including file contents

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/antigravity/AntigravityToolEventBuilder.ts`
- **Resolution:** fixed in this commit

## Symptom

On the antigravity-cli harness, a `view_file`, `grep_search`, MCP or other non-command tool call that worked is shown as FAILED (`success=false`) in the dashboard when its output contains text like `exit code: 1`, `exit_code=2` or `exited with code 1`. This happens, for example, when the tool reads a CI log, a shell script or ctrlyoke's own sources.

## Steps to Reproduce

1. Run a workflow step on the antigravity-cli harness (agy 1.1.12+, where every tool result is typed `GENERIC`).
2. Ask the model to `view_file` a file that has a line such as `echo "exit code: 1"` (for example `src/core/harness/antigravity/AntigravityToolEventBuilder.ts` or a CI log), or to `grep_search` for `exit code`.
3. agy writes a transcript entry `{source:MODEL, type:GENERIC, status:DONE, content:"File Path: ...\n12: echo \"exit code: 1\"..."}` with no `success` or `exit_code` field.
4. `AntigravityToolEventBuilder.build` calls `resultSucceeded()` (line 54), which calls `exitCode()`. The content regex matches and returns `1`, so `success=false`.
5. The dashboard shows the file read, search or MCP call as FAILED even though the tool succeeded.

## Root Cause

In `src/core/harness/antigravity/AntigravityToolEventBuilder.ts:505-508`, `resultSucceeded()` treats any exit code returned by `exitCode()` as authoritative for every tool type. `exitCode()` (lines 544-566) has no structured `exit_code`/`exitCode` field to read here, so it falls back to an unanchored regex at lines 558-560:

```ts
/(?:exit\s*code|exit_code)\s*[:=]\s*(-?\d+)|exited with code\s+(-?\d+)/i
```

It runs this regex over the whole `entry.content`, and that content can be arbitrary file or tool output. agy now types every tool result `GENERIC` (`AntigravityLogParser.ts:811-818`), so `entry.type` cannot narrow the check. The fallback therefore runs for `view_file`, `grep_search`, MCP and other results, which have no explicit success field and only carry `status: DONE`.

## Suggested Fix

- Scrape content for an exit code only when the result is a command or a background-task result. Pass the resolved tool name into `resultSucceeded`/`exitCode`, and apply the content regex only for `run_command` or for a `SYSTEM_MESSAGE` background-task completion. For every other tool, use only the structured `exit_code`/`exitCode` fields.
- Anchor the pattern to agy's known phrasing: a leading `^Exit code: N` line for `run_command` output, and `exited with code N` in completion messages.
- Add a unit test in which a `view_file` `GENERIC` result whose content includes `exit code: 1` still produces a COMPLETED `FILE_READ` event.
