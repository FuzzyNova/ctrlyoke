# Commit skill-command allow rule also matches arbitrary `node` code

- **Found:** 2026-11-11 while fixing `dev/bugs/implemented/commit-skill-command-blocked-on-copilot-and-antigravity.md`
- **Area:** `src/git/CommitMessageGenerator.ts` (`COMMIT_MESSAGE_SKILL_COMMAND_PATTERN`)
- **Resolution:** fixed in this commit. The skill command puts `--args` last, after a prefix that is fixed for the run (`node "<mcp-server.js>" --tool submit_commit_message --workspace "<ws>" --commit-output "<path>" --args`), and the run allows exactly `shell(<prefix>:*)`. `ctrlyoke-mcp --tool` refuses a repeated option, so nothing after the prefix can redirect the call. Checked against Qwen Code 0.27.2's own `matchesCommandPattern`: the real command matches; `node -e …`, another script and another output path do not. Codex still does not enforce allow patterns; its sandbox is the limit there.

## Symptom

The skill-command channel, which Codex and Qwen still use when ctrlyoke's MCP server is not
attached, allows `shell(node:*--tool*submit_commit_message*)`. The wildcards sit in the middle
of the command, so on the harnesses that honor such a rule (Claude as `Bash(node:*…)`, Qwen as
`ShellTool(node *--tool*submit_commit_message*)`), a command like
`node -e "<any code>" --tool submit_commit_message` matches it. The commit run is meant to be
read-only apart from submitting the message.

## Steps to Reproduce

1. Run commit generation on Qwen with `execution.ctrlyokeMcpMode: "skill"`.
2. A model that runs `node -e "require('fs').writeFileSync('x','y')" --tool submit_commit_message`
   is allowed to by the rule.

## Root Cause

The rule was written to match the skill's command loosely, because the command embeds the
message (`--args '{"message":…}'`) and the paths, so no fixed prefix covers it.

## Suggested Fix

Make the skill command fixed so it can be allowed exactly: have the model write the message
where it is allowed to, or pass it on stdin, and allow the literal
`node "<out/mcp-server.js>" --tool submit_commit_message --commit-output "<path>"` prefix. Check
each remaining harness (Codex, Qwen) can express that literal prefix. Codex does not enforce
`allowedTools` patterns at all, so there the limit is its sandbox.
