# Copy Metadata reports the global sandbox when the workflow sets Sandbox to None, and calls a step's None "disabled"

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, failing Vitest probe)
- **Area:** `src/ui/webview-react/utils/stepMetadataClipboard.ts` (`buildStepMetadataClipboardText`, the `sandbox` `resolvedLine`, and `resolvedLine`'s `null` branch)
- **Resolution:** fixed in this commit

## Symptom

A step's **Copy Metadata** text reports the wrong sandbox when the workflow's
Permissions tab sets **Sandbox** to **None** (`sandbox: null`) and
`defaults.sandbox` in settings is `true`:

```
sandbox: true (inherited)
sandboxMode: workspace-write (inherited)
```

At runtime the step passes no sandbox flags at all (None), because
`resolveExecutionProperties` (`src/types/ExecutionPropertyResolver.ts`,
`select()`) treats `null` as a value and stops the walk at the workflow level.
The Permissions tab gets this right since 2024732ca (`resolveSandboxRequest`),
so the Inherit label and Copy Metadata now disagree.

When the step itself sets `sandbox: null`, Copy Metadata prints
`sandbox: (none) — explicitly disabled`. None does not disable the sandbox.
**Off** (`false`) is the value that turns each harness's sandbox off. None
passes no sandbox flags, which leaves the harness's own default in place
(`docs/workflows/properties-panel.md`). So that line describes Off, not None.

## Steps to Reproduce

Vitest probe (in `src/ui/webview-react/test/utils/`):

```ts
useSettingsStore.setState({
  workflowProperties: { ...useSettingsStore.getState().workflowProperties, sandbox: null },
  globalSettings: { ...useSettingsStore.getState().globalSettings, sandbox: true },
} as never);
const text = buildStepMetadataClipboardText({ step: { prompt: "p" } as WorkflowStep, slotNumber: 1 });
// text contains "sandbox: true (inherited)"
```

## Root Cause

The sandbox line uses `workflowProperties.sandbox ?? globalSettings.sandbox`.
`??` falls through on `null`, so a workflow-level None is skipped. 2024732ca
added `resolveSandboxRequest` to `DashboardConstants.ts` for exactly this, but
this call site was not converted. Separately, `resolvedLine` renders every
step-level `null` as "explicitly disabled", which is right for
`endCondition`/`preCondition` but wrong for `sandbox`.

## Suggested Fix

- Use `resolveSandboxRequest(workflowProperties.sandbox, globalSettings.sandbox)`
  for the inherited sandbox value, and format sandbox values with the
  dashboard's own label helper (`sandboxValueLabel`, or whatever
  `sandboxSelectOptions` uses for On/Off/None) so `null` reads as None.
- Give the sandbox line its own null text (for example
  `sandbox: None (no sandbox flags)`) rather than the generic
  "explicitly disabled". `resolvedLine` can take an optional null label.
- Optional: only print `sandboxMode` when the resolved sandbox is On
  (`sandboxModeApplies`), matching the Permissions tab.

Tests: extend `src/ui/webview-react/test/utils/stepMetadataClipboard.test.ts`
with a workflow `sandbox: null` + global `true` case (expect None, inherited),
and a step `sandbox: null` case (expect None, not "disabled"). Reset the
settings store between tests.
