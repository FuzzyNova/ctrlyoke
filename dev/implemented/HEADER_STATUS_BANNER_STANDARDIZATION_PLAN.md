# Header Status Banner Standardization Plan

> **Status:** Implemented
>
> **Relationship:** Builds on the UI surface introduced by
> `dev/implemented/MULTI_INSTANCE_WORKSPACE_COORDINATION_PLAN.md` (Phase 2,
> `WorkflowSummary.managedBy` + the `isExternallyManaged` badge) and on the
> system-generated lockdown added by
> `dev/backlog/COMMIT_MESSAGE_GENERATION_VISIBILITY_PLAN.md` (now implemented).
> Independent of `dev/backlog/MULTI_INSTANCE_RUNNER_OWNERSHIP_HARDENING_PLAN.md`,
> which reshapes `managedBy` into an `externalOwner` projection at the
> data/orchestration layer — this plan should consume whichever shape is
> current at implementation time (see §6).

## Problem

The dashboard currently has **four** distinct reasons a loaded workflow can be
locked into read-only mode, and they are surfaced with three different (and
inconsistent) levels of visibility:

| Lockdown reason                                   | Where it's decided                                                             | Where it's shown today                                                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow deleted                                  | `useIsViewingDeletedWorkflow()`                                                | Full-width banner, `Header.tsx:920-939`                                                                                                                                                  |
| Owned by the ctrlyoke CLI                         | `WorkflowSummary.managedBy === RUNNER_IDS.CLI`                                 | Tiny uppercase chip crammed into the workflow status row, `WorkflowStatus.tsx:1610-1622`                                                                                                 |
| Owned by a sibling ctrlyoke VS Code window        | `WorkflowSummary.managedBy === RUNNER_IDS.VSCODE`                              | Same chip as above, text "VS Code" instead of "CLI"                                                                                                                                      |
| System-generated (e.g. commit-message generation) | `useIsSystemGeneratedWorkflow()` → `isLineageReadOnly` in `Header.tsx:186-188` | **Nothing visible.** Only surfaces as a button tooltip ("Managed automatically by commit message generation") when the user hovers a disabled control — `Header.tsx:275-276,551,578,613` |

Three problems fall out of this:

1. **The CLI/VS Code chip is squeezed into an already-tight row.**
   `WorkflowStatus.tsx`'s header segment has to fit the workflow name, step
   count, execution-state badge, and dropdown trigger — a third badge for
   external ownership has no comfortable place to live, and today it just gets
   the uppercase-chip treatment because that's what fits, not because it's the
   clearest way to communicate "you can't edit this."
2. **System-generated lockdown is invisible.** A user viewing a
   commit-message-generation run today sees every editing control disabled
   with no on-screen explanation — they'd have to hover a specific button to
   learn why. It's locked exactly as hard as a CLI/VS-Code-owned or deleted
   workflow, but only those get an announcement.
3. **The `managedBy` derivation is duplicated four times** with identical code
   (`loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy`):
   `WorkflowStatus.tsx:203-205`, `EditorSection.tsx:54-56`,
   `WorkflowStepsPanel.tsx` (same pattern, feeds `getExternalReadOnlyLabel`),
   and `PromptChipRail.tsx` (same pattern). This violates the project's
   single-source/DRY principle and is worth fixing while this area is being
   touched regardless of the banner redesign.

## What we already have to build on

- `Header.tsx:907-966` already renders a full-width, unnamed banner row
  directly under `<header>` for three cases: `isPausing` (908-919),
  `isViewingDeletedWorkflow` (920-939), and `pendingRewind` (940-967). This row
  has no name in the codebase today — this plan gives it one.
- `getExternalRunnerLabel` / `getExternalReadOnlyLabel`
  (`src/ui/webview-react/utils/externalRunner.ts`) already produce the exact
  copy this plan needs ("Read-only — workflow is running via ctrlyoke CLI" /
  "...via another ctrlyoke window"). They're currently consumed only as inline
  per-panel explanations inside `EditorSection.tsx`, `WorkflowStepsPanel.tsx`,
  and `PromptChipRail.tsx` — never as a standalone announcement.
- `useIsSystemGeneratedWorkflow()` (`hooks/useIsSystemGeneratedWorkflow.ts`) is
  already a clean single-sourced selector — the pattern to copy for the
  `managedBy` derivation (see §5).
- A structurally similar "read-only ownership" banner already exists for a
  **different** case — a window opened directly on a managed/named worktree —
  rendered by `RunSummaryBanner.tsx` (`src/ui/webview-react/components/output/
RunSummaryBanner.tsx`), per Phase 2 item 1 of the coordination plan. That
  banner lives in the output/run-summary area, not under the header, and is
  about the _window's own root_ rather than _the currently viewed workflow_ —
  it is out of scope for this plan (see Non-Goals), but is worth knowing about
  so the two aren't accidentally built as competing patterns later.

