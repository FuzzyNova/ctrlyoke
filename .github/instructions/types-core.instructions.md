---
applyTo: "src/types/{DashboardConstants.ts,CtrlYokeTypes.ts,WorkflowContextTypes.ts,CtrlYokeSettings.ts,CliOutputTypes.ts,IDashboardSink.ts}"
---

<constantsAndCoreContracts>
- `DashboardConstants.ts` is the single source of truth for shared runtime discriminants, message names, harness IDs, settings scopes, notification modes, etc. Add both the `as const` object entry and the derived helper type there; do not hardcode the same string anywhere else.
- `CtrlYokeTypes.ts` is the workflow/runtime contract. Preserve the three-tier precedence model (prompt > workflow > settings) and the null-disable semantics on inherited execution properties.
- `WorkflowKey`/`RunRef` are opaque branded strings (`string & { readonly __workflowKey: unique symbol }`, etc.) identifying a lineage directory and a promoted run directory in run storage. Mint or validate them only via `src/utils/WorkflowPaths.ts` — never construct one by hand or treat a plain `string` as one without going through it. `WorkflowLineageDescriptor` is the `workflow.json` shape; `WorkflowLineageRepository` (`src/core/orchestration/`) is its only writer.
- `PriorContext` has two object forms, `{ previous: N }` and the `PriorContextRunSource` (`{ workflow, run? }`), so never discriminate it with `typeof value === "object"` — use `isPreviousStepsPriorContext`/`isPriorContextRunSource`. "Any object is a run source" had been written independently in `AddressedPriorContextResolver` and `PriorContextSelect`; the resolver version would have rejected every `{ previous: N }` as an unavailable run. The run source is the human-typed selector, not the internal `WorkflowRunAddress` (`{ workflowKey, runRef }`); it resolves to one only at execution, through `WorkflowRunSelector` — the same selector code the CLI's `--workflow`/`--run` use, so both accept the same keys, names, slugs and run numbers.
- Keep `WorkflowStep` as the canonical discriminated union for prompt vs script steps. New step-shared fields belong in the shared interfaces, not in duplicated prompt/webview shapes.
</constantsAndCoreContracts>

<workflowRuntimeGotchas>
- `WorkflowStateMachine` owns runtime status transitions; `PromptQueue` and history code project from those types. Avoid introducing parallel status enums or ad-hoc transition payloads.
- `WorkflowContextTypes.ts` is the harness-facing seam. If a harness needs more context, add it there instead of inventing local inline shapes in `HarnessIntegration` subclasses.
- `IDashboardSink.ts` intentionally stays VS Code-free and does not own message payload construction. `PostMessageDashboardSink` is the place where sink calls become concrete webview/server messages. Its positional methods are structurally checked: adding a trailing parameter does not make TypeScript catch implementations that declare fewer parameters, so update every implementation by hand and grep for the method name.
</workflowRuntimeGotchas>

<settingsAndCliContracts>
- `CtrlYokeSettings.ts` mirrors the config service shape, not raw `package.json` settings. Keep defaults and nested setting groups aligned with `CtrlYokeConfigService`/`ConfigurationUtils`.
- `CliOutputTypes.ts` is the harness-normalization boundary. Add new structured CLI event/data shapes here first, keeping them chronological and harness-agnostic, before threading them into webview rendering.
- `DashboardConstants.ts` imports static model lists from `utils/ModelConstants`; do not duplicate default model IDs in multiple files.
</settingsAndCliContracts>
