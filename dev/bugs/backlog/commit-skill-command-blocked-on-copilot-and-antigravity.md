# Commit-message skill command is blocked on Copilot and Antigravity

- **Found:** 2026-11-11 by the new `commit-generation.harness.test.ts` (Copilot `gpt-6-luna`, Antigravity `gemini-3.8-flash-medium`)
- **Area:** `src/git/CommitMessageGenerator.ts` (`COMMIT_MESSAGE_SKILL_COMMAND_PATTERN`), `src/core/harness/copilot/CopilotToolPermissionMapper.ts`, `src/core/harness/antigravity/AntigravityToolPermissionMapper.ts`
- **Severity:** medium

## Symptom

With `execution.ctrlyokeMcpMode: "skill"`, and as the fallback after a native MCP run that
submits nothing, commit generation fails on Copilot and Antigravity with "never submitted a
commit message". The model runs the skill's
`node "<out/mcp-server.js>" --tool submit_commit_message --args '{"message":…}' …` command and
the harness refuses it:

- Copilot: "Permission denied because no interactive user response was available."
- Antigravity: "permission check failed for unsandboxed …".

Claude, Codex, OpenCode and Qwen run the same command. Before the response-text fallback was
removed, the model's "I couldn't submit the commit message…" reply became the commit message
instead.

## Steps to Reproduce

1. In a repo with a staged change, set `commit.harness` to `copilot-cli` or `antigravity-cli`
   and `execution.ctrlyokeMcpMode` to `skill`.
2. Run `ctrlyoke commit --print-only`.

## Root Cause

The allow rule `shell(node:*--tool*submit_commit_message*)` has wildcards in the middle, and
neither harness can express that:

- Copilot's `shell(command:*?)` rules only match a command name (plus a known subcommand) with
  an optional trailing `:*` (`copilot help permissions`). The rule is passed through unchanged
  and matches nothing.
- `AntigravityToolPermissionMapper` treats only a trailing `:*` as the prefix marker, so it
  escapes the whole text into `command(regex:node:\*--tool\*submit_commit_message\*)`, a literal
  that never matches.

A literal-prefix rule (`node "<path>" --tool submit_commit_message:*`) would not be enough
either. Antigravity's allow tail rejects `;&|`$()<>`, and commit messages routinely contain
backticks and parentheses (`feat(scope): …`), which the skill passes inline in `--args`.

## Suggested Fix

Stop putting the message in shell argv, so a fixed command can be allowed exactly. For
example, have the skill pipe the message on stdin from a quoted heredoc (still shell text), or
have `ctrlyoke-mcp --tool submit_commit_message` read the message from a file the model is
allowed to write only under `.ctrlyoke/temp/` (Copilot and Antigravity both have path-scoped
write rules). Then translate a literal-prefix allow rule for each harness. Simply allowing
`shell(node:*)` would let the read-only commit run execute arbitrary code, so it is not an
option.