## Goals

1. Name the row under the header and give it one component.
2. Move CLI/VS-Code external ownership out of the cramped `WorkflowStatus`
   badge and into that row as a full, readable banner.
3. Give system-generated workflows the same visible announcement that
   deleted/externally-managed workflows already get.
4. Define one explicit precedence order across all banner types so at most one
   "reason this is locked" message is ever shown, plus (at a lower tier) the
   existing transient own-workflow banners.
5. Single-source the `managedBy` derivation this work already has to touch.

## Non-Goals

- Do not change _what_ triggers each lockdown condition (the CLI/VS-Code/
  system-generated/deleted booleans themselves) — this is a presentation
  consolidation, not a behavior change to read-only rules.
- Do not touch `RunSummaryBanner.tsx`'s worktree-root ownership banner. It
  answers a different question ("is this whole window a worktree owned by
  another checkout") and lives in a different part of the layout. If a future
  pass wants to unify the two, that's a separate plan.
- Do not adopt `MULTI_INSTANCE_RUNNER_OWNERSHIP_HARDENING_PLAN.md`'s
  `externalOwner` type change as part of this plan. That plan is about lock
  semantics correctness at the orchestration layer and may or may not have
  landed by the time this one is implemented — this plan's component should
  read whatever the current shape is (`managedBy` today, `externalOwner` if
  that plan ships first) without taking on that migration itself.
- Do not add a dismiss/close affordance to the externally-managed or
  system-generated banners — unlike the deleted banner (which offers "Close"
  to drop a cached view) or the pausing/rewind banners (which offer
  cancel/discard actions on state _this_ window owns), these two banners
  describe real, live state this window doesn't control. There is nothing
  correct for a dismiss action to do.

## Proposed Design

### Name and extract the component

Extract `Header.tsx:907-966` into its own component,
`src/ui/webview-react/components/layout/HeaderStatusBanner.tsx`. Keep it in
`components/layout/` alongside `Header.tsx` since it is exclusively a header
sub-region, not a general-purpose shared banner.

### Precedence order

Exactly one of the following renders at a time, checked in this order (highest
precedence first). This matches the ordering the user specified when scoping
this plan:

1. **Deleted.** `isViewingDeletedWorkflow` — unchanged content/behavior from
   today's `Header.tsx:920-939`. If the workflow is deleted, nothing else in
   this row renders, regardless of any other state.
2. **Locked (external or system).** Exactly one of:
   - CLI-managed (`managedBy === RUNNER_IDS.CLI`)
   - Sibling-VS-Code-managed (`managedBy === RUNNER_IDS.VSCODE`)
   - System-generated (`isSystemGeneratedWorkflow`)

   These three are mutually exclusive in practice today (a workflow is either
   a real user lineage that might be externally owned, or a system-generated
   lineage that always executes locally and headlessly — see
   `buildCommitWorkflowOverrides()` in `src/git/CommitMessageGenerator.ts`,
   which forces `resumeSession: false` and headless execution, not something
   watched externally). If a future system-generated workflow type could ever
   also be externally owned, prefer `managedBy` over `isSystemGeneratedWorkflow`
   when choosing which single message to show, since "who is driving this run"
   is more actionable information than "why this lineage is locked."

3. **Own-workflow transient state.** Only reached when neither 1 nor 2 applies
   (i.e. we own this workflow and it isn't deleted): today's `isPausing`
   (908-919) and `pendingRewind` (940-967) banners, unchanged. Preserve their
   existing relative behavior — both are independent conditions today and nothing
   in this plan requires making them mutually exclusive; only gate the pair
   behind "not deleted and not locked."

### Content for the new "Locked" banner tier

Reuse existing copy rather than inventing new strings:

- CLI: `getExternalReadOnlyLabel(RUNNER_IDS.CLI)` → "Read-only — workflow is
  running via ctrlyoke CLI"
- Sibling VS Code: `getExternalReadOnlyLabel(RUNNER_IDS.VSCODE)` → "Read-only —
  workflow is running via another ctrlyoke window"
- System-generated: reuse the existing tooltip copy verbatim — "Read-only —
  managed automatically by commit message generation" (today's tooltip text is
  "Managed automatically by commit message generation"; prefix it with
  "Read-only — " to match the other two for visual/verbal consistency). Do not
  generalize this into a per-lineage reason string sourced from
  `WorkflowLineageDescriptor` — there is exactly one system-generated producer
  today (commit-message generation), and inventing a reason-label field for a
  single hardcoded consumer would be speculative generality the project's
  principles argue against. If a second system-generated workflow type is
  added later, that's the natural time to widen this.

Style: match the deleted banner's visual weight (icon + text, full-width,
`border-b`), not the tiny WorkflowStatus chip — an icon (`codicon-lock` or
similar) plus the read-only sentence. No action button, per Non-Goals.

