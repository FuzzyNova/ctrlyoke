---
applyTo: "src/types/{DashboardConstants.ts,CtrlYokeTypes.ts,WorkflowContextTypes.ts,CtrlYokeSettings.ts,CliOutputTypes.ts,IDashboardSink.ts}"
---

<constantsAndCoreContracts>
- `DashboardConstants.ts` is the single source of truth for shared runtime discriminants, message names, harness IDs, settings scopes, notification modes, etc. Add both the `as const` object entry and the derived helper type there; do not hardcode the same string anywhere else.
- `CtrlYokeTypes.ts` is the workflow/runtime contract. Preserve the three-tier precedence model (prompt > workflow > settings) and the null-disable semantics on inherited execution properties.
- Keep `WorkflowStep` as the canonical discriminated union for prompt vs script steps. New step-shared fields belong in the shared interfaces, not in duplicated prompt/webview shapes.
</constantsAndCoreContracts>

<workflowRuntimeGotchas>
- `WorkflowStateMachine` owns runtime status transitions; `PromptQueue` and history code project from those types. Avoid introducing parallel status enums or ad-hoc transition payloads.
- `WorkflowContextTypes.ts` is the harness-facing seam. If a harness needs more context, add it there instead of inventing local inline shapes in `HarnessIntegration` subclasses.
- `IDashboardSink.ts` intentionally stays VS Code-free and does not own message payload construction. `PostMessageDashboardSink` is the place where sink calls become concrete webview/server messages.
</workflowRuntimeGotchas>

<settingsAndCliContracts>
- `CtrlYokeSettings.ts` mirrors the config service shape, not raw `package.json` settings. Keep defaults and nested setting groups aligned with `CtrlYokeConfigService`/`ConfigurationUtils`.
- `CliOutputTypes.ts` is the harness-normalization boundary. Add new structured CLI event/data shapes here first, keeping them chronological and harness-agnostic, before threading them into webview rendering.
- `DashboardConstants.ts` imports static model lists from `utils/ModelConstants`; do not duplicate default model IDs in multiple files.
</settingsAndCliContracts>
