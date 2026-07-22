---
applyTo: "src/core/*.ts"
---

<purpose>
Top-level ctrlyoke core orchestration only: workflow registry, per-workflow runtime state, execution loop, working-file persistence, parsing, validation, and shared queue operations. This file does **not** cover `src/core/orchestration/**` helpers or `src/core/harness/**` implementations.
</purpose>

<boundaries>

- `WorkflowOrchestrator` owns cross-workflow concerns and long-lived detector integrations.
- `WorkflowInstance` owns one workflow's runtime state and composes queue, executor, history, watchers, and execution integrations.
- `WorkflowStateMachine` is the **only** owner of execution status/timing/attempt state.
- `PromptQueue` owns queue topology/runtime metadata, but delegates status transitions to `WorkflowStateMachine`.
- `WorkingFileManager` is the only place that should write a run/draft `workflow.ctrlyoke.json` under `.ctrlyoke/.runs/<workflowKey>/`. `WorkflowLineageRepository` (in `src/core/orchestration/`) owns the lineage descriptor (`workflow.json`), `WorkflowKey`/`RunRef` allocation, and run-directory promotion — see `orchestration.instructions.md`.

</boundaries>

<runtimeModel>

## Execution ownership

- Keep status logic in `WorkflowStateMachine`; do not add parallel status fields elsewhere.
- Keep step ordering/current index/results/final-step runtime in `PromptQueue`; do not move queue mutation logic into the executor.
- `WorkflowInstance.reconcileExecutionStateAfterStepChange()` is required after queue edits that can change whether work remains. It is what keeps edited workflows aligned with `STOPPED` vs `COMPLETED`.

## Integration lifecycles

- There are two integration lifecycles: detector singletons owned by `WorkflowOrchestrator`, and per-run execution integrations created through `IntegrationFactory.createForExecution()`.
- `WorkflowInstance` caches execution integrations by harness within a `RunRef` and may carry PTY-backed ones between execution cycles of that same run in `liveInjectIntegrations`. A different `RunRef` is a fresh terminal/session boundary: close retained integrations before it starts. Disposed integrations stay in `lastRunIntegrations` only so the next fresh run can explicitly close leftover terminal tabs.
- `IntegrationFactory` is platform-agnostic and is the single factory used by both `WorkflowOrchestrator` (VS Code) and standalone CLI/server binaries — there is no VS Code-specific subclass.

## Execution loop

- `WorkflowExecutor` owns the loop. It runs **queue phase → finalStep phase**, then repeats if MCP/dynamic queue extension appended more steps.
- Disabled steps stay in the working file and are skipped by the executor; do not silently drop them from the queue.
- Script steps and prompt `preCondition` handling are executor concerns, not parser or queue concerns.

</runtimeModel>

<persistenceAndEditing>

