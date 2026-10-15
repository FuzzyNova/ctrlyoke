# Bug Drain 2: Harness Runtime

**Created:** October 14, 2026
**Status:** Proposed. Plan 2 of 4 in the parallel bug drain.
**Runs via:** `out/templates/workflows/spec-driven-loop.ctrlyoke.yaml`, in its own git worktree.

> **For the orchestrator:** queue one `append_step` per step in
> [Ordered steps](#ordered-steps), in the order given. Copy each step's text into
> its prompt together with the [rules every step follows](#rules-every-queued-step-follows).
> Each queued step runs in a fresh session and sees only its own prompt, so the prompt
> must be complete on its own.

---

## Goal and scope

This plan owns the runtime path that turns a workflow step into a harness CLI launch,
plus a small set of isolated orchestration, completions and dashboard fixes. The main
part is in `src/core/harness/`: provider argument building for Claude, Copilot,
Codex, OpenCode and Qwen; the shared execution runner and transport coordinator; the
`settings.json` hook and MCP trackers that write into a workspace's harness config;
and the per-run temp files those providers name and clean up. The plan also fixes
`WorkflowLockManager`'s stale-lock normalizer, draft-run startup settling and
prompt-file opening in the orchestration layer, the completion engine's cached roots,
hook compatibility pointers in `src/types/`, Agents & Skills deletion in
`HarnessFileManager`, and four self-contained webview bugs (CodeMirror listener,
`WebviewLog` serialization, secret paste, live markdown export).

## File ownership

Plans 1, 3 and 4 run **at the same time** in other worktrees, and each owns a
different set of files. A step in this plan must not edit a file another plan owns.
If a fix really cannot be done without changing one, keep that edit as small as
possible and say so in the commit message (e.g. `touches src/types/WebviewMessageTypes.ts
(plan 3) only to add one optional field`), so whoever merges the worktrees expects the
overlap.

**This plan may edit:**

```
.github/instructions/completions.instructions.md
images/screenshots/permissions-tab-800x1600.png
src/completions/CompletionHelpers.ts
src/core/harness/claude/ClaudeCliProvider.ts
src/core/harness/codex/CodexCliProvider.ts
src/core/harness/copilot/CopilotCliProvider.ts
src/core/harness/copilot/CopilotLogParser.ts
src/core/harness/copilot/CopilotToolPermissionMapper.ts
src/core/harness/opencode/OpenCodeCliProvider.ts
src/core/harness/qwen/QwenCliProvider.ts
src/core/harness/qwen/QwenNotificationMonitor.ts
src/core/harness/shared/CliExecutionRunner.ts
src/core/harness/shared/CliMcpConfigGenerator.ts
src/core/harness/shared/CliTransportCoordinator.ts
src/core/harness/shared/ExecutionPlanBuilder.ts
src/core/harness/shared/interfaces/ICliProvider.ts
src/core/harness/shared/QwenTrustedHooksTracker.ts
src/core/harness/shared/SettingsJsonHooksTracker.ts
src/core/harness/shared/SettingsJsonMcpTracker.ts
src/core/orchestration/RunLifecycleService.ts
src/core/orchestration/WorkflowCommandHandler.ts
src/core/WorkflowOrchestrator.ts
src/platform/NodeHostServices.ts
src/types/CompatibilityAnalyzer.ts
src/types/CompatibilityTypes.ts
src/types/ExecutionPropertyResolver.ts
src/types/PortabilityReport.ts
src/ui/webview-react/components/editor/CodeMirrorEditor.tsx
src/ui/webview-react/components/layout/OutputSection.tsx
src/ui/webview-react/components/settings/SecretsSection.tsx
src/ui/webview-react/hooks/useOutputExport.ts
src/ui/webview-react/utils/compatibilityDiagnostics.ts
src/ui/webview-react/utils/logger.ts
src/ui/WorkflowMutationCoordinator.ts
src/utils/HarnessFileManager.ts
src/utils/WorkflowLockManager.ts
src/utils/WorkflowPaths.ts
src/utils/WorkspaceSearchFileWalker.ts
```

Plus the matching tests under `src/test/**` and `src/ui/webview-react/test/**`, and the
bug docs listed below. A few fixes may also need a file that **no** plan owns
(`src/core/harness/shared/UserHookEnvironment.ts`,
`src/ui/webview-react/utils/markdownExport.ts`,
`src/core/orchestration/WorkflowStepHandlers.ts`, `src/ui/HarnessFileMessageService.ts`,
`src/core/harness/CliIntegration.ts`). Those may be edited when needed, but keep the
change to what the bug requires.

**Files other plans own that steps here are most likely to want, and must not edit:**
`src/core/harness/CliLogMonitor.ts`, `src/extension.ts`, `src/ui/WebviewSettingsSync.ts`
(plan 1); `src/utils/AtomicFileUtils.ts`, `src/types/WebviewMessageTypes.ts`,
`src/core/harness/shared/BaseLogParser.ts`, `src/utils/HarnessMcpExporter.ts` (plan 3);
`src/core/orchestration/ExternalRunWatchCoordinator.ts`, `src/utils/FileLockUtils.ts`,
`src/mcp-server.ts`, `src/cli.ts` (plan 4). *Calling* their exported helpers is fine;
changing them is not.

**Generated docs:** `docs/harnesses/compatibility.md` is generated from the harness
capability declarations. Steps 4 and 12 may change it. Regenerate it with
`npm run generate-compatibility-docs`, never edit it by hand, and expect a trivial
merge with any other plan that also regenerates it.

---

## Ordered steps

The steps are ordered so that steps touching the same file run one after another and
each builds on the last. The main chains are: Steps 1 → 2 → 3 (`CopilotCliProvider.ts`),
Steps 4 → 5 (`ICliProvider.ts`, `CodexCliProvider.ts`), Steps 5 → 6 → 7 → 8
(`QwenCliProvider.ts`, `SettingsJsonHooksTracker.ts`), and Steps 4 → 11 → 12
(compatibility layer). Steps 9, 10 and 13–17 (MCP tracker, lock manager,
orchestration, agent files, completions, webview) are independent of those chains and of
each other.

### Step 1: Run-unique temp file names for MCP config, hook and OTel files

- **Fixes:** `dev/bugs/backlog/per-workflow-temp-config-files-collide-on-workflow-basename.md`
- **Files:** `src/utils/WorkflowPaths.ts`, `src/core/harness/shared/CliMcpConfigGenerator.ts`,
  `src/core/harness/copilot/CopilotCliProvider.ts`, `src/core/harness/claude/ClaudeCliProvider.ts`
- **Approach:** add one helper, e.g. `WorkflowPaths.runArtifactStem(workingFilePath)`,
  that returns a sanitized, run-unique stem (workflowKey plus run directory name, or a
  short sha256 of the normalized absolute path). Use it in
  `CliMcpConfigGenerator.getConfigFilePath`, `CopilotCliProvider.buildHookFileName`,
  `CopilotCliProvider.buildOtelFileName` and `ClaudeCliProvider.buildHookSettingsFileName`,
  so the write and cleanup paths still match. Delete the stale comments that cite
  `<ts>-<name>.ctrlyoke.json`.
- **Tests:** change `CliMcpConfigGenerator.test.ts`'s assertion of the colliding
  `mcp-config-workflow.json` name to a run-specific name. Add a test that two working
  files in different run dirs (and a draft path) produce different paths. Add
  `WorkflowPaths.test.ts` cases for the helper. Update Copilot/Claude provider tests
  that pin the old names.
- **Tricky:** `CliIntegration.cleanupWorkflowArtifacts` deletes the path from the same
  getter, so check it still resolves the same name. Draft working files live in
  `draft/`, not `run-<ts>/`, so the helper must handle both shapes. Step 2 builds on
  `buildOtelFileName` from this step.

### Step 2: Copilot OTel usage counts earlier invocations' spans

- **Fixes:** `dev/bugs/backlog/copilot-otel-export-path-reused-inflates-usage.md`
- **Files:** `src/core/harness/copilot/CopilotCliProvider.ts`, `src/core/harness/copilot/CopilotLogParser.ts`
- **Approach:** make each invocation's OTel path unique by adding a per-invocation
  UUID to the Step 1 stem (`planCliArgs` already makes one for `statusLineToken`). Track
  every OTel path in a list the way `hookFilePaths` is tracked, and return all of them
  from `getAdditionalCleanupFilePaths`. In `CopilotLogParser.readNewOtelLines`, reset
  the cumulative counters as well as the offset when truncation is detected.
- **Tests:** in `CopilotCliProvider.test.ts`, check that two `planCliArgs` calls with
  the same `promptIndex` give different OTel paths and that cleanup returns both. In
  `src/test/suite/harness/LogParsers.test.ts`, point the parser at a file that already
  holds spans, call `setOtelFilePath` again, and assert that the second invocation's
  usage leaves the old spans out. Add a truncation case.

### Step 3: MCP argument generation for Copilot autoApprove and Codex unrepresentable servers

- **Fixes:** `dev/bugs/backlog/copilot-mcp-autoapprove-emits-unqualified-allow-tool.md`,
  `dev/bugs/backlog/codex-unrepresentable-mcp-server-drops-all-mcp-servers.md`
- **Files:** `src/core/harness/copilot/CopilotCliProvider.ts`,
  `src/core/harness/copilot/CopilotToolPermissionMapper.ts`, `src/core/harness/codex/CodexCliProvider.ts`
- **Approach (Copilot):** add one static helper, e.g.
  `CopilotToolPermissionMapper.toCopilotMcpToolPattern(serverId, tool)`, that returns
  `serverId(tool)`. Use it in `convertMcpPattern` and in the `autoApprove` array branch
  of `CopilotCliProvider`, so an MCP server's list can never emit a bare built-in kind
  such as `write`. This is a security fix: say so in the commit body.
- **Approach (Codex):** in `planMcpConfigArgs`, give each user server its own
  `try/catch` around the split and generate calls. On failure, `Log.warn`, push a
  warning diagnostic naming the server and the reason, and `continue`. The ctrlyoke
  server entry must always be emitted.
- **Tests:** `CopilotCliProvider.test.ts`: `autoApprove: ['create_issue']` produces
  `github(create_issue)`, and `autoApprove: ['write']` never produces a bare `write`.
  `CodexCliProvider.test.ts`: a composite `env` value on one server keeps the ctrlyoke
  entry and the other servers in `cliArgs`, and returns a diagnostic.
- **Docs:** if the schema `autoApprove` description is tightened, run
  `npm run schema:update` (schema files are not owned by another plan). Otherwise no
  user docs change.

### Step 4: OpenCode interactive mode must not pass `--file`

- **Fixes:** `dev/bugs/backlog/opencode-interactive-passes-unsupported-file-flag.md`
- **Files:** `src/core/harness/shared/interfaces/ICliProvider.ts`,
  `src/core/harness/shared/ExecutionPlanBuilder.ts`,
  `src/core/harness/opencode/OpenCodeCliProvider.ts`, `src/core/harness/codex/CodexCliProvider.ts`
- **Approach:** pass `isInteractive` (already computed in `ExecutionPlanBuilder.plan`)
  into `ICliProvider.buildImageAttachmentArgs`. OpenCode returns `[]` in interactive
  mode and leaves the image path in the prompt text. Update every implementer's
  signature. Check that Codex's interactive `-i` still works and leave its behavior
  unchanged. Report OpenCode image-input fidelity per mode (partial, with a caveat, for
  interactive) so `analyzeConfiguredImageInputs` warns, then run
  `npm run generate-compatibility-docs`.
- **Tests:** `OpenCodeCliProvider.test.ts`: an interactive plan has no `--file` and a
  headless plan still has it. `ExecutionPlanBuilder.test.ts`: the mode reaches the
  provider. Add a compatibility test for the interactive caveat if the capability shape
  changes.
- **Tricky:** this step and Step 5 both change `ICliProvider.ts`, so it must land
  first. If the per-mode capability needs a new field in `src/types/CompatibilityTypes.ts`,
  that file is owned here. Keep the change compatible with Step 12, which also edits it.

### Step 5: Retry without resume when Claude rejects the session ID

- **Fixes:** `dev/bugs/backlog/claude-resume-session-not-found-retry-never-runs.md`
- **Files:** `src/core/harness/shared/CliExecutionRunner.ts`,
  `src/core/harness/shared/CliTransportCoordinator.ts`,
  `src/core/harness/shared/interfaces/ICliProvider.ts`,
  `src/core/harness/claude/ClaudeCliProvider.ts`, `src/core/harness/qwen/QwenCliProvider.ts`
- **Approach:** detect the rejection from the process result (non-zero `exitCode` plus
  stderr matching `provider.isRecoverableSessionError`), not from a thrown error that is
  never thrown. Widen `isRecoverableSessionError` to accept the stderr text or the
  result. Surface it as a typed `CliTransportError` (add a `SESSION_REJECTED` failure
  kind if one does not exist), which the coordinator already rethrows. Keep the prompt
  temp files alive until any retry has finished: either the runner owns cleanup, or the
  first attempt gets a `keepTempFiles` option. Clear `session.resolvedSessionId` (or
  persist the new ID) so later steps stop resuming the dead session. Decide whether the
  `HARNESS_IDS.CLAUDE_CLI` gate should become "any provider that implements the check",
  which would bring Qwen in. Either do that or remove Qwen's unused method, and say
  which in the commit message.
- **Tests:** `CliExecutionRunner.test.ts`: a fake transport returns `exitCode: 1` with
  `No conversation found with session ID x`. Assert that a second `executeHeadless` call
  runs without `-r`, that its prompt files still exist, and that the temp files are
  cleaned up after the retry. `ClaudeCliProvider.test.ts`: the widened matcher.
- **Tricky:** `FAILURE_KINDS` is probably in `src/types/` (check that no other plan
  owns the file). The `finally` cleanup in `CliTransportCoordinator.executeHeadless`
  runs for every harness, so make sure the non-retry path still deletes temp files
  exactly once.

### Step 6: SettingsJsonHooksTracker keeps state per settings path

- **Fixes:** `dev/bugs/backlog/settings-json-hooks-tracker-shares-baseline-across-roots.md`
- **Files:** `src/core/harness/shared/SettingsJsonHooksTracker.ts`, `src/core/harness/qwen/QwenCliProvider.ts`
- **Approach:** follow `SettingsJsonMcpTracker`'s per-path baselines. Use
  `workflowHooks: Map<workflowKey, { settingsPath, layers }>` and
  `baselines: Map<resolvedSettingsPath, { hooks, fileExisted, dirExisted, gitignorePath }>`.
  Capture a path's baseline the first time any workflow registers for it, rebuild only
  from that path's workflows, and on that path's last unregister restore and delete its
  baseline. Unregister uses the stored path, not the caller's root. Wrap register,
  rebuild and restore in `withFileLock(settingsPath, ...)`, imported from
  `FileLockUtils` (plan 4 owns it; do not edit it).
- **Tests:** in `SettingsJsonHooksTracker.test.ts`, register two roots at the same time
  with different user hooks, unregister them in both orders, and cover a root that had
  no settings file at first (file and `.gitignore` are deleted in each root).
- **Tricky:** this rewrites the tracker's state model. Do not add the discard policy
  here; Step 7 does that on top.

### Step 7: Leftover ctrlyoke Qwen hook groups become a permanent baseline

- **Fixes:** `dev/bugs/backlog/qwen-leftover-ctrlyoke-hooks-become-permanent-baseline.md`
- **Files:** `src/core/harness/qwen/QwenCliProvider.ts`,
  `src/core/harness/qwen/QwenNotificationMonitor.ts`,
  `src/core/harness/shared/SettingsJsonHooksTracker.ts`
- **Approach:** add one shared predicate next to `QwenNotificationMonitor.buildHookConfig`
  (e.g. `isCtrlYokeQwenHookGroup`) that matches groups whose hooks are all
  `type: "command"` running the `ctrlyoke-qwen-hook.js` *basename*, so groups from older
  extension versions match too. Pass it as the `HookBaselinePolicy.discardHookGroup`
  from `registerHooksInSettings`. When the sanitized baseline shows that the file held
  only discarded groups, also recognize a leftover ctrlyoke `.qwen/.gitignore` by its
  `# ctrlyoke temp files` header, so restore removes it.
- **Tests:** seed `settings.json` with a stale ctrlyoke group plus a user group, then
  register and unregister: only the user group remains. Seed it with only ctrlyoke
  groups: the file and `.gitignore` are deleted. Add a `QwenNotificationMonitor` test
  for the predicate.

### Step 8: Qwen trusted-hooks file grows one entry per step for env hooks

- **Fixes:** `dev/bugs/backlog/qwen-trusted-hooks-file-grows-per-step-for-env-hooks.md`
- **Files:** `src/core/harness/shared/QwenTrustedHooksTracker.ts`,
  `src/core/harness/qwen/QwenCliProvider.ts`, and probably
  `src/core/harness/shared/UserHookEnvironment.ts` (unowned)
- **Approach:** prefer making the launcher command the same on every step. Name the
  env file per workflow and hook ID with no random UUID, or have the launcher find its
  env file without the path being in the command. Check that concurrent workflows
  cannot share one env file (use the Step 1 run stem or the workflowKey). If the path
  has to stay per-step, the tracker should instead own and remove `user-hook-env-` keys
  on `unregisterWorkflow`.
- **Tests:** in `QwenTrustedHooksTracker.test.ts`, register two steps with an
  env-bearing hook and assert that the workspace entry does not grow. Update
  `UserHookEnvironment` tests if the file name changes.
- **Tricky:** `UserHookEnvironment` is shared by every harness that wraps env-bearing
  hooks. Keep the other harnesses' behavior the same, and make sure the env file is
  still deleted when its step finishes.

### Step 9: SettingsJsonMcpTracker keeps lifecycle state per config path

- **Fixes:** `dev/bugs/backlog/settings-json-mcp-tracker-refcounts-across-workspaces.md`
- **Files:** `src/core/harness/shared/SettingsJsonMcpTracker.ts`
- **Approach:** key `refCounts`, `managedServerValues` and `gitignorePath` by resolved
  config path, the way `baselines` already is. Record `settingsPath` in
  `workflowServers` so unregister uses the stored path. Base `hasManagedState` and
  `deleteCtrlYokeGitignore` on that path's map only.
- **Tests:** in `SettingsJsonMcpTracker.test.ts`, two workflows in two roots register
  and unregister in interleaved order. Afterwards both config files and both
  temporary `.gitignore` files are gone, and no secret-bearing entry is left behind.
- **Tricky:** this is independent of Steps 6–8 but has the same shape. Do not try to
  merge the two trackers in this step.

### Step 10: normalizeStaleLocks must not delete a successor's runner lock

- **Fixes:** `dev/bugs/backlog/normalize-stale-locks-deletes-successor-runner-lock.md`
- **Files:** `src/utils/WorkflowLockManager.ts`
- **Approach:** add one helper, e.g. `reclaimIfStale(lockPath, expectedToken)`, that
  runs inside `withFileLock(lockPath, ...)`. It re-reads the lock, re-checks
  `isOwnerStale`/`hasNewerSchema`, and confirms that the `ownerToken` matches the one
  seen at inspection before it rewrites the run file and unlinks the lock. Use it from
  both `acquireLock` and `normalizeStaleLocks`. Write the run file through
  `src/utils/RunStateWrites.ts` (unowned) or the existing atomic-write helper with a
  unique tmp name, not the fixed `runFilePath + ".tmp"`. Optionally have
  `updateHeartbeat` return a "lock lost" result instead of silently doing nothing. If
  you do, check every caller handles it; callers in files owned by other plans must not
  need changes, so make the new result opt-in.
- **Tests:** in `WorkflowLockManager.test.ts`, stub the run-file `.tmp` rename so that
  an `acquireLock` runs between inspection and unlink. Assert that the successor's
  `runner.json` and run state survive, and that a third `acquireLock` is refused.
- **Tricky:** do not edit `ExternalRunWatchCoordinator.ts` (plan 4). Its call to
  `normalizeStaleLocks` must keep its signature.

### Step 11: Hook compatibility diagnostics point at the wrong field

- **Fixes:** `dev/bugs/backlog/hook-compatibility-diagnostics-point-at-wrong-field.md`
- **Files:** `src/types/ExecutionPropertyResolver.ts`, `src/types/CompatibilityAnalyzer.ts`,
  `src/types/PortabilityReport.ts`
- **Approach:** have `resolveHooks` record each hook's origin
  (`{ tier: "prompt" | "workflow" | "defaults", index }`), either in a parallel array or
  as `{ hook, origin }` pairs. Add one shared pointer helper used by both
  `CompatibilityAnalyzer.createHookDiagnostic` and `PortabilityReport.getHookPointer`,
  and delete the duplicated pointer logic. Set `sourceTier` from each hook's own
  origin.
- **Tests:** `CompatibilityAnalyzer.test.ts` and `PortabilityReport.test.ts` with
  workflow hooks `[A, B]` and step hooks `[B']` pin `/hooks/0/event` for A and
  `/steps/0/hooks/0/event` for B'. `PropertyResolver.test.ts` covers the recorded
  origins.
- **Tricky:** `resolveHooks` callers outside this plan's files (`ExecutionPreviewService`,
  `PortabilityReportSection.tsx`, `src/cli.ts`) must keep compiling. Keep the existing
  return shape and add the origins alongside it, rather than changing every consumer.
  Run after Step 4, which may also touch the compatibility layer.

### Step 12: Permissions tab says Claude ignores Allowed Tools

- **Fixes:** `dev/bugs/backlog/claude-allowed-tools-warning-says-ignored.md`
- **Files:** `src/ui/webview-react/utils/compatibilityDiagnostics.ts`,
  `src/types/CompatibilityTypes.ts`, `images/screenshots/permissions-tab-800x1600.png`
- **Approach:** split `isLossy` into "not enforced" (unsupported or no mechanism) and
  "enforced with a caveat" (`partial` with a `caveatCode`). Word the second case as,
  for example, "Enforced for N Claude Code steps, but Claude's own settings allow rules
  can add to this list in headless mode", at info severity, not warning. Put any new
  wording key or predicate in `CompatibilityTypes.ts` so it has one source.
- **Tests:** add a `partial`-with-caveat case to `compatibilityDiagnostics.test.ts`
  and `useCompatibilityDiagnostics.test.ts`, and update `CompatibilityTypes.test.ts`
  if the predicate lives there.
- **Screenshot:** retake `images/screenshots/permissions-tab-800x1600.png` only if the
  Playwright MCP server is attached (see "Driving the hosted dashboard with Playwright"
  in `.github/copilot-instructions.md`, and use `deviceScaleFactor: 1`). If it is not
  attached, still fix the code and move the bug doc, and say in the commit message and
  the orchestrator summary that the screenshot still needs retaking.
- **Tricky:** if `docs/harnesses/compatibility.md` changes, regenerate it; do not edit
  it by hand.

### Step 13: Run-action and prompt-file failures must reach the user

- **Fixes:** `dev/bugs/backlog/execute-draft-at-address-never-settles-on-startup-failure.md`,
  `dev/bugs/backlog/open-current-prompt-file-reports-success-on-failure.md`
- **Files:** `src/core/orchestration/RunLifecycleService.ts`, `src/core/WorkflowOrchestrator.ts`,
  `src/ui/WorkflowMutationCoordinator.ts`, `src/core/orchestration/WorkflowCommandHandler.ts`
  (and `src/core/orchestration/WorkflowStepHandlers.ts`, unowned, if the quiet-error
  check goes there)
- **Approach (draft run):** in `executeDraftAtAddress`, settle `preparedPromise` when
  `executeLoadedPromptFile` resolves without having called `onPrepared`. Prefer
  rejecting with a quiet, typed error that `handleExecuteDraft` recognizes, so it skips
  the duplicate toast that `finalizeFailure` already showed. Catch an exception thrown
  by `onPrepared` itself. Apply the same guard to `seedAndExecuteAtRun`.
- **Approach (open prompt file):** remove the swallowing `try/catch` in `openPromptFile`
  so that `FAILED`/`UNSUPPORTED` results and exceptions reach `openCurrentPromptFile`'s
  existing `notifyUserFeedback(ERROR, ...)`. Build the message from `error.message`, not
  `${error}`.
- **Tests:** `RunLifecycleService.test.ts`: a stub instance whose
  `executeLoadedPromptFile` resolves without calling `onPrepared`, and the returned
  promise settles. `WorkflowOrchestrator.test.ts`: `recordSuccessfulRevisions` is not
  called for an unprepared run. `WorkflowCommandHandler.test.ts`: a host stub returning
  `{ status: FAILED, message }` sends an `ERROR` to the feedback sink and writes no
  "Opened prompt file" log.

### Step 14: Deleting a plain-.md agent reports success but deletes nothing

- **Fixes:** `dev/bugs/backlog/deleting-plain-md-agent-reports-success-but-deletes-nothing.md`
- **Files:** `src/utils/HarnessFileManager.ts`
- **Approach:** in `deleteFromHarness`, use the same scan as discovery (a shared helper
  over `collectAgentLocations`). Find the locations matching `name`, `harnessId` and
  `scope` across every dir of the target, and `rm` each `location.path`.
  `deleteAllFromHarness` deletes the matched paths directly. Drop `force: true`, or
  check that at least one file was removed, so a delete that removes nothing reports a
  failure. Do this without adding a field to the delete message, because
  `WebviewMessageTypes.ts` is owned by plan 3.
- **Tests:** in `HarnessFileManager.test.ts`, a plain `.md` agent in `.agents/agents`,
  a `.agent.md` agent in `.claude/agents`, and an agent in a second dir of a multi-dir
  target are each deleted and their files are gone. Deleting a name that does not
  exist reports failure.

### Step 15: Completion engine caches workspace roots from first use

- **Fixes:** `dev/bugs/backlog/completion-engine-caches-workspace-roots-from-first-use.md`
- **Files:** `src/completions/CompletionHelpers.ts` (plus `src/completions/RegexSymbolIndex.ts`,
  unowned, if it changes to take a root getter)
- **Approach:** read the roots lazily. Call `getVsCodeWorkspaceRoot()` and
  `getVsCodeNamedWorkspaceRoots()` inside the resolver closure, and pass
  `RegexSymbolIndex` a root getter instead of a captured value. The alternative is to
  reset `completionCore`/`vsCodeSymbolIndex` on `onDidChangeWorkspaceFolders`. If you
  do that, subscribe inside `initializeCompletionHelpers`, not in `src/extension.ts`
  (plan 1).
- **Tests:** in `CompletionHelpers.test.ts`, change the mocked `workspaceFolders` after
  the first `getCompletionCore()` call and assert that a symbol from the new folder
  resolves.
- **Note:** do not fix `respect-gitignore-for-completions-setting-never-read` in this
  step. Step 18 fixes it.

### Step 16: Small webview fixes (CodeMirror blur listener, WebviewLog errors, secret paste)

- **Fixes:** `dev/bugs/backlog/codemirror-window-blur-listener-never-removed.md`,
  `dev/bugs/backlog/webview-log-serializes-error-arguments-as-empty-object.md`,
  `dev/bugs/backlog/secret-password-field-drops-pasted-newlines.md`
- **Files:** `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`,
  `src/ui/webview-react/utils/logger.ts`, `src/ui/webview-react/components/settings/SecretsSection.tsx`
- **Approach:**
  - CodeMirror: change `"blur-sm"` back to `"blur"` in the `removeEventListener` call
    and in the two comments. Keep the add/remove event names in one place so they
    cannot drift apart. Grep `src/ui/webview-react` for other event-name strings with a
    Tailwind `-sm`/`-xs` suffix, and fix any found in files this plan owns. List any in
    other plans' files in the summary instead.
  - Logger: add a safe per-argument formatter (`Error` → name, message and stack;
    strings unchanged; anything else through `JSON.stringify` with a cycle-safe
    `WeakSet` replacer that also stringifies `BigInt`, falling back to `String(arg)`),
    and build `text` inside the `try` so the logger never throws.
  - Secrets: add an `onPaste` handler on the password input. If the clipboard text has
    `\n`/`\r`, `preventDefault()`, set the raw value, switch to multiline and focus the
    textarea. Delete the dead `includes("\n")` check.
- **Tests:** `CodeMirrorEditor.test.tsx`: unmount calls `removeEventListener("blur", ...)`.
  `logger.test.ts`: an `Error` argument's message appears in the posted `LOG_MESSAGE`,
  and circular or `BigInt` arguments do not throw. `SecretsSection.test.tsx`: pasting
  multi-line clipboard data stores it with the newlines intact through `setSecret`.

### Step 17: Live markdown export repeats each step once per activity slice

- **Fixes:** `dev/bugs/backlog/live-markdown-export-repeats-step-output-per-activity-slice.md`
- **Files:** `src/ui/webview-react/hooks/useOutputExport.ts`,
  `src/ui/webview-react/components/layout/OutputSection.tsx`, and
  `src/ui/webview-react/utils/markdownExport.ts` (unowned) if needed
- **Approach:** give `generateMarkdownExport` an activity-free projection on the live
  path too. Pass the live ordered entries as `orderedEntries` when not viewing history
  (wire them through `OutputSection`), so live and history exports use the same
  re-projection. Make `getVisibleStepRange`/`totalCliSteps` use that same projection.
  Filter out any `isActivity` message that still reaches export.
- **Tests:** in `useOutputExport.test.ts`, export a live projection with several
  structured activity slices for one step and assert that its `## Step` section appears
  exactly once. Also check that history export output is unchanged.
- **Tricky:** do not edit `useOutputRowsModel.ts` or `outputProjection.ts` unless you
  must. They are unowned, but the display path depends on the activity slices, so the
  fix belongs on the export side.

---

### Step 18: Restore "Respect .gitignore for completions" (regression)

- **Fixes:** `dev/bugs/backlog/respect-gitignore-for-completions-setting-never-read.md` [high]
- **Decision (Nathan, 2026-10-14):** make the setting work again; keep the toggle and
  the setting. This regressed in `77d71066e` (2026-10-06), which deleted the VS Code
  `getCompletionFiles` that read the setting.
- **Files:** a new shared helper in `src/utils/` (next to
  `WorkspaceSearchFileWalker.ts`), `src/completions/CompletionHelpers.ts`,
  `src/platform/NodeHostServices.ts`, `src/utils/WorkspaceSearchFileWalker.ts`,
  `.github/instructions/completions.instructions.md`
- **Approach:** follow the bug doc's Suggested Fix. With the setting on, use
  git-tracked files, falling back to the walk with the default skip set if git fails.
  With it off, walk with a skip set of only `.git`, so `dist/`, `out/`, `node_modules/`
  and `.env` appear, as with the old `findFiles("**/*", "**/.git/**")`. Keep the existing
  file-count and time bounds. Both the VS Code and Node hosts read the setting and call
  the one helper. Make sure the completion cache is cleared when the setting changes.
- **Tests:** test both helper modes against a temp git repo that has an ignored file and
  an ignored directory. Add a completion-level test that flips the setting and asserts
  an ignored file appears or disappears. Remove the dead
  `shouldRespectGitignoreForCompletions` stubs in `PromptCompletionProvider.test.ts` or
  make them meaningful.
- **Tricky:** run after Step 15, which also edits `CompletionHelpers.ts`.

---

## Rules every queued step follows

Include these in every `append_step` prompt:

1. **Self-contained.** The step runs in a fresh session with no memory of earlier
   steps. Read the bug doc(s) named in the step and the code they cite, check that the
   line references still match (an earlier step may have moved them), and read the
   matching `.github/instructions/*.instructions.md` for each area you edit.
2. **Re-verify before fixing.** If the bug no longer reproduces from the current code
   (already fixed, or the doc's analysis was wrong), do not change code.
   `git mv` the doc to `dev/bugs/rejected/`, replace its `**Severity:**` line with
   `**Resolution:**` and a one-line reason, and commit that.
3. **Fix and test.** Fix the root cause described in the doc, and add or update tests
   that would have caught it: extension tests in `src/test/**`, dashboard tests in
   `src/ui/webview-react/test/**`.
4. **Stay in this plan's files.** See [File ownership](#file-ownership). If an edit to
   another plan's file cannot be avoided, keep it minimal and name it in the commit
   message.
5. **`npm test` passes.** Run it once and read the `TEST SUMMARY:` block at the end
   (`npm test 2>&1 | Select-Object -Last 40`). Do not run the whole suite again just to
   check. Never run `npm run test:harness`. Run `npm run typecheck` and `npm run lint`
   as well.
6. **Move the bug doc.** `git mv` each fixed doc from `dev/bugs/backlog/` to
   `dev/bugs/implemented/`, and replace its `**Severity:**` line with
   `**Resolution:** fixed in this commit`.
7. **Docs.** If the change alters anything a user sees or types, update the
   hand-written `docs/` pages in the same commit. Regenerate generated docs
   (`npm run schema:update`, `npm run generate-compatibility-docs`); never hand-edit
   them.
8. **Commit its own work.** Commit to the current branch (do not create a branch) with
   a plain conventional-commit message (`fix(harness): ...`, `fix(webview): ...`) and
   no attribution or trailer lines.
9. **Never leave a bug open.** If a fix hits a choice the bug doc doesn't settle, decide
   it yourself:
   - Fail closed on security.
   - Prefer the smallest change a user would notice.
   - Follow existing conventions.
   - If another plan's file must change, make the edit minimal and name it in the commit
     message.

   Before moving the doc, record the choice in a short `## Decision` paragraph in it. A
   bug leaves `dev/bugs/backlog/` only as fixed (`implemented/`) or as not real
   (`rejected/`). It is never skipped, deferred, or left for Nathan.

Plan 4's Step 4 (commit-message permissions) may make small, additive edits to this
plan's harness permission mappers. Expect them when merging.

## Done criteria

- Every bug doc listed in Steps 1–18 is in `dev/bugs/implemented/` or
  `dev/bugs/rejected/`.
- The orchestrator's summary also lists any follow-ups the steps reported: a screenshot
  not retaken in Step 12, edits made to other plans' files, and Tailwind-mangled event
  names found in other plans' files.
- The final `npm test` run on the worktree shows every suite as PASS.
