# OpenCode commit message tool sometimes called before its MCP server loads

- **Found:** 2026-11-10 by the 0.6.0 `npm run test:harness` run (OpenCode 2.2.7, `opencode/claude-haiku-5-5`)
- **Area:** `src/core/harness/opencode/`, commit message generation
- **Resolution:** fixed in this commit

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

Confirmed with a probe MCP server that delays its `initialize` reply. `opencode run
--standalone` starts the first model step without waiting for local MCP servers to connect, so
the tool is missing from the first tool list. OpenCode 2.2.7 has no option to wait for them.
ctrlyoke's server answers `initialize` in about 180 ms, so the gap is on OpenCode's side. When
the model guessed a name (`ctrlyoke-commit-submit_commit_message` is Copilot's spelling;
OpenCode's is `ctrlyoke-commit_submit_commit_message`), it got an error and ended the turn.

Asking the model to "wait" does not help: a headless model has no wait action and simply gives
up. Each failed tool call does give OpenCode another step, and OpenCode rebuilds the tool list
on every step, so a model told to keep calling the tool switches to the real name once the
server connects.

## Fix

`MCP_STARTUP_RETRY_INSTRUCTION` in `src/utils/McpToolDefinitions.ts` tells the model to keep
calling the tool (or keyword-search for it, on harnesses with a tool-search tool such as Qwen)
up to 10 times. It is appended to the commit message prompt and replaces the harness tests'
old "wait up to one minute" wording, which models could not act on. With a server that takes
5 s to connect, Haiku through OpenCode succeeded on its second to fourth attempt in every
probe run, and the commit case passes on all six harnesses.

Commit generation no longer falls back to response text when nothing is submitted; it
retries through the commit-message skill and otherwise fails with an error.
