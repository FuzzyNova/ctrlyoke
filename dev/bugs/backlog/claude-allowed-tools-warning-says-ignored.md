# Permissions tab says Claude Code ignores Allowed Tools, but it enforces them

- **Found:** 2026-10-14 by Claude Code (retaking the Permissions tab screenshot)
- **Area:** `src/ui/webview-react/utils/compatibilityDiagnostics.ts`
- **Severity:** medium

## Symptom

A workflow on Claude Code with `toolPermissions.mode: custom` and a non-empty Allowed Tools list
shows a yellow outline and this warning under **Allowed Tools**, with a warning badge on the
Permissions tab icon:

> Ignored by 2 Claude Code steps because Claude's existing settings allow rules also count as
> pre-approved in headless mode.

Since `claude-custom-permissions-allow-list-not-enforced` was fixed, Claude enforces the list
(`--permission-mode dontAsk` plus `--allowedTools` in headless runs). The caveat is that the
user's own `~/.claude/settings.json` allow rules can _widen_ it. "Ignored" is wrong, and the
"because" clause doesn't explain an ignored list, so the sentence reads as a contradiction. A
user who reads it may think the allow list does nothing and switch to a broader mode.

## Steps to Reproduce

1. Open a workflow with `harness: claude-cli`, `toolPermissions.mode: custom` and
   `allowedTools: [write, "shell(npm test)"]` (the demo project's `docs-properties` workflow).
2. Open Workflow Properties → Permissions.
3. The Allowed Tools box has the "Ignored by N Claude Code steps …" warning.

## Root Cause

`ClaudeToolPermissionMapper.ts:33-38` declares `allowedTools` as `fidelity: "partial"` with
`caveatCode: CLAUDE_PREAPPROVED_SETTINGS`. `workflowPermissionDiagnostic`
(`compatibilityDiagnostics.ts:160-205`) puts every target whose state `isLossy` (anything not
`exact` and `verified`, `:124-129`) in the "Ignored by" bucket. It has no wording for
"enforced, with a caveat", so a partial capability reads as ignored.

## Suggested Fix

Split `isLossy` into "not enforced" (`unsupported`/no mechanism) and "enforced with a caveat"
(`partial` with a caveat code). Word the second as, for example, "Enforced for 2 Claude Code
steps, but Claude's own settings allow rules can add to this list in headless mode", at info
severity rather than warning. Add a case to the compatibility diagnostics tests for a
`partial` capability with a caveat. Then retake `images/screenshots/permissions-tab-800x1600.png`.
