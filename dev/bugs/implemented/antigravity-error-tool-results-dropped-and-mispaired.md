# Antigravity drops failed (`status: "ERROR"`) tool results, so every later result pairs with the wrong call

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced by replaying a real agy `transcript_full.jsonl` through the parser
- **Area:** `src/core/harness/antigravity/AntigravityLogParser.ts` (`mapTranscriptRecord` ~604-610, `toolCallMatchesResult` GENERIC case ~854-861), `src/core/harness/antigravity/AntigravityToolEventBuilder.ts` (`resultSucceeded` ~493)
- **Resolution:** fixed in this commit

## Symptom

When an agy tool call fails (e.g. an MCP validation error such as `post_note.text is
required`), the dashboard shows it as successful, with the output of the _next_ tool
call. Every later tool call in that turn is shifted by one result, and the last call is
left without a result. The wrong outputs also go into prior-context text.

## Steps to Reproduce

Replay a transcript where one `MODEL`/`GENERIC` entry has `status: "ERROR"` and an
`error` field (for example, a failed `post_note` call) through `mapTranscriptRecord` and
`extractResponse`. The failed call gets the following `view_file` output and is
marked successful.

## Root Cause

`mapTranscriptRecord` drops every entry whose status isn't `DONE` (apart from background
launches and ask-question results). The failed call's planner entry therefore stays in
`pendingPlannerToolCalls`. GENERIC results pair with the oldest pending call, so
every later result shifts by one. `resultSucceeded` also never checks
`status === "ERROR"` or `entry.error`.

## Suggested Fix

Map `MODEL` tool-result entries with `status: "ERROR"` so they still consume their
pending call (add `ERROR` to `ANTIGRAVITY_WIRE_VALUES`). Make `resultSucceeded` return
false for an ERROR status or a non-empty `error`, and show the error text as the
output. Add a parser fixture containing an ERROR entry followed by a successful one.
