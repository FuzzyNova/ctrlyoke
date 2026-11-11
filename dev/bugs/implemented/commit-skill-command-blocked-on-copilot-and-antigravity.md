# Commit-message skill command is blocked on Copilot and Antigravity

- **Found:** 2026-11-11 by the new `commit-generation.harness.test.ts` (Copilot `gpt-6-luna`, Antigravity `gemini-3.8-flash-medium`)
- **Area:** `src/git/CommitMessageGenerator.ts` (`COMMIT_MESSAGE_SKILL_COMMAND_PATTERN`), `src/core/harness/copilot/CopilotToolPermissionMapper.ts`, `src/core/harness/antigravity/AntigravityToolPermissionMapper.ts`
- **Resolution:** fixed in this commit

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

## Fix

Shell can't be narrowed on Copilot: its `shell(...)` rules only match a command name (plus a
known subcommand), and `shell(node)` let a `node -e "...writeFileSync..."` probe through. So the
no-MCP run no longer uses a shell command where the harness can do better. It allows writing
one file, the commit output file, and tells the model to write the message there
(`COMMIT_SUBMISSION_CHANNELS.FILE`). The message never passes through a shell, so quoting and
metacharacters stop mattering.

Each harness was probed headless with an allow rule for one absolute path, writing
``feat(x): add `greet` ($HOME) & more`` and then trying a second file:

| Harness           | Rule that works                                                                  | Mapper change                                        |
| ----------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Copilot           | `write(<abs>)`                                                                   | none (already passed through)                        |
| Claude            | `Edit(//<abs>)`; `Write(//<abs>)` lets nothing through                           | absolute `write`/`edit` → `Edit(//…)`                |
| OpenCode 2.2.7    | `edit: {"<path relative to project>": "allow"}`; an absolute key matches nothing | absolute path inside the workspace → relative        |
| Antigravity 1.5.6 | `write_file(<abs>)`                                                              | allow rules keep the path instead of `write_file(*)` |
| Qwen 0.27.1       | none: headless `default` mode drops `write_file` entirely                        | stays on the skill command                           |
| Codex             | none: the sandbox can't allow a single file                                      | stays on the skill command                           |

All four harnesses that can do it now write the allowed file and are denied the second one.
`IToolPermissionMapper.allowsSingleFileWrite` marks them, and `getCommitSubmissionChannels()`
picks the file channel for those and the skill command for the rest. The skill-command prompt
now also names the exact `--commit-output` path, because Qwen sometimes made up its own.
