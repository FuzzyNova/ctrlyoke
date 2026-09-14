---
applyTo: "src/extension.ts, src/mcp-server.ts"
---

<purpose>
These two files are process entry points, not general-purpose dumping grounds.

- `src/extension.ts` wires the VS Code-side control plane at activation time.
- `src/mcp-server.ts` is a separate stdio binary used by AI harnesses and commit-message generation; it must stay usable without `vscode`.

Keep them focused on startup/shutdown wiring, cross-subsystem handoff, and process-boundary contracts. Push feature logic into the owning subsystem instead of growing either entry point.
</purpose>

<extensionActivation>
`activate()` has a meaningful order. Preserve these dependencies when editing startup:

1. Configure `configService` backends **before** `Log.initialize(context)` so startup logging sees the real file-backed settings.
2. Kick off `initializeModelRegistry()` early, but do not block activation on it.
3. Workspace bootstrap happens before orchestrator creation:
   - initialized workspace: fire-and-forget `WorkspaceInitializer.initializeIfNeeded()` and `TempFileManager.cleanupOrphanedFiles()`
   - uninitialized workspace: capture `pendingInitWorkspaceRoot` only
4. Create/register `CtrlYokeWebviewProvider` **before** PTY/orchestrator setup.
5. Initialize `PtyProcessManager` with the panel postMessage first, then create `WorkflowOrchestrator`.
6. If workspace init is pending, call `workflowOrchestrator.setWorkspaceInitPending(...)` **before** `initialize()`.
7. After both objects exist, wire cross-references:
   - `webviewProvider.setWorkflowOrchestrator(...)`
   - `webviewProvider.setHub(...)`
   - `setPtyPostMessage(hub.postMessage)` to upgrade PTY fan-out from panel-only to all dashboard clients
8. Register `NotificationManager` as a hub client and share the orchestrator's `OutputHistoryManager` with the webview provider.
9. Call `workflowOrchestrator.initialize()` fire-and-forget. The webview is allowed to resolve before harness detection finishes.
10. Only after core wiring: theme listener, completion/link providers, `initializeCompletionHelpers(context)`, then command registration.

Current activation assumes the **first workspace folder** is the workspace root for config backend setup, initialization, workflow discovery, and several commands. If multi-root behavior changes, update those paths together.
</extensionActivation>

<extensionPatterns>
Important `extension.ts` conventions:

- `workflowOrchestrator`, `webviewProvider`, `hostedServer`, and `notificationManager` are intentionally module-scoped so registered commands can close over them. Do not move them into a separate service locator.
- Everything VS Code should auto-dispose belongs in `context.subscriptions`. The notable exceptions are:
  - `hostedServer`, disposed manually by `disableServer` and `deactivate()`
  - `notificationManager`, owned through `DashboardBroadcastHub.addClient(...)`
- **ctrlyoke registers no `vscode.lm` tools, and should not.** Four LM tools (queue status, append queue, capabilities, read output) existed to serve the removed Copilot Chat harness and were deleted along with their shared `QueueOperations` module. `vscode.lm.registerTool` publishes to VS Code chat participants — a surface ctrlyoke no longer drives — while `mcp-server.ts` already exposes the same capabilities to every harness ctrlyoke _does_ support, including Copilot CLI. Re-adding an LM twin would recreate a second tool contract that has no consumer and must be kept in sync by hand.
- `registerCommands(context)` is the single production command-wiring point. Keep it orchestration-only:
  - context-menu commands save dirty files before delegating
  - the hosted server auto-start check runs **after** command registration
  - dev commands are last and stay behind `IS_DEV_MODE`
- Shared command IDs, context keys, queue positions, execution states, and message types belong in `src/types/DashboardConstants.ts`, not as new literals here.
- `ScmCommitCommand` is instantiated once inside `registerCommands()` and owns SCM-specific UX; `extension.ts` should only register/delegate to it.
  </extensionPatterns>

<deactivation>
`deactivate()` is intentionally small:

1. ask `PtyProcessManager` to gracefully stop AI CLI sessions first
2. dispose the hosted server and clear the module-scoped reference
3. dispose the orchestrator

Do not duplicate cleanup already handled by `context.subscriptions`; PTY hard-kill fallback and other disposables run there after deactivation returns.
</deactivation>

<mcpServer>
`mcp-server.ts` is a standalone CJS/stdin-stdout process. Treat it as an external contract.

