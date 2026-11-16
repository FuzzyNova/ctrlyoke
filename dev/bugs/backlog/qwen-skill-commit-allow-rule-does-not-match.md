# Qwen skill-mode commit generation is denied: its exact-command allow rule never matches

- **Found:** 2026-11-15 by the orchestrator review of session-control Stage 1, live case
  "qwen-cli: skill mode submits a generated commit message" (`src/test/harness/commit-generation.harness.test.ts`), Qwen Code 0.27.x
- **Area:** `src/core/harness/qwen/QwenToolPermissionMapper.ts`, `src/git/CommitMessageGenerator.ts` (`commitToolPermissions`, `SKILL_COMMAND` channel)
- **Severity:** medium

## Symptom

Skill-mode commit generation on Qwen never submits a message. The model runs exactly the
command it was given:

```
node "C:\dev\…\out\mcp-server.js" --tool submit_commit_message --workspace "C:\…\repo" --commit-output "C:\…\commit-output-skill-command-….txt" --args '{"message":"…"}'
```

Qwen does not treat it as allowed and sends a `can_use_tool` request. Since session-control
Stage 1, ctrlyoke answers with its headless deny message, so the step ends quickly with
"qwen-cli never submitted a commit message". Before Stage 1 the same request had no answer and
the run hung until the prompt timeout (checked against 4aef9927e, where the case was still
running after 10 minutes).

## Steps to Reproduce

1. `npm run test:harness -- --grep "qwen-cli: skill mode"` (or run `ctrlyoke commit` with
   Qwen and the skill submission channel).
2. Read the newest `~/.qwen/projects/*commit-generation*/chats/*.jsonl`: the
   `run_shell_command` call has `"decision":"reject"` and the ctrlyoke deny message.

## Root Cause

Not traced yet. `commitToolPermissions` allows `shell(<exact prefix>:*)`, which
`QwenToolPermissionMapper.buildQwenShellSpec` turns into `ShellTool(<prefix> *)` in
`--allowed-tools`. The command Qwen runs starts with that prefix byte for byte, so the likely
cause is that Qwen's shell-rule matcher splits or unescapes the double-quoted Windows paths
(backslashes) or the single-quoted JSON argument differently from the literal prefix. Native
mode and the MCP channel are unaffected.

## Suggested Fix

Probe Qwen's matcher with the generated `ShellTool(...)` specifier, using a quoted
backslash path and a forward-slash path, to find the form it matches. Then either emit
that form for Qwen, or have the commit skill command use forward-slash, unquoted-where-safe
paths on every harness. Add the finding to the Qwen section of
`.github/instructions/harness-adapters.instructions.md`.
