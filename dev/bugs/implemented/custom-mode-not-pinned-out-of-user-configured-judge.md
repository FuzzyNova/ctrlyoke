# `custom` does not pin Copilot or Codex out of a judge the user enabled in their own config

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli), reviewing the `auto` permission mode commits
- **Area:** `src/core/harness/copilot/CopilotToolPermissionMapper.ts` (`prepare`, custom branch), `src/core/harness/codex/CodexToolPermissionMapper.ts` (custom/allowAll args), `src/types/CompatibilityTypes.ts` (Copilot auto caveat text), `docs/workflows/permissions.md`
- **Resolution:** fixed in this commit. Codex pins the manual reviewer; Copilot has no per-run manual override for an assisted user default, so its caveat and permissions guide now warn that interactive `custom` steps are judged too.

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

Verification and findings:

1. Codex 0.169.0's config schema accepts reviewer values `user`,
   `auto_review`, and the legacy `guardian_subagent`; `user` is the manual
   reviewer. A targeted harness case used a throwaway `CODEX_HOME` with
   `approvals_reviewer = "auto_review"` and confirmed that `custom` refuses an
   unlisted command requiring sandbox escalation after ctrlyoke pins
   `approvals_reviewer=user`.
2. Copilot's `--help` exposes `--assisted-approval`, which enables the judge,
   but no flag or environment variable that forces manual approval. Its config
   help says `defaultPermissionMode` applies to new interactive sessions, so
   the global assisted setting also affects interactive `custom` steps. No
   live Copilot probe was run; the finding is based on CLI help and config
   documentation.

## Root Cause

The mappers rely on the harness default being manual approval, so a user-level
config that turns the judge on is inherited by `custom` runs.

## Suggested Fix

Codex now emits `-c approvals_reviewer=user` for `custom` and `allowAll` in
interactive and headless runs; `auto` remains on `auto_review`. Copilot's
caveat and permissions guide explain that its global assisted default also
judges interactive `custom` steps and recommend `/permissions assisted` per
session when users want interactive Auto. Mapper tests and the targeted Codex
harness regression cover the pin.