- Never import `vscode` or extension-only helpers here. `src/utils/WorkflowPaths.ts` and `src/core/orchestration/WorkflowLineageRepository.ts` are safe to import (both are Node-only); anything they in turn import must stay that way — do not let `Log` (which imports `vscode`) leak into this dependency chain, use `console.warn`/`console.error` instead, matching `FileLockUtils`'s convention.
- Use file logging only (`CTRLYOKE_DIAGNOSTIC_LOGS=true` or `NODE_ENV=development`). Do not write operational logs to stdout/stderr because stdout is the MCP transport and many TUIs capture stderr.
- This is ctrlyoke's **only** agent-facing tool surface. There is no VS Code Language Model twin to keep in sync — see the `extension.ts` note above.
- **This server is blanket auto-approved and must stay scoped to the addressed run.** Harnesses grant it standing without a prompt (e.g. `ClaudeCliProvider` passes `--allowed-tools mcp__ctrlyoke`) because unattended workflows cannot stop at a tool-approval dialog. It therefore bypasses `autoApprove` config and the tool-permission mappers that gate every _user-defined_ MCP server. Two consequences bind any new tool here:
  1. **No lifecycle control.** No tool may start, cancel, pause, or resume a run. An auto-approved start is an unbounded billable-spawn primitive reachable by prompt injection; an auto-approved cancel is a DoS primitive against sibling runs. Stopping for human approval already has a deterministic, author-opted-in path (pre-condition `stopWorkflow`/`skipPrompt`, `endCondition.onFail`, script-step `onFail`) — use a sentinel file plus an end-condition script when the decision needs model judgment. Sub-workflow composition belongs in `dev/backlog/WORKFLOW_STEP_PLAN.md`, not here. External automation belongs to `ctrlyoke run --headless --json`; routing it through MCP would only bypass the harness's own shell-permission prompt. See `dev/rejected/MCP_CONTROL_SURFACE_PLAN.md`.
  2. **No unaddressed cross-workflow reach.** `global_status` is the deliberate exception — a read-only workspace listing so a step can avoid files a sibling run owns and attribute stray build errors. Every other tool answers only for this server's own run. Do not widen that.
- **This server serves exactly one workflow run, and that is the whole addressing model.** `requireRunAddress` reads the run out of `CTRLYOKE_WORKING_FILE` — which `CliMcpConfigGenerator`/`CliProviderUtils` bake in at every harness launch — and throws when it is absent or names anything but a promoted run. No tool argument participates: `resolveRun` takes an operation name, not a selector. So `workflow_status`/`append_step`/`read_output`/`edit_step`/`remove_step`/`reorder_steps` accept no address at all — a prompt-injected one is inert rather than merely rejected — and there is no "guess the running/most-recent workflow" fallback anywhere. They do _report_ the resolved `workflowKey`/`runRef` in their responses, but that is output describing the attached run, not an input a caller can steer. `handleGlobalStatus` is the only reader of a caller-supplied address, and only to narrow its own listing.
- **There is no second, "detached" mode to design for — the CLI is the automation surface.** A server without an attached run is not a supported caller (see `dev/active/AUTOMATION_API_PLAN.md`, and `dev/rejected/MCP_CONTROL_SURFACE_PLAN.md` for why the lifecycle surface was refused), so every workflow tool refuses rather than falling back to an addressable mode. Only `submit_commit_message` runs without one, under its own `CTRLYOKE_COMMIT_OUTPUT` contract, and commit-message generation denies every workflow tool anyway (`CommitMessageGenerator` denies all of `MCP_WORKFLOW_TOOL_NAMES`). Resist re-adding a caller-addressable path: it would resurrect exactly the cross-workflow reach constraint 2 forbids.
- **Tool descriptions are prompts, not documentation.** They are consumed by a model deciding whether to call, so they say what the tool does for the caller and when to reach for it. Keep ctrlyoke's internals out of them: targeting rules, immutability invariants, lock/revision mechanics, and storage layout are things the caller can neither violate nor exploit, so they only spend context. The same test applies to input fields — a field belongs in the schema only when some caller can actually use it. That is what removed `expectedDefinitionRevision`/`expectedDescriptorRevision` from append: an append is additive, not an overwrite, so a caller-supplied revision could only reject work the run should have accepted, and the stale-write guard that matters is the one `RunContinuationService` re-checks under the run-file lock.
- Queue appends are protected twice on purpose:
  - `operationQueue` serializes append requests within this process
  - `withFileLock(...)` protects the working file across processes
  - It serializes them; it does not order them. `invokeTool` awaits `resolveCallingContext` **before** it reaches `queueOperation`, so two concurrently issued calls race to that boundary and may enqueue in either order. That is fine — MCP gives in-flight requests no ordering guarantee — but a test that asserts which of two concurrent appends lands first is asserting a coin flip, and will flake.
- Append validation is best-effort against `.ctrlyoke/capabilities.json`; that file is produced by the VS Code-side settings sync and may be absent early in workspace setup.
- `submit_commit_message` writes to `CTRLYOKE_COMMIT_OUTPUT` when present; this is the structured capture path used by commit-message generation.
  </mcpServer>

<relatedFiles>
- `src/ui/CtrlYokeWebviewProvider.ts` — panel shell and outbound UI transport
- `src/core/WorkflowOrchestrator.ts` — main lifecycle owner created by `activate()`
- `src/scm/ScmCommitCommand.ts` — SCM command implementation registered from `extension.ts`
</relatedFiles>
