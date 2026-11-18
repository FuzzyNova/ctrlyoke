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

### Source reading (2026-11-18, `C:\dev\qwen-code`)

Narrows the candidates; still not confirmed live.

- **Not the matcher itself.** `matchesCommandPattern` (`core/src/permissions/rule-parser.ts`)
  is a literal prefix regex with `( .*)?` for a trailing ` *`; escaped backslashes and quotes
  compare byte for byte.
- **Not the auto-mode strip.** `isDangerousBashRule` drops `node … *` allow rules, but only
  in `auto`; commit generation runs `custom` (`--approval-mode default`).
- **Candidate 1: compound splitting.** Before matching, `splitCompoundCommandSegments`
  splits the command at operators. When the command contains a backslash it scans twice
  (`bash` and `escape-everywhere` readings) and splits wherever **either** reading finds an
  operator. The `escape-everywhere` reading treats `\` as an escape even inside `'…'`. The
  `--args '{"message":"…"}'` JSON is full of `\n` and `\"`, and a message with `&`, `|` or
  `;` can therefore be split in that reading. The trailing segment does not start with the
  prefix, so the compound command is not allowed.
- **Candidate 2: argv transport.** ctrlyoke passes every rule in one comma-joined
  `--allowed-tools` value, and Qwen splits it on `,` (`cli/src/config/config.ts`,
  `allowed-tools` coerce). A prefix with a comma, or quoting changes through the Windows
  launch, would break the specifier. Check the `--allowed-tools` value in the session log.

## Suggested Fix

1. First check, no paid run: from the failing case's session log and Qwen chat log, take
   the exact `--allowed-tools` value and the exact command, and feed them to
   `matchesCommandPattern` and `splitCompoundCommandSegments` from Qwen's built package in a
   scratch script. That tells you which candidate it is.
2. If candidate 1: keep the free-form message out of the shell command. Have the skill
   command take the message from a file or stdin (for example `--args-file <path>` with the
   commit output directory, written by the model's write tool under a `write(<that file>)`
   allow), so the command line has no JSON to split. That fixes every harness's matcher
   class of problem, not just Qwen's.
3. If candidate 2: move Qwen's rules from argv into a `permissions.allow` list in the
   per-run settings file `QwenSystemSettings` already manages. JSON is lossless and has no
   comma splitting.

Add the finding to the Qwen section of
`.github/instructions/harness-adapters.instructions.md`.
