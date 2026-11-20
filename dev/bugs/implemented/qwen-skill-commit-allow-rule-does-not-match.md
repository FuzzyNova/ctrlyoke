# Qwen skill-mode commit generation is denied: its exact-command allow rule never matches

- **Found:** 2026-11-15 by the orchestrator review of session-control Stage 1, live case
  "qwen-cli: skill mode submits a generated commit message" (`src/test/harness/commit-generation.harness.test.ts`), Qwen Code 0.27.x
- **Area:** `src/core/harness/qwen/QwenToolPermissionMapper.ts`, `src/git/CommitMessageGenerator.ts` (`commitToolPermissions`, `SKILL_COMMAND` channel)
- **Resolution:** fixed in this commit

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

Qwen 0.27.4's `matchesCommandPattern` normalizes the command through `shell-quote`: it removes
quote delimiters and interprets backslashes in quoted Windows paths as escapes. The allow
specifier retains its quotes and backslashes, so it does not match the normalized command.
`parseRules` correctly resolves `ShellTool(...)` to `run_shell_command`, but
`evaluateSingle` returns `default`; `PermissionManager.evaluate` then resolves the
non-read-only `node` command to `ask`. The virtual-operation pass extracts no operations, and
the Windows `splitCommandForRules` branch returns one segment, so neither stage causes the
refusal. Qwen's allow specifier must use the same normalized spelling (unquoted, forward-slash
Windows paths) while the command shown to the model retains shell quotes and remains narrowly
scoped.

### Source probe (2026-11-18, Qwen Code v0.27.4)

Ran `npx tsx` against the matching `v0.27.4` source checkout after `pnpm install
--ignore-scripts`, using the captured Windows command shape, its generated `ShellTool(...)`
allow, and Qwen's `WriteFile`/`Edit` translations of ctrlyoke's `write`/`edit`/`multiedit`
denies. The probe logged every evaluation stage:

- `parseRules` returned an allow rule with `toolName: "run_shell_command"` and the expected
  prefix specifier; deny rules parsed as `write_file` and `edit`.
- `splitCommandForRules` used the Windows `cmd` branch, delegated to
  `splitCompoundCommand`, and returned one segment.
- `extractShellOperationsAcrossCommand` returned `[]`; the virtual-operation decision was
  `default`.
- `evaluateSingle` returned `default` for the shell call because the command pattern did not
  match. `evaluate` then returned `ask` through `resolveDefaultPermission` for the
  non-read-only `node` command. Applying Qwen's command normalization to the exact prefix
  (remove quote delimiters and use forward slashes for Windows paths) made the matcher return
  true.

This identifies the evaluator stage that refused the command; compound splitting and
comma-separated argv transport were not the cause.

## Suggested Fix

1. `buildCommitMessageSkillCommandPrefix` renders Windows paths with forward slashes for the
   command shown in the generated skill text. Qwen's mapper removes shell quote delimiters
   and uses that same path spelling in its command rule. Keep the write/edit/multiedit denies
   and do not add a wildcard inside the command.

The durable Qwen matcher constraint is recorded in
`.github/instructions/harness-adapters.instructions.md`.
