# `custom` does not pin Copilot or Codex out of a judge the user enabled in their own config

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli), reviewing the `auto` permission mode commits
- **Area:** `src/core/harness/copilot/CopilotToolPermissionMapper.ts` (`prepare`, custom branch), `src/core/harness/codex/CodexToolPermissionMapper.ts` (custom/allowAll args), `src/types/CompatibilityTypes.ts` (Copilot auto caveat text), `docs/workflows/permissions.md`
- **Severity:** medium (security; low confidence until probed)

## Symptom

`.github/instructions/harness-adapters.instructions.md` says `custom` must
explicitly pin every supported harness out of its judged auto mode. Claude
(`--permission-mode default`/`dontAsk`), Qwen (`--approval-mode default`)
and agy (`agentMode: ""`) do. Copilot and Codex don't:

- **Copilot** `custom` passes only `--allow-tool`/`--deny-tool`. ctrlyoke's
  own Copilot interactive auto caveat and `docs/workflows/permissions.md`
  tell users to set `defaultPermissionMode: "assisted"` in
  `~/.copilot/settings.json`. That file is global, so once a user follows the
  advice, every interactive Copilot `custom` step presumably runs under the
  judge, and the allow list stops being the limit on what runs unprompted.
- **Codex** `custom` interactive passes `-a on-request` and nothing for the
  reviewer. If `~/.codex/config.toml` sets `approvals_reviewer = "auto_review"`,
  custom-mode escalations would go to the auto reviewer, which the auto-mode
  plan's probe showed approving a sandbox escalation to write outside the
  workspace.

## Steps to Reproduce

Not yet probed live. Expected reproduction:

1. Copilot: set `defaultPermissionMode: "assisted"`, run an interactive
   `custom` step allowing only `shell(echo:*)`, and ask it to run
   `echo hi && node x.js`. Expected under `custom`: an approval prompt.
   Suspected: the judge approves it.
2. Codex: add `approvals_reviewer = "auto_review"` to `config.toml`, run an
   interactive `custom` step, and ask it to write outside the workspace.
   Expected: an approval prompt. Suspected: the reviewer approves it.

## Root Cause

The mappers rely on the harness default being manual approval, so a user-level
config that turns the judge on is inherited by `custom` runs.

## Suggested Fix

Probe both cases first.

- Codex: if confirmed, emit an explicit reviewer pin for `custom` and
  `allowAll` (`-c approvals_reviewer=<manual value>`, after checking the value
  name against the Codex CLI).
- Copilot: look for a flag that forces manual approval for the session. If
  none exists, change the caveat and docs to warn that
  `defaultPermissionMode: "assisted"` also affects `custom` steps, and
  recommend `/permissions assisted` per session instead.

Add mapper tests asserting the pin, and a harness-suite case for "custom
refuses an unlisted command with a user-configured judge".