- Persist sanitized steps only. `WorkflowStepSanitizer.stripViewOnlyWorkflowStepFields()` exists because webview-only `status`/`details` must not leak into working files.
- When a step changes shape (`PromptStep` ↔ `ScriptStep`), use replacement/sanitizing flows rather than merge updates so stale fields are not retained.
- `WorkingFileManager.updateWorkingFile()` merges disk state before writing to preserve MCP-appended prompts; use `skipMerge=true` only for intentional destructive updates.
- **The queue knows step topology and runtime; it does not know workflow settings.** `harness`, `model`, `agent`, `skills`, `mcpServers`, `hooks`, conditions, permissions, and `finalStep` live only in the definition file on disk. Any code that _rewrites_ a definition from `IWorkingFileQueueAccess` must merge the current head first (`readCurrentDefinitionHead()` in `promoteToNewRun`, the `...source` spread in `seedNewRun`) — building a run file from queue state alone drops every setting silently, so the first execution runs on global defaults and the run forever displays none of what the user configured.
- **Two registries describe one client and must not drift**: `viewerRegistry` (client → `WorkflowInstance`) and `viewAddressRegistry` (client → `WorkflowViewAddress`). They drift in both directions and both are bugs. Address follows instance: anything that changes which _instance_ a client edits must re-derive the address — `setViewedWorkflowId` and the instance's own lineage-identity change both do. Instance follows address **at lineage granularity only**: `loadRunViewForClient` calls `bindClientToAddressedLineage` first, so a client that switches _workflow_ also switches instance (terminals, live-message filtering, prompt-editor execution, and every edit still reaching `getInstanceForClient` resolve through the instance, not the address — leaving it behind made a switched-to workflow show the old workflow's terminals and run the old workflow's steps and settings). Binding is never run-scoped: viewing an older run adopts the same instance that owns the lineage's executing run, so browsing history still cannot fork a second instance for one lineage or redirect an executor. Only a lineage with no resident instance materializes a fresh one.
- **Every definition write must republish revisions to the client.** `definitionRevision` is optimistic-concurrency state the client echoes back on its _next_ mutation, so a write whose only back-channel is `STEPS_EXTENDED` (queueing a step, renaming, creating a lineage's first draft) leaves the client holding a superseded revision and its next edit is rejected as a conflict. `WORKFLOW_VIEW_IDENTITY` is the cheap publisher for those paths; `RUN_VIEW_LOADED` carries the same fields in a full snapshot. Publish it to **every** client viewing the written address (`publishViewIdentityToViewers`), not just the acting one — the revision a write supersedes is per-address, not per-client. Publish it on **rejection** too: a conflict is normally the client holding a superseded revision, so a rejection that publishes nothing is terminal — every later edit _and_ the header's Run are rejected identically, which reads as a dead button. And the client must never let one in-flight run-view request suppress identity for the address it is already displaying, or a single lost/rejected `LOAD_RUN_VIEW` freezes its revisions for good.
- **Route every dashboard definition mutation by the client's addressed `mutation` context, not by the bound instance.** The instance-bound write path is only correct when the instance's queue owns the exact addressed run (`getQueueState().workflowKey/runRef` match) — the established dual-path seam is `applyRunAddressedMutation`, and run actions use the `appendAndContinueAtRun`/`continueAtRun` continuation contract. `executeEphemeralPrompt` is the cautionary example: it shipped instance-bound only, so a prompt-editor submission while viewing an older run silently appended to and re-executed whatever run the lineage instance last loaded (typically the latest). A new mutation path whose webview sender doesn't attach `mutation` (via `postWorkflowDefinitionMutation`) has the same bug latently — the backend can't route what the client never sends.
- **Read a client's current definition from its view address, never from `getQueueState(clientId)`.** Same root cause as the address/instance split above, in the read direction: the bound instance is only lineage-accurate, so a client viewing an older run of its own lineage has an instance that owns a different run's file — and mid-switch it can still own none at all. `WorkflowOrchestrator.getViewFilePath()` is the seam for this (`WebviewSettingsSync.sendWorkflowPropertiesToSettings` is the cautionary example: it read the instance's file and republished the _previous_ workflow's properties right on top of the correct ones the panel had just received from `RUN_VIEW_LOADED`). Keep the instance path only as a fallback — an address can briefly name a promoted draft's already-deleted file.
- **A third per-client map, `viewMessageSinks`, is what makes server-initiated view pushes reachable.** `syncExecutingRunViews` (draft → executing run at RUNNING) and `invalidateRunViews` both silently skip any client with no sink, so the sink is registered in `registerClient` at client-ready — not only when a run view is explicitly loaded. Otherwise the plain "new workflow → queue → run" client is never told its draft was promoted, and it keeps editing and offering to run a draft address for a run that has already executed.
- **A seeded or newly materialized execution owner must switch the initiating client before execution messages begin.** Prepare the run working file and timeline first, register the instance so replay can resolve it, then replay/switch the initiating client and only then execute. Other clients keep their independent run addresses. Without this ordering Re-run executes correctly on disk while the editor remains bound to the source run, so every later prompt and property change targets the old instance.
- `WorkingFileManager.expectDefinitionRevision()` arms a strictly one-shot guard: the assertion consumes it, pass or fail. It must never stay armed, or a superseded expectation rejects a later unrelated write — including one to a different lineage's file after the queue changed working files.
- `PromptQueue.runtimeArchive` is the reason undo/redo can restore `_runtime` metadata even after delete/reinsert flows.

</persistenceAndEditing>

<dashboardReplay>

- `WorkflowTaggedSink` only solves live per-workflow message tagging.
- `DashboardBroadcastHub.updateSessionRestored()` is intentionally a no-op, so loading a working file is **not** complete until `WorkflowOrchestrator.replayWorkflowStateTo()` runs.
- Always call `replayWorkflowStateTo()` **after** `instance.loadWorkingFile(...)`. Replaying too early, or only sending partial dashboard messages, leaves restored workflows looking idle because `SESSION_RESTORED` never reaches the client.
- `replayWorkflowStateTo()` sends the addressed `RUN_VIEW_LOADED` **before** the live replay (so its live-output reset can't wipe the reconnect buffer), but the client's `SESSION_RESTORED` handler then runs `applyWorkflowChange()`, which clears the displayed view address/revisions. `replayOutputHistoryTo` re-populates the output the clear wiped, but nothing re-publishes the address — so the replay must re-emit `WORKFLOW_VIEW_IDENTITY` **after** the live replay, or the switched-to run loses its address and the header's Run/Re-run collapses to the disabled "Load a workflow to run" state. This is why `SESSION_RESTORED`/`FILE_SELECTED` clearing the address is safe only when followed by an identity/`RUN_VIEW_LOADED` republish.
- Reuse retired instances when reopening finished workflows; that preserves PTY/session associations across panel switches.

</dashboardReplay>

<parsingAndValidation>

- `PromptFileParser` validates against the bundled schema in `out/schemas`, but the editable source of truth is `schemas/`.
- Parsing normalizes both queue steps and `finalStep`; either can be a prompt step or `type: "script"` step.
- Workflow-level execution properties (`harness`, `model`, `agent`, `skills`, `mcpServers`, `hooks`, `priorContext`, `additionalArgs`, `toolPermissions`, etc.) are copied onto the normalized `PromptFile` and then resolved per step later by `PropertyResolver`.
- Prompt values that look like file paths are resolved relative to prompt file directory, workspace root, then `.ctrlyoke/`.

- `EndConditionHandler` owns retry orchestration and stays iterative/callback-based to avoid circular executor dependencies.
- `EndConditionEvaluator` is security-sensitive: canonicalize paths before boundary checks, allow workspace-root and `~/.ctrlyoke/scripts`, and never replace `isWithinDirectory(...)` with naive prefix checks.
- If end-condition script resolution fails, evaluator deliberately falls back to treating the value as a direct shell command.

</parsingAndValidation>

<sharedContracts>

- `QueueOperations.ts` is the shared contract for queue status/append behavior across MCP server, LM tools, and command paths. Keep request/response types and position semantics centralized there.
- `TemplateManager` reads built-in template metadata from `_templateMeta` in template files; `blank` is the one built-in generated in code instead of loaded from disk.
- `OutputCaptureBuffer` is the per-workflow replay buffer for inactive/background workflows; it captures regular steps and final-step loops separately so dashboard state can be reconstructed when views switch.

</sharedContracts>

<entryPoints>

- `WorkflowOrchestrator.ts`
- `WorkflowInstance.ts`
- `WorkflowStateMachine.ts`
- `PromptQueue.ts`
- `WorkflowExecutor.ts`
- `PromptFileParser.ts`

</entryPoints>