### Single-source the `managedBy` derivation

Add `useActiveWorkflowManagedBy()` to `src/ui/webview-react/hooks/`, mirroring
`useIsSystemGeneratedWorkflow()`'s shape:

```ts
export function useActiveWorkflowManagedBy(): RunnerId | undefined {
  const activeWorkflowId = useUiStore((s) => s.activeWorkflowId);
  const loadedWorkflows = useUiStore((s) => s.loadedWorkflows);
  return loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy;
}
```

Migrate the four existing inline copies
(`WorkflowStatus.tsx:203-205`, `EditorSection.tsx:54-56`,
`WorkflowStepsPanel.tsx`, `PromptChipRail.tsx`) to call this hook. This is a
pure refactor with no behavior change, bundled into this plan because the new
`HeaderStatusBanner` component needs the same derivation as its fifth
consumer and duplicating it a fifth time would make the existing problem
worse, not better.

### Removing the `WorkflowStatus.tsx` badge

Delete the `isExternallyManaged`/`activeManagedBy` badge block at
`WorkflowStatus.tsx:1610-1622` once its information is carried by
`HeaderStatusBanner`. Verify nothing else in `WorkflowStatus.tsx` depends on
`isExternallyManaged` for layout purposes before removing the surrounding
conditional (it currently also may affect spacing/flex-shrink neighbors —
check at implementation time).

## Implementation Notes / Coupling to Watch

- The pausing banner's Cancel button calls `handleSlotAction(slot2.action)`,
  and `isPausing`/`slot2` come from `getWorkflowExecutionControls()`
  (`Header.tsx:232`), which is Header-local business logic already used
  elsewhere in `Header.tsx` for button states (line 513, 585). Decide whether
  `HeaderStatusBanner` receives these as props from `Header.tsx` (simplest,
  avoids re-deriving slot logic in two places) or whether the slot logic
  itself should move — this plan recommends **props**, not a second
  derivation, to avoid two sources of truth for slot state.
- `viewingDeletedWorkflow` and `handleCloseDeletedWorkflow`
  (`Header.tsx:392-406`) likewise stay Header-owned and get passed down, since
  `handleCloseDeletedWorkflow` posts a message via `sendMessage`/`vscode` APIs
  already wired into `Header.tsx`.
- `pendingRewind` and `handleDiscardContinuation` (`Header.tsx:392-399`)
  follow the same pattern.
- Net shape: `HeaderStatusBanner` owns the precedence logic and the two new
  externally-managed/system-generated banners (which it can derive entirely
  from stores/hooks with no props), while the three pre-existing banners keep
  being driven by props from `Header.tsx` since their actions are tied to
  Header's existing slot/message-sending wiring. Don't force those three into
  store-only derivation just for architectural symmetry — that would be a
  bigger, riskier refactor than this plan's actual goal.

## Test Plan

- Add/extend webview tests (`src/ui/webview-react/test/components/layout/`)
  covering the precedence order directly: deleted beats externally-managed
  beats system-generated beats pausing/rewind, asserted by rendering
  `HeaderStatusBanner` with combinations of props/store state that would
  previously have rendered more than one banner simultaneously.
- Assert the CLI and VS-Code banners render the exact
  `getExternalReadOnlyLabel` copy, so a future copy change to that shared util
  is automatically reflected here without a second hardcoded string to keep in
  sync.
- Assert the `WorkflowStatus.tsx` badge is gone and that removing it didn't
  regress the status row's layout/spacing tests (existing `WorkflowStatus`
  snapshot/layout tests, if any, should be updated rather than deleted).
- Add a regression test for `useActiveWorkflowManagedBy()` itself (trivial
  selector, but worth locking in given four call sites now depend on it).

## Phasing

| Phase    | Content                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (done) | Add `useActiveWorkflowManagedBy()`; migrate the four existing inline derivations to it. No visible change.                                                                                                          |
| 2 (done) | Extract `HeaderStatusBanner.tsx` from `Header.tsx:907-966` with identical behavior/precedence (deleted → pausing/rewind, since those are the only two that exist pre-extraction). Pure refactor, no visible change. |
| 3 (done) | Add the externally-managed and system-generated banner tiers with the precedence rules in §"Precedence order"; remove the `WorkflowStatus.tsx` chip. This is the user-visible change.                               |

Phase 1-2 can land independently as low-risk refactors; phase 3 is the actual
redesign and depends on both.
