# Trusted Roots Staging Plan

**Status (2026-09-03):** Implemented — Stages 1-6 complete and verified. This is a sequencing doc only — it carries
no new design content. All substance lives in the three plans below; this
file just orders their trusted-roots-related work into shippable stages and
records the one cross-plan dependency question that came up while staging it.

**Final implementation record (2026-09-03):** Stages 1-5 shipped as recorded
in the implementation commits listed in
`TRUSTED_ROOTS_SCOPE_REFACTOR_PLAN.md`; Stage 6 is complete in the VitePress
settings, workflow YAML, and CLI reference pages. No Stage 1-5 work was
deferred or skipped. Stage 4 intentionally uses one host-neutral built-in
modal implementation, with only the native OS folder picker retained as a
platform-specific exception.

**Related plans (own all the actual content):**

- [`ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md`](ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md) —
  the shipped user/workspace trust model, plus its 2026-09-02 update noting
  the context-menu gap staged here.
- [`TRUSTED_ROOTS_SCOPE_REFACTOR_PLAN.md`](TRUSTED_ROOTS_SCOPE_REFACTOR_PLAN.md) —
  the new workflow-scoped trust tier (all of Stages 2-6 below).
- [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](../backlog/VSCODE_DEPENDENCY_DECOUPLING_PLAN.md) —
  owns the `ExternalFileTrustPrompt.ts`/`WebviewSettingsSync.ts` browser-parity
  rows folded into Stage 4 below.

## Is anything here blocked on `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`?

No. Checked directly against the code on 2026-09-02, not assumed from the
plan's table:

- `PromptEditorSupportService.handleOpenPromptFile(ctx: WebviewClientContext, ...)`
  already has `ctx` in scope at both points where it calls
  `confirmExternalFileTrustAndOpen(target)` (the prompt-file-open path, and
  the dashboard `OPEN_FILE` path around line 1211) — it just isn't threaded
  into that call today.
- `WebviewMessageRouter.ts:1943-1948` already passes `ctx.postMessage` into
  `WebviewSettingsSync.handleBrowseAndAddExternalRoot`, which ignores it and
  calls `vscode.window.showOpenDialog` unconditionally.

The client-scoped typed-message pattern this needs (`ctx.postMessage` /
`ctx.emit` instead of a native `vscode.window.show*` call, with the browser
rendering `Modal.tsx`/`FileBrowserModal`) already shipped for
`WorkflowMutationCoordinator`, `WorkflowStepHandlers`, `UndoRedoCoordinator`,
and the terminal handlers between 2026-07-24 and 2026-08-06 — that's
`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md` Phase 5 item 1, already done. What
*is* still pending in that plan — Phase 4, "make `WebviewMessageRouter`
constructible by a standalone WebSocket server" — is about a different,
not-yet-built server and is unrelated to whether today's existing hosted
dashboard can render a browser modal. The two rows added to that plan's
inventory table on 2026-09-02 have been corrected to say so; they were
originally filed with a "behind a typed host action" phrasing that
overstated the dependency.

**Net effect:** every stage below can proceed independently of that plan's
staged sequence. Nothing here needs to wait.

## Staging Table

