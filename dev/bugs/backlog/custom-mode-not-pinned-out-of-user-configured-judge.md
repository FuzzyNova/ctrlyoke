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

### Update 2026-11-18: headless Codex is now exposed too

Since session-control Stage 5, headless Codex runs on `codex app-server`, and
`custom` (or `auto`) with `headlessApprovals: ask` passes
`-c approval_policy="on-request"` (`CodexHarnessAdapter`, app-server branch) with no
reviewer pin. A user-level `approvals_reviewer = "auto_review"` would then send those
escalations to Codex's auto reviewer instead of to ctrlyoke's dashboard approval card,
so `ask` silently becomes "judge decides". Headless `deny` is unaffected
(`approval_policy="never"`).

**Status (2026-11-18):** the Codex half is fixed. `CodexToolPermissionMapper` pins
`approvals_reviewer=user` (`CODEX_APPROVALS_REVIEWER_OVERRIDES.MANUAL`) for `custom` and
`allowAll` in interactive and headless launches, app-server included; mapper and adapter
tests assert it, and the inline-config harness case "custom refuses an unlisted command with
a user-configured judge" confirmed it on Codex 0.169.0 with `approvals_reviewer =
"auto_review"` in an isolated `CODEX_HOME`. The Copilot caveat and
`docs/workflows/permissions.md` now warn that `defaultPermissionMode: "assisted"` also judges
interactive `custom` steps (Copilot's `--help` lists no flag that forces manual approval). The
Copilot live probe below, including the ACP launch, is still open.

## Suggested Fix

- **Codex (done): pin without a probe.** The value is confirmed from source:
  `ApprovalsReviewer` serializes as `"user"` or `"auto_review"`
  (`codex-rs/app-server-protocol/src/protocol/v2/shared.rs`), and `user` is the default
  (`config_tests.rs`, `approvals_reviewer_defaults_to_manual_only…`). Pinning the default is
  harmless when the user has not changed it. In `CodexToolPermissionMapper.buildCodexSpecificArgs`
  emit `-c approvals_reviewer="user"` for every non-`auto` mode that can reach an approval
  (interactive `custom` and `allowAll`), and in the app-server branch whenever
  `approval_policy` is `on-request` and the mode is `custom`. Keep the value in
  `CodexProtocolConstants`. Mapper and adapter tests assert the pin. The live probe is then
  only a confirmation, not a gate.
- Copilot: look for a flag that forces manual approval for the session. If
  none exists, change the caveat and docs to warn that
  `defaultPermissionMode: "assisted"` also affects `custom` steps, and
  recommend `/permissions assisted` per session instead. Still needs the probe. Since
  Stage 6a, headless `custom` on 1.0.112+ runs over ACP, so probe that launch too: if
  `defaultPermissionMode: "assisted"` applies there, `session/request_permission` may never
  reach ctrlyoke's `deny`/`ask` policy.

Add mapper tests asserting the pin, and a harness-suite case for "custom
refuses an unlisted command with a user-configured judge".
