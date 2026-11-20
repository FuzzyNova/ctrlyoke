# `custom` does not pin Copilot or Codex out of a judge the user enabled in their own config

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli), reviewing the `auto` permission mode commits
- **Area:** `src/core/harness/copilot/CopilotToolPermissionMapper.ts` (`prepare`, custom branch), `src/core/harness/codex/CodexToolPermissionMapper.ts` (custom/allowAll args), `src/types/CompatibilityTypes.ts` (Copilot auto caveat text), `docs/workflows/permissions.md`
- **Resolution:** documented Copilot CLI limitation; no per-run flag pins interactive Custom to manual approval

## Symptom

`.github/instructions/harness-adapters.instructions.md` says `custom` must
explicitly pin every supported harness out of its judged auto mode. Claude
(`--permission-mode default`/`dontAsk`), Qwen (`--approval-mode default`)
and agy (`agentMode: ""`) do. Copilot and Codex don't:

- **Copilot** `custom` passes only `--allow-tool`/`--deny-tool`. ctrlyoke's
  own Copilot interactive auto caveat and `docs/workflows/permissions.md`
  tell users to set `defaultPermissionMode: "assisted"` in
  `~/.copilot/settings.json`. That file is global, so once a user follows the
  advice, every interactive Copilot `custom` step runs under the judge, and the
  allow list no longer limits what the judge may approve.
- **Codex** `custom` interactive passes `-a on-request` and nothing for the
  reviewer. If `~/.codex/config.toml` sets `approvals_reviewer = "auto_review"`,
  custom-mode escalations would go to the auto reviewer, which the auto-mode
  plan's probe showed approving a sandbox escalation to write outside the
  workspace.

## Probe Results (2026-11-18)

Verified the Codex fix in `CodexToolPermissionMapper`: interactive `custom` and `allowAll`, plus
headless approval-capable modes, pass `approvals_reviewer=user` through
`CODEX_APPROVALS_REVIEWER_OVERRIDES.MANUAL`.

Copilot 1.0.114 was run from a fresh scratch workspace with an isolated
`COPILOT_HOME/settings.json` containing `defaultPermissionMode: "assisted"` and the cheapest
available model, `gpt-6-luna`. No files under the real `~/.copilot` were changed.

1. Interactive launch with `--allow-tool 'shell(echo:*)'`, asked to run
   `echo hi && node x.js`: the TUI showed **Assisted Permissions**, and the unlisted `node`
   command reached an approval prompt. The probe stopped before answering it; this command was
   not auto-approved. The global setting does select the judge for interactive Custom sessions.
2. ACP launch using ctrlyoke's 1.0.112+ shape (`copilot --acp` plus the Custom allow/deny args)
   with the same isolated setting: `session/request_permission` arrived with the command
   `echo hi && node x.js`. The probe answered `reject_once`, and Copilot reported the tool call
   failed with a host-policy denial. The user setting does not suppress ACP permission requests.
3. `copilot --help` exposes `--assisted-approval` to enable the judge, but no flag to force
   interactive manual approval. `defaultPermissionMode` is a setting for new interactive
   sessions; there is no per-run settings flag. `/permissions default` selects manual approval
   for the current session.

The probe confirms the interactive configuration caveat, but does not demonstrate the judge
auto-approving this particular command. There is no supported per-run flag for the mapper to pin,
and the ACP path still forwards requests to ctrlyoke. The docs now tell users to run
`/permissions default` when a session needs Custom's manual approval.

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
"auto_review"` in an isolated `CODEX_HOME`. The Copilot caveat and permissions guide warn that
`defaultPermissionMode: "assisted"` also selects the
judge for interactive `custom` steps. The live Copilot probe above found no per-run manual flag;
ACP still forwards permission requests to ctrlyoke.

## Resolution

Codex pins the manual reviewer in `CodexToolPermissionMapper`. Copilot's CLI has no supported
per-run option to override the global Assisted setting, so the interactive limitation is
documented with the `/permissions default` workaround. ACP remains compatible with ctrlyoke's
approval policy and requires no change.