| Stage | Work | Owning plan / phase | Prerequisite | Done when |
| ----: | --- | --- | --- | --- |
| 1 | Wire `ContextMenuReferenceCommands.ts`'s four "Add … to prompt" commands through `FileAccessPolicy`/`confirmExternalFileTrustAndOpen` instead of a dead-end warning | `ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md`, 2026-09-02 update / Phase 3-4 gap | None | An external file/dir/selection/symbol added via the Explorer or editor context menu, with an untrusted target, offers Trust Parent Folder (or opens directly if already trusted) instead of "Selected file is outside the workspace." |
| 2 | Schema + trust-store generalization: `trustedExternalRoots` on `workflowOnlyProperties` (denied on steps); `ExternalRootsTrustStore` takes a generic `scopeIdentity`; `ConfigurationUtils.getPendingWorkflowExternalFileRoots`/`getEffectiveApprovedExternalFileRoots` with canonical-path, cross-scope-aware comparison | `TRUSTED_ROOTS_SCOPE_REFACTOR_PLAN.md` Phase 1 | None | `trustedExternalRoots` validates in `workflow-schema.json`; unit tests pass for workflow-identity keying, cross-scope exclusion, and canonical-path dedup (including the existing user+workspace union, fixed as part of this stage) |
| 3 | CLI: `ctrlyoke trust-workflow-external-roots <file>`; extend the `cli.ts` fail-closed gate to check the target workflow's pending roots before `ctrlyoke run` proceeds | `TRUSTED_ROOTS_SCOPE_REFACTOR_PLAN.md` Phase 2 | Stage 2 | A workflow file declaring an unapproved `trustedExternalRoots` entry exits `ctrlyoke run` with code 2 and correct guidance; the trust command clears it |
| 4 | One host-neutral UI, not "VS Code + browser": workflow batch-approval prompt gating Run, and the "Trust Parent Folder" scope choice (user / workspace / workflow), both built on the `UserInteractionPort`/`BatchApprovalModal` pattern already shipped for `SecretGrantsTrustPrompt.ts` — no native `showQuickPick`/`showWarningMessage` implementation is written at all, per the 2026-09-02 native-vs-built-in-modal policy decision (see Notes). The two non-dashboard call sites (`ctrlyoke.confirmExternalFileTrust`, and Stage 1's context-menu commands) reveal the panel and await READY before prompting, since there is no native fallback to show if the panel is closed. `WebviewSettingsSync.handleBrowseAndAddExternalRoot`'s native `showOpenDialog` is the one deliberate exception (OS file/folder picker) and is not touched by this stage. | `TRUSTED_ROOTS_SCOPE_REFACTOR_PLAN.md` "Approval Flow"/"Trust Parent Folder Dialog" (Phase 3), folding in the corrected `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md` `ExternalFileTrustPrompt.ts` row | Stage 2 (needs the store/helpers); Stage 3 only for accurate CLI-command copy in the dialog, not a code dependency | Run is blocked on pending workflow roots in both the VS Code panel and a browser-connected hosted-dashboard client; no native `vscode.window.show*` call remains anywhere in `ExternalFileTrustPrompt.ts`'s trust-decision logic (its native `openResolvedTarget` document-opening calls are unaffected — see the corrected inventory row); `WebviewSettingsSync.handleBrowseAndAddExternalRoot`'s native `showOpenDialog` remains, by design |
| 5 | Harness plumbing: thread approved workflow roots into `ContextExpander` and `CliProviderUtils.getWorkspaceDirs()`'s `--add-dir` assembly | `TRUSTED_ROOTS_SCOPE_REFACTOR_PLAN.md` Phase 4 | Stage 2 for the code; Stage 3 or 4 to have anything real to approve against in manual testing | **Completed 2026-09-03:** an approved workflow-scope root is readable via `@`-reference and reaches `--add-dir` for Claude/Codex/Copilot/Antigravity; pending/denied roots are excluded, explicit arrays replace inherited roots, and `null` disables external `--add-dir` arguments |
| 6 | Documentation | `TRUSTED_ROOTS_SCOPE_REFACTOR_PLAN.md` Phase 5 | Stages 2-5 | **Completed 2026-09-03:** the three-tier model, workflow-file abuse case and mitigation, and the new CLI command are documented in `docs/reference/settings.md`, `docs/workflows/yaml-format.md`, and `docs/cli/ctrlyoke.md` |

## Notes

- **2026-09-03: Stage 4 is split into three session-sized sub-stages** for
  orchestration purposes — it was too large for one agent session to finish,
  verify, and commit in one sitting. This is a scheduling split only; the
  scope and "Done when" bar for Stage 4 as a whole is unchanged.
  - **4a — Approval-flow plumbing.** Migrate
    `promptBatchApprovalForPendingWorkspaceExternalRoots`'s `showQuickPick`
    call to `UserInteractionPort`; extract the shared
    `promptBatchApprovalForPendingRoots` helper; add the workflow-scope call
    site (triggered on workflow load, gating Run); add
    `UserInteractionPort.requestChoice` + `WebviewUserInteractionPort`
    support + the new choice modal; wire the scope choice into
    `confirmExternalFileTrust`; add the panel-reveal-then-await-READY step to
    the two non-dashboard call sites. Corresponds to
    `TRUSTED_ROOTS_SCOPE_REFACTOR_PLAN.md` Phase 3 items 1-3.
    **Completed 2026-09-03:** implemented with a dedicated single-choice
    `ChoiceModal` alongside the existing `BatchApprovalModal`; response
    messages bypass the serialized router queue so load-triggered prompts
    cannot deadlock while awaiting the client's decision.
  - **4b — `TrustedRootsListEditor` + `AdvancedPermissionsSection`.** Build
    the shared row-list component and replace the raw textarea it retires.
    Corresponds to Phase 3 item 4.
  - **4c — `WorkflowPropertiesPanel` field + schema/UI parity test.** ~~Add the
    Inherit/None/Custom `trustedExternalRoots` field, extend
    `WebviewSettingsSync.handleBrowseAndAddExternalRoot` for the
    workflow-scope add path, and add the new field to
    `schemaUiPropertyRoundTrip.integration.test.ts`. Depends on 4b for the
    shared component. Corresponds to Phase 3 items 5-6.~~ **Completed
    2026-09-03.**
- **Stage 1 is independent and small** — ship it whenever, including before
  or in parallel with everything else.
- **Stages 2 and 1 are independent of each other.**
- **Don't split Stage 4 into "native first, browser later," and don't build
  two implementations at all.** That was the original (incorrect) framing in
  `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`'s rows before the 2026-09-02
  correction above. Since `ctx` is already available at every relevant
  dashboard call site, building the dialog twice is pure waste — implement it
  once, client-scoped, from the start.
- **2026-09-02 decision: native VS Code approval/trust/secret/key-entry
  dialogs are being retired in favor of a single host-neutral built-in modal
  wherever the modal can do the job as well as native does** — this is now
  `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`'s general policy, not just a
  Stage 4 detail. The reference implementation is
  `SecretGrantsTrustPrompt.ts`'s existing `UserInteractionPort` →
  `BatchApprovalModal.tsx` flow, which already has no native fallback. The
  only two carve-outs are the native OS file/folder picker (kept in
  `WebviewSettingsSync.ts` — the browser has no OS picker to fall back to,
  so this is a permanent divergence, not unfinished parity work) and native
  toast/status-bar notifications (a different capability tier, governed by
  `BROWSER_USER_FEEDBACK_PLAN.md`). This changed Stage 4's target from
  "native + browser, built together" to "one implementation, no native
  version at all," and `TRUSTED_ROOTS_SCOPE_REFACTOR_PLAN.md`'s "Approval
  Flow" and "Trust Parent Folder Dialog" sections were rewritten to match.
- **Stage 5's code has no hard runtime dependency on Stages 3-4** — the
  `ContextExpander`/`CliProviderUtils` changes just consume whatever
  `getEffectiveApprovedExternalFileRoots` returns, and can be unit-tested
  against a trust store seeded directly with fixtures. Listed after 3-4 here
  only because there's no way to *manually* verify it end-to-end (a real
  approved root reaching a real harness invocation) until an approval path
  exists.
