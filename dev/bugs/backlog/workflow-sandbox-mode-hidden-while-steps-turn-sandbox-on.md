# Workflow Sandbox mode is hidden while steps that turn the sandbox on still use it

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, code review of 2024732ca)
- **Area:** `src/ui/webview-react/components/layout/WorkflowPropertiesPanel.tsx` (`sandboxModeVisible`), `src/types/DashboardConstants.ts` (`sandboxModeApplies`)
- **Severity:** low

## Symptom

Since 2024732ca the workflow Properties → Permissions tab shows **Sandbox mode**
only while the *workflow's* sandbox resolves to On (workflow `sandbox`, then
`defaults.sandbox`). The CHANGELOG justifies this with "Off and None ignore
it". That is true for a single step but not for the workflow level: a step
that sets `sandbox: true` and omits `sandboxMode` inherits the workflow's
`sandboxMode`.

So with this workflow:

```yaml
name: w
sandbox: false
sandboxMode: read-only
steps:
  - prompt: build it
    sandbox: true      # runs sandboxed, read-only (inherited from the workflow)
  - prompt: summarize
```

- The step runs with a **read-only** sandbox.
- The workflow Permissions tab hides **Sandbox mode**, so the value that
  governs that step can't be seen, changed or reset there. The only trace is
  the step drawer's "Inherit (Read-only)" label.
- A user who sets the workflow to Off, sets a mode, and then turns one step
  On has no workflow-level control for the mode at all.

## Steps to Reproduce

1. Open the workflow above in the dashboard (or set workflow Sandbox to Off
   with `defaults.sandbox` Off, and author `sandboxMode: read-only`).
2. Open Properties → Permissions. **Sandbox mode** is not shown.
3. Open step 1's Properties → Permissions: Sandbox On, Sandbox mode
   "Inherit (Read-only)". The workflow value applies but can only be edited
   by editing the file.

## Root Cause

`resolveExecutionProperties` (`src/types/ExecutionPropertyResolver.ts`,
around lines 511–516) resolves `sandbox` and `sandboxMode` independently, each
step → workflow → defaults. A step's `sandbox: true` therefore picks up the
workflow's `sandboxMode` even when the workflow's own `sandbox` is Off or None.

`WorkflowPropertiesPanel.tsx` computes
`sandboxModeVisible = sandboxModeApplies(resolveSandboxRequest(workflowProperties.sandbox, globalSettings.sandbox))`,
which considers only the workflow level and ignores the steps that inherit
the mode from it. The step drawer (`PropertiesDrawer.tsx`) is correct for a
step, because a step's mode only affects that step.

## Suggested Fix

In `WorkflowPropertiesPanel.tsx`, show **Sandbox mode** when any of these is
true:

- the workflow sandbox resolves to On (today's rule);
- any queue step or the `finalStep` authors `sandbox: true` and does not
  author its own `sandboxMode` (the panel already reads the store's flat
  `steps` and `finalStep` near line 606 for `inlineSecretNames`; reuse them);
- the workflow authors a `sandboxMode` value, so an authored value is never
  hidden where it can't be reset.

Keep the step drawer's rule unchanged. Extend the existing test "shows sandbox
mode only when the sandbox resolves to On…" in
`src/ui/webview-react/test/components/layout/WorkflowPropertiesPanel.test.tsx`
with a workflow-Off case where a step sets `sandbox: true` (mode visible) and
one where the workflow authors `sandboxMode` (mode visible). Update the
CHANGELOG **Changed** entry for the reorder and the **Sandbox mode** bullet in
`docs/workflows/properties-panel.md` so they no longer claim the workflow
mode is ignored whenever the workflow sandbox is Off.
