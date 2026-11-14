# A workspace `auto` permission mode, or a `custom` list over a user's `auto` list, is applied without settings-trust approval

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli), reviewing 821990c3f; reproduced against compiled `out/` with `collectWorkspaceSensitiveSettingRequests`
- **Area:** `src/utils/ToolPermissionUtils.ts` (`isToolPermissionConfigNoWiderThan`, `PERMISSION_MODE_BREADTH`)
- **Severity:** high (security: a checked-in workspace setting widens tool permissions without the trust prompt)

## Symptom

A repository's `.ctrlyoke/settings.json` can widen what a harness may do
without asking, and ctrlyoke applies it with no "trust workspace settings"
request. The gate `toolPermissionsCoveredByUser`
(`src/config/WorkspaceSensitiveSettings.ts`) exists precisely to stop this
(see `dev/bugs/implemented/workspace-default-tool-permissions-bypass-settings-trust.md`),
and the settings schema promises that a broader mode from the workspace needs
approval. Two cases slip through:

1. **`auto` over `allowAll` (Codex).** The user keeps the shipped default
   `allowAll`. The workspace sets `{"defaults":{"toolPermissions":{"mode":"auto"}}}`.
   No approval request is raised. On Codex, headless `allowAll` passes no flags,
   so `codex exec` runs with its fixed `never` approval and nothing can leave the
   sandbox; interactive `allowAll` is `-a on-request`, so a human approves
   escalations. `auto` adds `approvals_reviewer=auto_review` (and headless
   `approval_policy=on-request`), so a reviewer model approves sandbox
   escalations instead — writes outside the workspace become possible
   (confirmed by the harness probe in `dev/implemented/AUTO_PERMISSION_MODE_PLAN.md`).
2. **`custom` list over an `auto` list.** The user sets
   `{mode:"auto", allowedTools:["write"]}`. The workspace sets
   `{mode:"custom", allowedTools:["shell"]}`. No approval request is raised, and
   bare `shell` now runs with no judge and no prompt. The same pair with both
   modes `auto` (`auto[shell]` over `auto[write]`) is correctly refused.

## Steps to Reproduce

Call `collectWorkspaceSensitiveSettingRequests` (or `isToolPermissionConfigNoWiderThan`
directly) with:

| user (baseline)                 | workspace (candidate)             | requests today | expected |
| ------------------------------- | --------------------------------- | -------------- | -------- |
| shipped default (`allowAll`)    | `{mode:"auto"}`                   | 0              | 1        |
| `{mode:"auto",allowedTools:["write"]}` | `{mode:"custom",allowedTools:["shell"]}` | 0 | 1 |
| `{mode:"auto",allowedTools:["write"]}` | `{mode:"auto",allowedTools:["shell"]}`   | 1 | 1 (control) |

## Root Cause

`isToolPermissionConfigNoWiderThan` ranks the managed modes on one line,
`custom (0) < auto (1) < allowAll (2) < dangerouslyAllowAll (3)`. That order is
not true for `auto`: on Claude/Copilot it is narrower than `allowAll`, but on
Codex it is wider than `allowAll` because it opens an escalation path out of the
sandbox. Since the check is harness-independent, `auto` is not comparable with
any other mode.

Separately, the allow-list subset check only runs when both modes are equal
(`custom`/`custom` or `auto`/`auto`). In both `custom` and `auto` the allow list
is exactly what runs without a prompt (or without the judge), so a `custom`
candidate over an `auto` baseline (or the reverse, once case 1 is fixed to
reject it anyway) must also be checked for an allow-list subset. The unit test
`orders auto between custom and allowAll` in
`src/test/unit/ToolPermissionUtils.test.ts` asserts the wrong ordering.

## Suggested Fix

In `isToolPermissionConfigNoWiderThan`:

- When the candidate mode is `auto` and the baseline mode is not `auto`, return
  `false` (needs approval). `custom` stays provably no wider than `auto`
  provided its allow list is a subset of the baseline's and the baseline's
  denials are kept.
- Run the allow-list subset check whenever both modes are in {`custom`, `auto`},
  not only when they are equal.
- Fix the unit test's `auto`-over-`allowAll` expectation and add cases for
  `auto` over `dangerouslyAllowAll` (`false`: not provably narrower on every
  harness, so asking is the safe answer), `custom[shell]` over `auto[write]` and
  `custom[write]` over `auto[write]` (no wider).
- The trust prompt now appears for a workspace that sets `auto` over a user's
  non-`auto` mode; note that under **Changed** in `CHANGELOG.md`.
