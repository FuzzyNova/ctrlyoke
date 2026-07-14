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
- `WorkingFileManager` is the only place that should write `.ctrlyoke/.working/*.ctrlyoke.json`.

</boundaries>

<runtimeModel>

## Execution ownership

- Keep status logic in `WorkflowStateMachine`; do not add parallel status fields elsewhere.
- Keep step ordering/current index/results/final-step runtime in `PromptQueue`; do not move queue mutation logic into the executor.
- `WorkflowInstance.reconcileExecutionStateAfterStepChange()` is required after queue edits that can change whether work remains. It is what keeps edited workflows aligned with `STOPPED` vs `COMPLETED`.

## Integration lifecycles

- There are two integration lifecycles: detector singletons owned by `WorkflowOrchestrator`, and per-run execution integrations created through `IntegrationFactory.createForExecution()`.
- `WorkflowInstance` caches execution integrations by harness within a run, may carry PTY-backed ones across runs in `liveInjectIntegrations`, and keeps disposed run integrations in `lastRunIntegrations` only so the next run can explicitly close leftover terminal tabs.
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
- `PromptQueue.runtimeArchive` is the reason undo/redo can restore `_runtime` metadata even after delete/reinsert flows.

</persistenceAndEditing>

<dashboardReplay>

- `WorkflowTaggedSink` only solves live per-workflow message tagging.
- `DashboardBroadcastHub.updateSessionRestored()` is intentionally a no-op, so loading a working file is **not** complete until `WorkflowOrchestrator.replayWorkflowStateTo()` runs.
- Always call `replayWorkflowStateTo()` **after** `instance.loadWorkingFile(...)`. Replaying too early, or only sending partial dashboard messages, leaves restored workflows looking idle because `SESSION_RESTORED` never reaches the client.
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
