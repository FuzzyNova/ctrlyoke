# Workflow Variants: Duplicate and Fork

> **Status:** Proposed
>
> **Priority:** P2 — lightweight multi-harness comparison
>
> **Related:** `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`,
> `WORKTREE_SUPPORT_PLAN.md`

---

## Problem

ctrlyoke already has the important comparison mechanics:

- run navigation can switch a client between a lineage's draft and stored runs;
- each hosted browser tab owns its selected workflow/run and has a deep-linkable
  URL, so two tabs provide side-by-side viewing;
- distinct workflows can execute in parallel;
- Save As can export a clean workflow definition.

The remaining friction is creating the second workflow. Today a user who wants
to compare two harnesses must Save As, choose a file, open the exported file,
and then change its harness. Save As is an export operation: it does not create,
register, and open a new independent lineage.

Do not build a native split view, run-alignment service, evaluator, or comparison
report merely to remove this setup friction.

## Product Decision

Add two user-facing actions backed by one shared workflow-cloning operation:

1. **Duplicate Workflow** — copy the current draft into a new independent
   workflow lineage.
2. **Fork as New Workflow** — create a new independent draft from the currently
   viewed draft or historical run.

Both actions create a draft with no copied run history or runtime ownership. The
dialog allows the user to set a new name and optionally override the workflow's
harness and model before creating it. On success, ctrlyoke refreshes the
workflow list and switches only the requesting client to the new draft.

The labels communicate intent; they must not become separate cloning
implementations.

## Semantics

### Duplicate Workflow

- Primary entry point: the current workflow's actions menu.
- Default source: the current lineage's draft. If the client is viewing a run,
  make the source explicit rather than silently duplicating a different
  definition.
- Default name: `<source name> Copy`, with collision-safe allocation.
- Copies the authored definition, including prompts, scripts, conditions,
  workflow properties, agents, skills, MCP configuration, and granular
  permissions.
- Does not copy run history, execution state, timestamps, output, session IDs,
  runner locks, favorite state, or undo history.

### Fork as New Workflow

- Entry points: draft actions and each historical run's actions.
- Uses the exact addressed draft/run snapshot as its source.
- Creates a new draft rather than rewinding or editing the source lineage.
- May store lightweight provenance in the new lineage descriptor:
  source workflow key, source run ref when applicable, source display name, and
  creation time.
- Provenance is informational. The two histories remain independent and
  deleting one lineage must not invalidate the other.

### Harness Variant Shortcut

The creation dialog should make the common bake-off flow fast:

1. choose **Duplicate Workflow** or **Fork as New Workflow**;
2. enter a name;
3. select a harness and, when relevant, model override;
4. create and open the new draft.

Do not require a harness change. Duplicating a workflow for a different prompt,
permission policy, or condition is equally valid.

## Shared Clone Contract

Use one platform-neutral application service rather than reproducing file
manipulation in the React client, VS Code adapter, CLI, or hosted server.

Conceptual request:

```typescript
interface CreateWorkflowVariantRequest {
  source: WorkflowViewAddress;
  workflowName: string;
  overrides?: {
    harness?: HarnessId;
    model?: string;
  };
  recordOrigin: boolean;
}
```

The service should:

1. validate and resolve the exact `WorkflowViewAddress`;
2. read the addressed working definition;
3. strip runtime-only data through the same shared sanitizer used by Save As;
4. apply the new name and optional overrides;
5. allocate a new lineage through `WorkflowLineageRepository.createLineage`;
6. write the new draft atomically;
7. return its new draft address.

Extract Save As's clean-workflow allowlist from `WorkflowSerializer` into a
shared pure helper. Duplicate, fork, templates, and export must not acquire
slightly different definitions of "runtime-free workflow."

Creation is all-or-nothing. If writing the draft fails after lineage allocation,
remove only the newly allocated incomplete lineage and report the failure.

## UX

- Put **Duplicate Workflow…** in the current workflow action menu.
- Put **Fork as New Workflow…** in draft and run context menus.
- Reuse one dialog with source identity, name, harness, and model fields.
- After creation, open the new draft immediately in the requesting client.
- In hosted mode, optionally offer **Open in New Tab** after creation using the
  existing workflow-address URL route. This is a convenience, not a new split
  view.
- Keep the source workflow untouched and selected in all other clients.
- Announce success/failure accessibly and return focus predictably when the
  dialog closes.

## Comparison Flow

The intended lightweight flow is:

1. author one workflow;
2. duplicate or fork it;
3. choose a different harness/model;
4. run each workflow;
5. switch between their rows or open each URL in a separate browser tab;
6. compare status, output, changed files, duration, and workflow total tokens.

`PROMPT_TOTAL_TOKEN_USAGE_PLAN.md` adds aligned workflow-total token usage to
`WorkflowList.tsx`, making the common harness comparison visible without a
dedicated comparison engine.

## Concurrency and Worktrees

Creating variants does not imply that it is safe to run both at the same time
in one checkout. Parallel workflows can edit the same files and interfere with
one another.

- Do not add a **Race** or **Run Both** action in this plan.
- Sequential execution remains fully supported.
- Users may manually run variants in parallel under the existing behavior.
- Coordinated simultaneous launch belongs after `WORKTREE_SUPPORT_PLAN.md` can
  give each write-capable workflow an isolated checkout.

## Implementation Phases

### Phase 1 — Shared clone operation

- [ ] Extract the runtime-free workflow sanitizer from `WorkflowSerializer`.
- [ ] Add a platform-neutral variant creation service over
      `WorkflowLineageRepository`.
- [ ] Support draft and historical-run source addresses.
- [ ] Add shared request/result message contracts and explicit error handling.
- [ ] Unit test exact-source resolution, runtime stripping, override
      application, collision-safe naming, and rollback of incomplete creation.

### Phase 2 — Duplicate and fork UX

- [ ] Add **Duplicate Workflow…** to current-workflow actions.
- [ ] Add **Fork as New Workflow…** to draft/run actions.
- [ ] Add the shared name/harness/model dialog.
- [ ] Refresh recent workflows and switch only the requesting client to the new
      draft.
- [ ] Add React tests for action visibility, dialog validation, success,
      failure, focus, and per-client switching.

### Phase 3 — Hosted convenience

- [ ] Add **Open in New Tab** using the existing serialized workflow route.
- [ ] Verify two tabs retain independent selected addresses during live updates.
- [ ] Keep native split view out of scope until user evidence shows that browser
      tabs are insufficient.

## Acceptance Criteria

- A current draft can be duplicated and opened without exporting or reopening a
  file.
- Any stored run can be forked into a new draft from its exact snapshot.
- The source lineage and its run history remain unchanged.
- The new lineage contains no `_runtime`, output, sessions, locks, timestamps,
  favorite state, or inherited history.
- Harness/model overrides are applied only to the new draft.
- Other connected clients keep their current workflow/run selection.
- Save As, Duplicate, and Fork share one definition-sanitizing implementation.
- No simultaneous paid harness executions are launched as a side effect.

## Non-goals

- A native split-screen comparison view.
- Step alignment, scoring, or an AI evaluator.
- A universal harness leaderboard.
- Automatically executing every variant.
- Copying or linking run histories.
- Safe same-checkout racing before worktree isolation.
