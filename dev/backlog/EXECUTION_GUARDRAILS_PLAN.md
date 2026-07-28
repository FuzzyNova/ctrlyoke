# Workflow Execution Guardrails Plan

**Status:** Proposed  
**Priority:** High — before scheduling or parallel-step expansion

## Problem

ctrlyoke supports retries, long-running scripts, parallel workflows, and dynamic
queue extension by an AI agent. Those capabilities need run-level limits before
the product encourages unattended scheduling or expands concurrency.

Today a valid workflow can consume more wall time, retries, or dynamically added
steps than the author intended. Provider token reporting is also uneven, so the
design must distinguish hard limits ctrlyoke can always enforce from best-effort
usage limits.

## Product Decision

Add a single `limits` contract with three-tier resolution (step, workflow, global
settings) and conservative, observable enforcement.

Hard limits:

- `maxDurationMs` — wall-clock run or step duration
- `maxSteps` — total executable steps, including dynamically appended steps
- `maxTotalAttempts` — attempts across the run, including retries
- `maxConcurrentSteps` — future-facing cap used by parallel-step execution

Best-effort limit:

- `maxObservedTokens` — stops before the next prompt once reported cumulative
  usage reaches the threshold; never claim exact enforcement when a harness
  cannot report usage

Limits do not replace existing per-script timeouts or end-condition retry
settings. They are the outer safety envelope.

## Phase 1 — Hard run envelope

- Add typed and schema-validated `limits` to workflow/default settings.
- Resolve limits through the existing property-resolution pattern.
- Count original and dynamically appended executable steps.
- Count attempts at the executor boundary so harness failures, pre/end-condition
  retries, and script retries cannot each maintain separate budgets.
- Classify a limit stop distinctly from user cancellation and harness failure.
- Persist the triggering limit and observed counters in the run manifest.

## Phase 2 — UX and preview

- Show effective limits in workflow properties.
- Display remaining time/steps/attempts while a run is active.
- Include resolved limits and warnings in dry-run preview.
- Warn before starting a workflow whose current step count already exceeds its
  configured cap.

## Phase 3 — Observed token limit

- Build on cumulative prompt usage rather than the current context-window
  percentage.
- Label incomplete provider data as partial.
- Stop only at safe step/attempt boundaries; do not kill a harness mid-write
  solely because a delayed token event crossed the threshold.

## Semantics to settle during implementation

- Global defaults should be finite for dynamic queue growth but generous enough
  not to break normal workflows.
- A workflow may lower global limits freely. Raising an administrator-enforced
  ceiling should require an explicit setting outside the workflow file.
- A resumed run retains its original consumed counters.
- A manually appended step is subject to the same `maxSteps` cap as an
  AI-appended step.

## Acceptance criteria

- No dynamic workflow can grow beyond its effective hard step cap.
- Retry/attempt accounting is shared and persisted.
- Limit-triggered stops are visible and distinguishable from errors/cancel.
- Scheduling and parallel-step work consume this contract rather than inventing
  their own safety settings.
