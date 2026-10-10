# Claude subagent prompts are recorded as human user steers

- **Found:** 2026-10-10 while investigating `pausing-step-reloads-as-completed-and-shows-follow-up.md`
- **Area:** `src/core/harness/claude/ClaudeLogParser.ts`
- **Resolution:** fixed in this commit

## Symptom

In a headless claude-cli final step, every prompt the agent handed to a
foreground subagent (Agent tool) was persisted as a `userSteer` event and
rendered as if the user had typed it. Four such events appear in the bug-hunt
run's final-step passes 2 and 3.

## Steps to Reproduce

1. Run a headless claude-cli step whose agent launches a foreground subagent.
2. The subagent's prompt appears in the output pane as a user steer row.

## Root Cause

Claude's `stream-json` stdout emits a foreground subagent's messages on the main
stream, tagged with `parent_tool_use_id` naming the parent's Agent `tool_use`.
The subagent's prompt is a text-only `user` message, and
`ClaudeLogParser.classifyUserEvent` falls through to `"human-steer"` for any
`user` text that isn't a tool result, task notification, or the dispatched
prompt. Nothing read `parent_tool_use_id`.

## Fix

`classifyUserEvent` returns `"other"` for a `user` event with a non-empty
`parent_tool_use_id`.
