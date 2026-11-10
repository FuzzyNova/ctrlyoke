# OpenCode commit message tool sometimes called before its MCP server loads

- **Found:** 2026-11-10 by the 0.6.0 `npm run test:harness` run (OpenCode 2.2.7, `opencode/claude-haiku-5-5`)
- **Area:** `src/core/harness/opencode/`, commit message generation
- **Severity:** low

## Symptom

`opencode-cli: headless commit allow-list lets the submit tool run` failed once in three runs.
The model called `ctrlyoke-commit-submit_commit_message` and OpenCode answered
`No tool named "ctrlyoke-commit-submit_commit_message" is currently available`. The model
then ended its turn, so no commit message was submitted, and the workflow still reported
success. The two re-runs passed in about 4 s each.

## Steps to Reproduce

1. Generate a commit message with the OpenCode harness (or run the case above) repeatedly.
2. Occasionally the first tool call lands before the `ctrlyoke-commit` server is connected.

## Root Cause

Not confirmed. It looks like a startup race: `opencode run` starts the turn before the
attached stdio MCP server has listed its tools, and the model gets no second chance because the
prompt says to call the tool exactly once.

## Suggested Fix

Check whether OpenCode 2 has a way to wait for MCP servers before the first turn. Otherwise
tell the model to retry once if the tool is not available yet, as the harness tests already do
for Antigravity's MCP prompts. Commit message generation should also fail visibly when the
submit tool was never called, instead of reporting success.
