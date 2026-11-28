# Workflow Step Plan

## Status (2026-11-27)

**Complete. Every section is implemented and reviewed (rounds 1–18; see [Progress](#progress)).
The whole-spec audit after round 16 found the last gaps, which rounds 17–18 closed. Two
non-blocking questions for Nathan remain under Decisions; neither gates any requirement here.**

Shipped:

- **Both prerequisite worktree bugs** (`87c4065e4`, `1f4a87c1e`; docs in `dev/bugs/implemented/`).
- **Final-step loop sees external appends** (`234708f1e`, `PromptQueue.mergeDiskStepsUnderLock`).
- **D12a for prompt and script steps:** prior context renders full output from structured
  timeline events (`src/core/PriorContextTranscript.ts`), and script items carry a `<verdict/>`
  (`PriorContextItem.scriptVerdict`, `buildScriptVerdictXml` in `src/core/HarnessIntegration.ts`).
- **D12b, as redesigned by
  [`PRIOR_CONTEXT_DETAIL_PLAN.md`](../implemented/PRIOR_CONTEXT_DETAIL_PLAN.md):** the summary
  detail follows the kind (`$previous:summary`, `$step:summary:1,3-5`, `$all:summary`, …;
  `PRIOR_CONTEXT_SUMMARY_SEGMENT`), `priorContextDetail: full | summary` is in the schema and
  `CtrlYokeTypes.ts`, `summarizePriorContextItem` (`HarnessIntegration.ts`) applies
  `PRIOR_CONTEXT_LIMITS` (`DashboardConstants.ts`; `SUMMARY_BUDGET_BYTES: 409600` already
  caps all the summary steps in one prompt), and the editor, completions,
  diagnostics, reference-shift reporting (`src/core/StepReferenceShifts.ts`) and docs support it. Since
  `5dbca60d7` the budget omits by chronology, not position: imported-run items first, then queue
  steps before `finalStep` passes, then ascending index; the last summary is never omitted, and an
  omitted step renders `<step … omitted="all" omittedBytes="N"/>`
  (`PRIOR_CONTEXT_TRUNCATION.OMITTED_ALL`).
- **The single-source `isScriptStep` guard** (`eba32a7db`): every script check now goes through
  `isScriptStep` in `CtrlYokeTypes.ts`, which makes Phase 0 a mechanical pass.
- **Run-start and dispatch value substitution** (`9466bb930`, `1f7f44ea6`, `69f06af66`): a
  table-driven whitelist (`VAR_SUBSTITUTION_POLICY`, `src/utils/VarSubstitutionPolicy.ts`). It
  affects D11 and D13; see [Revision 5](#revision-5-decisions).
- **MCP condition-preset discovery** (`b318c17f5`, `425793e02`): `workflow_status` reports
  `metadata.conditionPresets`, `append_step` warns about ungated sequential steps, and presets
  resolve by own property only (`getDeclaredConditionPreset`, `src/utils/McpConditionPresetResolver.ts`).
  D14's `worktreePresets` copies all three.

- **Phase 0 and the schema `$defs` extraction** landed in this plan's round 1 (see
  [Progress](#progress)).

- **The sequential sub-workflow step** (rounds 2–3 of this plan; see [Progress](#progress)):
  kind, schema, parser, host factories in every host, stop/pause forwarding, D7 `parentRun`,
  D4a inheritance with D4d rule 1, the `subWorkflowSettled` event, D12a/D12b prior context, and
  the docs page `docs/workflows/sub-workflow-steps.md`.
- **Round 4:** `finalStep` sub-workflows (phase-discriminated `SubWorkflowParentLink`), prompt
  stop of script steps, D12c's `run` argument on MCP `read_output`/`workflow_status`, and D6 reattach
  (its tests and hardening are round 5's first step).
- **Round 5:** D6 hardening (tests still missing), D12c fixes and child addresses in
  `workflow_status`/`read_output`, `subWorkflowRuns` in `run --json`, the dashboard parent row
  and "Started by", and D4c for sequential worktree children.
- **Round 6:** D6 from a real resume, real-instance stop/pause propagation, the CLI child
  progress prefix, and D13 inline definitions for sequential steps (review fixes are round 7).
- **Rounds 7–8:** parallel sub-workflow members (preflight branch, per-member failures, the
  once-per-group D4c check when the group fans out, `concurrent` from the group width), the
  `cancelledBy` join rule (fail-fast vs a user-stopped lane, resume re-entering the group), stop
  and pause held until a child's cycle starts, and the single-sourced CLI reporter.
- **Round 9:** registry ownership of launched children, the join rule from persisted state, D4b
  (source checkout and main-checkout worktrees root) with D4d rule 1 for merge leases,
  `MERGE_INTO_SHARED_ROOT`, and D6 recovery of in-flight lanes after a reload.

- **Rounds 10–17:** member presentation, entry points, D14 agent lanes and `worktreePresets`,
  the sibling merge wait (`purpose: "merge"`), D4d rule 2 (sibling delegation), the dashboard
  editor, preview, completions and the audit gaps (see [Progress](#progress)).

Line numbers were re-verified on 2026-11-26 wherever this revision touched a passage, and are
otherwise pointers; re-locate by symbol. Every symbol and path named below was re-checked on
2026-11-26 and still exists unless noted.

Last reviewed against code: 2026-11-26 (Revision 5: open questions answered, corrections from
851 commits of drift, and the decisions summarized under [Revision 5](#revision-5-decisions)).

## Overview

Add a first-class `type: "workflow"` step to ctrlyoke. Its schema definition is named
`subWorkflowStep`, so it does not clash with the existing `workflowStep` wrapper. The step runs
another workflow file **to completion as its own child run**: a separate `WorkflowInstance`
with its own lineage, run directory, and dashboard entry. The child keeps its own workflow-level
`harness`, `vars`, `finalStep`, and so on; nothing is merged into the parent's queue. The parent
step blocks until the child reaches a terminal state, then maps that state to its own outcome.

Because a sub-workflow reference is just a step, "queue workflow B to run after workflow A, which
is already running" becomes "append one `{ type: workflow, workflow: B }` step to A's queue".
The queue is already the composition primitive; this plan gives it one more step type.

There is no navigation stack, breadcrumb bar, or auto-navigation. The child is an ordinary
registered instance, so it appears in `WorkflowSwitcher.tsx`'s dropdown like any other running
workflow. The parent step row gets a link to the child run.

ctrlyoke is released (latest tag `v0.10.0`). Everything here is additive: a new `workflowStep`
arm and new `_runtime`/manifest fields need `npm run schema:update` but no `schema:bump`. A new
optional `parentRun` manifest field is read-compatible: `WorkflowRunManifest` reads go through
`migrateToCurrent` with no key whitelist, the same way `activeExecutionMs` was added. A new
`subWorkflowSettled` timeline event needs no timeline bump (R3). The new lease fields are
optional, and lease files carry no `schemaVersion`. The MCP `run` argument and the `appendMode`
message field are optional additions. Record the user-visible additions under `## [Unreleased]`
in `CHANGELOG.md`.

> **Revision 2026-10-09.** Reviewed against the current codebase. Changes from the previous draft:
> schema refs moved to `$defs`; file paths and method names corrected; child launch redesigned
> around a host-agnostic port (the CLI has no orchestrator, and `createWorkflow(filePath)`
> returns an already-running instance for the same file); the "queue after running" path
> corrected (`appendAndContinueAtRun` refuses executing runs); pause redesigned to use existing
> PAUSING semantics instead of mirroring state across instances; a rule added for worktree
> inheritance; a Phase 0 refactor added for the ~50 files that branch on
> script-vs-prompt; effort re-estimated. All open questions are answered in
> [Design Decisions](#design-decisions).
>
> **Revision 2 (2026-10-09).** Parallel sub-workflow steps are now **in v1**, because fanning
> workflows out across worktrees and merging between waves is the main driver. Added:
>
> - the full worktree rules (D4a–e): the parent's checkout is the child's source checkout, a
>   dirty check before fan-out, lease delegation chains, and delegated merge leases;
> - the step's output exposes each lane's branch to merge steps (D12, redesigned in Revision 3);
> - a [Parallel Sub-workflow Steps](#parallel-sub-workflow-steps) section listing each blocker
>   and its fix;
> - two prerequisite worktree bugs filed in `dev/bugs/backlog/`.
>
> **Revision 3 (2026-10-09).** A root-level workflow step is now allowed (D8): a one-step file
> is the start of a lazy queue that more workflows are appended to. D12 is redesigned. `$previous`
> and the other step references mean the step's **full** output for every step kind; for a
> workflow step, that is every step of the child run. A new `$summary:` prefix gives a bounded,
> deterministic excerpt of any step kind. The earlier "final response only" summary is gone.
> `ctrlyoke history show` and an extended MCP `read_output` are documented as on-demand
> alternatives (D12c).
>
> **Revision 4 (2026-11-02).** Added a second motivating case:
> [isolated parallel lanes](#motivating-case-isolated-parallel-lanes). A user or an orchestrating
> agent queues parallel work where each member runs in its own worktree, so members can run the
> test suite, formatters and `git add -A` without stepping on each other. The case needs things
> earlier revisions did not have:
>
> - **D13:** a sub-workflow step's `workflow` may be an **inline single-step definition**, not
>   only a file path. An agent that writes a child file into the repo dirties the tree that the
>   D4c check and the `committed` gate both require to be clean.
> - **D14:** an MCP `append_step` arm for lanes, gated by author-defined `worktreePresets`. The
>   revision also corrects the earlier claim that MCP agents get `type: workflow` for free:
>   `append_step` accepts only flat prompt steps.
> - **D4d:** sibling merge leases now wait for each other. Today a merge lease that loses the
>   race fails at once, so two lanes that settle together would leave one `blocked`.
>
> The landing order now ships lanes for a parent on the main checkout as their own slice, right
> after the sequential core, instead of behind the full nested-worktree rules. The revision also
> records why a step-level `worktree` was rejected.
>
> **Revision 5 (2026-11-26).** Re-verified against the code after 851 commits. Every "verify
> during implementation" and "settle later" item now has an answer, listed below, and the
> passages they came from are updated in place.

## Revision 5 decisions

Each item names the question, what the code says today, and the decision.

| #   | Question                                                                                         | What the code says (2026-11-26)                                                                                                                                                                                                                                                                                                  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Ship D4a + D4d rule 1 with the sequential core, or fail worktree parents until step 3?           | A worktree parent holds an `exclusive-worktree` lease, and `isCompatible` (`ExecutionRootLeaseManager.ts:157`) allows only shared-native + shared-native, so an inheriting child conflicts.                                                                                                                                      | **Ship them with step 2.** The plan's own headline example ([YAML Authoring UX](#yaml-authoring-ux): a managed parent with an inheriting test child) and queue-after-running on a managed run both need it. Without it, step 2 errors on the most common worktree case. About 1 day.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| R2  | How does the launcher tell "failed to start" from "failed"?                                      | `executeLoadedPromptFile` never throws on startup problems. A failed preflight calls `failRuntime()`, and other startup errors go to `finalizeFailure` (`WorkflowStartupPipeline.ts:384-394`, `:707-709`, `:774`), so the state ends **ERROR**, not IDLE as earlier revisions said.                                              | `done` maps ERROR to a failed result either way. The launcher sets `SubWorkflowResult.failedToStart: true` when no child step ever reached RUNNING, which only changes the message ("Sub-workflow could not start: …"). Both go through `onFail` (D9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R3  | Name of the D12a timeline event, and is it a timeline schema bump?                               | There is no `scriptOutput` event: scripts record `scriptExecutionRecorded` (`TIMELINE_EVENT_TYPES`, `WorkflowTimelineTypes.ts:43-68`). Local readers' switches ignore unknown types. `RunBundleReader.ts:398-405` rejects a bundle containing an unknown type ("is not a recognized timeline event").                            | **`subWorkflowSettled`** (`TIMELINE_EVENT_TYPES.SUB_WORKFLOW_SETTLED`), carrying a `SubWorkflowOutput` payload. **No bump.** An older ctrlyoke importing a bundle with the event fails closed with a clear error, which is the correct behaviour. A bump would make _every_ run a newer ctrlyoke writes read-only to older versions, sub-workflow or not. Record the bundle limitation in the CHANGELOG entry.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R4  | Timeout for the D4d sibling merge-lease wait?                                                    | `acquire` never waits: it throws `ExecutionLeaseConflictError` at once (`:264-273`), and its `retry` makes one more attempt. `mergeManagedWorktree` turns _any_ acquire error into `blocked` (`WorktreeManager.ts:1043-1047`). `execution.scriptTimeoutSec` defaults to 3600 s and means "how long a script may run".            | **Don't reuse `scriptTimeoutSec`.** Add `WORKTREE_MERGE_LEASE_WAIT_MS = 120_000` to `DashboardConstants.ts`. The wait loop lives in `mergeManagedWorktree`, not the lease manager, so every other caller keeps fail-fast. It calls `error.retry()` with backoff (250 ms, doubling, capped at 2 s) only while the sole conflict is a `purpose: "merge"` lease with the same immediate delegator. A sibling holds that lease only for the guard plus `git merge`, which takes seconds.                                                                                                                                                                                                                                                                                                                                                                        |
| R5  | Is `supportsConcurrentInteractiveSessions` per instance or host-wide?                            | Neither. It is a static per-host boolean: VS Code passes `true`, and the CLI always passes `false` (`src/cli/CliExecutionMode.ts:28`). `INTERACTIVE_MULTIPLEX` (`ParallelGroupPreflight.ts:337-356`) applies it only between members of **one group**, and never counts live sessions in other instances.                        | A sub-workflow member counts as non-interactive in the parent's group (as planned). New: in the **CLI**, concurrent children would be separate instances in one process, each believing it owns the single TTY. `SubWorkflowLaunchRequest` gains `concurrent: boolean` (true for parallel members), and the CLI factory builds concurrent children with `hostCanProvidePty: false`, so their steps run headless. Sequential CLI children keep the CLI's TTY resolution. VS Code needs no change.                                                                                                                                                                                                                                                                                                                                                            |
| R6  | Does `ctrlyoke history show` find child runs when invoked from inside a managed worktree?        | No. `bootstrapCliWorkspace` (`CliWorkspaceBootstrap.ts:55`) takes the cwd, and `projectKey` (`ProjectStatePaths.ts:90`) hashes its realpath, so a worktree cwd is a **different, empty project**. That matches the documented VS Code rule that opening a worktree directly gets its own history, so it is by design, not a bug. | The in-agent path is MCP `read_output { run }` (D12c), and the truncation markers name that call. The authoring guide's CLI example always passes `-d <main checkout>`. No CLI change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R7  | Does `ctrlyoke step add` (`SCRIPT_GENERATED_STEPS_PLAN.md`) accept `type: workflow`?             | That plan validates against `workflowStep` and appends through `RunContinuationService.appendStepsToRun`, "exactly as MCP does".                                                                                                                                                                                                 | **Yes, the full `subWorkflowStep`** (file and inline), with no extra work once Phase 0 converts `assertStepHasRequiredContent`. It is author-side (a script the author wrote), so D14's MCP restriction doesn't apply.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R8  | Does the root `allOf` / `if not _templateMeta` block reject the new kind?                        | No. It only adds `harness`/`_runtime.harness` constraints (`workflow-schema.json:13-103`). Rejection today comes from `workflowStep.allOf[0].oneOf` (`:925-932`) plus `unevaluatedProperties: false` (`:953`).                                                                                                                   | Add the arm to `workflowStep.allOf[0].oneOf` only. The harness block stays untouched, because a workflow step has no harness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R9  | Which workflow-only keys does `rootWorkflowStep` accept?                                         | `rootScriptStep` (`:553-642`) has its own `unevaluatedProperties: false` and lists `worktree`, `vars`, `trustedExternalRoots` and `maxSteps`, but not `conditions`.                                                                                                                                                              | Mirror `rootScriptStep` exactly. A root workflow file has no AI step of its own, so no agent is attached to it that could use `conditions` or `worktreePresets` (agents attach to the child).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R10 | How do `{{var}}` placeholders interact with the new step now that run-start substitution exists? | Substitution is a whitelist (`VAR_SUBSTITUTION_POLICY`, `VarSubstitutionPolicy.ts:163`), and `VarSubstitutionPolicy.test.ts` requires every schema location that accepts a placeholder to have an entry or an exclusion. `conditions` is excluded as an author-only contract (`VAR_SUBSTITUTION_EXCLUDED_FIELDS`, `:457`).       | (a) A `workflow` **path** is not substituted (D11): no policy entry, and no `varPlaceholder` arm in the schema. (b) The **inline** object (`steps[].workflow`, `finalStep.workflow`, parallel members) joins `VAR_SUBSTITUTION_EXCLUDED_FIELDS`, with the reason "substituted by the child run after materialization". D13 copies the parent's _effective_ vars (after host `--var` overrides) into the child root, so the child's own run-start and dispatch substitution resolves the same values a parent step would get. (c) `worktreePresets` is excluded like `conditions`. A preset's `base`/`setup` are substituted by the child at run start, once it is copied into the child's root `worktree`. (d) `onFail` reuses `scriptStep.onFail`'s schema, including its `varPlaceholder` arm, so the existing `steps[].onFail` dispatch entry covers it. |
| R11 | Does `PREVIEW_STEP_TYPES` get `WORKFLOW`?                                                        | `PREVIEW_STEP_TYPES` (`DashboardConstants.ts:2065`) is `{ PROMPT, SCRIPT }`.                                                                                                                                                                                                                                                     | **Yes**, because the preview renders a "Runs _<file>_" entry ([Execution preview](#execution-preview)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| R12 | Should the new Large Spec Loop template (`47007a675`) get lanes too?                             | `large-spec-loop.ctrlyoke.yaml` is a finalStep-only loop that appends rounds of sequential steps; it never authors parallel steps.                                                                                                                                                                                               | **Not in v1.** Only `spec-driven-loop` declares `worktreePresets.lane`. Adding lanes to the large loop is a follow-up once lanes are proven in the smaller template.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| R13 | Where does `spec-driven-loop`'s `laneSetup` variable live?                                       | The template has no root `vars:`. Its variables are `_templateMeta.variables` entries (`:5`), used as `{placeholder}`. An empty `setup` is already "no setup" (`WorktreeManager.ts`, `options.setup?.trim()`).                                                                                                                   | `laneSetup` is a `_templateMeta.variables` text entry, default `npm ci`, substituted at template instantiation. Left blank, it renders `setup: ""`, which needs no special case.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| R14 | Agents queuing lanes on a **paused** worktree parent.                                            | Bug [`mcp-queue-mutations-refused-on-paused-worktree-run`](../bugs/implemented/mcp-queue-mutations-refused-on-paused-worktree-run.md): MCP appends were refused on a paused run that keeps its runner lock, which worktree runs do.                                                                                              | **Resolved:** fixed in `ffc623b4f` (2026-11-26), so it no longer gates step 4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R15 | Does `getValidKeysAtPointer` need a change for the root arm?                                     | Partly. Unknown-key warnings use `defs.singleStepRoot` (`PromptFileParser.ts:694`) and pick up the new arm. Suggestion candidates hard-code `type === script ? oneOf[1] : oneOf[0]` (`:684-692`).                                                                                                                                | Replace that ternary with a lookup keyed by step type, so `type: workflow` gets `oneOf[2]`. This corrects the earlier "no change" claim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

---

## Use Cases

- **Queue a workflow to run after one you already started.** This is the first motivating case.
  Right-click a running workflow in the `WorkflowSwitcher` dropdown and choose "Queue workflow to
  run next…", then pick a file. One `subWorkflowStep` is appended to that instance's queue.
- **Run parallel work in isolated worktrees.** This is the second motivating case, and the reason
  parallel single-step sub-workflows ship in v1 rather than later. A user or an orchestrator agent
  (`spec-driven-loop`) queues a `parallel` group where each member is a single-step sub-workflow
  in its own managed worktree. Each member gets its own working tree, index and branch, so it can
  run the full test suite, a repo-wide formatter or `git add -A` without breaking its siblings.
  See [Motivating case: isolated parallel lanes](#motivating-case-isolated-parallel-lanes).
- **Fan out across worktrees, then merge before the next wave.** A `parallel` group of
  sub-workflow steps, each child on its own worktree, joined by a merge-and-fix step on the
  parent's branch. The next wave then branches from the merged result. This is the
  orchestration done by hand for `dev/implemented/EDITOR_INTELLIGENCE_STAGING_PLAN.md`; see
  [Parallel Sub-workflow Steps](#parallel-sub-workflow-steps).
- **Reusable sub-workflows authored ahead of time**: setup, a test-and-fix loop, teardown.
- **Chains of specialized workflows**: implement → test → report, each in its own file with its
  own harness and model.
- **A team library** of workflow building blocks referenced from project workflows.
- **Independently configured runs**: workflow A uses `claude-cli` in a managed worktree; B, queued
  after it, uses `copilot-cli`. Each keeps its own settings.

---

## Motivating case: isolated parallel lanes

### The problem today

`worktree` is a workflow-only property (`workflowOnlyProperties` in the schema), and the
`workflowStep` wrapper rejects it on a step. A workflow therefore has exactly one execution
root, and every member of a `parallel` group shares one working tree and one git index. When the
`spec-driven-loop` orchestrator sees independent work, the `<parallelSteps>` section of
`src/templates/agents/workflow-orchestrator.agent.md` makes it write each member's prompt
defensively:

- name the siblings and the files each one owns;
- stage only explicit paths, never `git add -A` or `git commit -a`, and retry on `index.lock`;
- no `git stash`, `git checkout -- .`, branch switches, repo-wide formatters or `lint --fix`;
- treat test and typecheck failures as possibly a sibling's unfinished work;
- attach `/skill:ctrlyoke-coordination-tools` and claim paths when ownership can overlap.

The template also has to keep its `committed` clean-tree gate off parallel members, because a
member would fail it on a sibling's edits. Each member therefore finishes with no gate of its
own, and the sequential step after the group carries the gate for all of them. The result
is that parallelism only pays off for work that splits cleanly by file. Even then, the members
can't run the project's main quality gate (the test suite) with confidence while they run.

### The fix: one lane = one single-step child run

A sub-workflow child is its own run, so it gets its own execution root. A parallel group whose
members are single-step sub-workflows, each with its own managed worktree, gives every member:

- its **own working tree, index and branch**, branched from the same parent commit (D4c checks
  the parent's tree once for the group);
- the freedom to run `npm test`, `npm run format` or `git add -A` without touching a sibling;
- its own clean-tree gate: the `committed` preset becomes safe on a lane, because the tree it
  checks belongs to that lane alone;
- a recorded branch, tip and merge result (D12a). The merge either happens at settlement
  (`merge: true`, with sibling merges serialized by D4d) or is left to the sequential step after
  the group, which reads every lane's branch from `$step:summary:a-b`.

Written by hand, a lane looks like this. D13 explains the inline form, and the authored-file form
works too:

```yaml
steps:
  - parallel:
      - type: workflow
        name: Lint rules
        workflow:
          worktree: { mode: managed, merge: true, setup: npm ci }
          prompt: Implement the lint rules in @dev/backlog/LINT_PLAN.md. Run `npm test`, then commit.
      - type: workflow
        name: Palette
        workflow:
          worktree: { mode: managed, merge: true, setup: npm ci }
          prompt: Implement the command palette in @dev/backlog/PALETTE_PLAN.md. Run `npm test`, then commit.
    failFast: false
  - name: Integrate
    prompt: Resolve anything reported as unmerged in $step:summary:1-2, run `npm test`, and commit.
```

An orchestrator agent can't author that YAML directly. MCP `append_step` accepts only flat prompt
steps, and agents never supply scripts, so they can't supply a `setup` command either. D14 gives
it the same result by naming an author-defined worktree preset:
`{ prompt, name, worktree: { use: "lane" } }`.

### Why not let steps override `worktree`?

The alternative is to drop the `workflowStep` rule and let a step set its own `worktree`. It was
considered and rejected, because "one workflow run = one execution root" is load-bearing in
places a step-level override would have to unpick:

- **Leases are per run.** `ExecutionRootLeaseManager` leases one execution root per
  `workflowKey`/`runRef`. A step-level worktree would need per-step leases held next to the run's
  lease, with their own conflict and recovery rules.
- **Worktree lifecycle is run state.** `_runtime.worktree` (`WorkingFileWorktreeRuntime`) is one
  root-level record of the run's checkout: provisioning, setup outcome, landing, merge, directory
  and branch state, and orphan recovery. Per-step worktrees would turn it into a collection and
  fan out settlement, recovery and the dashboard's worktree UI.
- **Snapshots, undo and run history assume one root.** Step and group "before/after" snapshots,
  filesystem undo, and the git-outcome data `workflow_status` reports are all taken against the
  run's execution root.
- **Sessions don't move between directories.** Steps resume earlier sessions by default, and some
  harnesses store sessions per working directory. A step in another worktree could not resume its
  predecessor's session, and the failure would be silent. A child run starts its own sessions, so
  the boundary is explicit.
- **The child-run boundary already gives the semantics.** It has its own lease, worktree
  lifecycle, settlement, history row and recovery (D6). Making a single-step child cheap to
  express (D13) and cheap to queue (D14) costs far less than teaching every per-run subsystem
  about per-step roots.

---

## Design Decisions

These were the open or wrong points in the previous draft. Each is settled here with its reasoning.

### D1. Launching the child: a host-agnostic port, not `WorkflowOrchestrator.createWorkflow`

- `WorkflowExecutor` has no orchestrator reference.
- The CLI (`src/cli.ts`) builds exactly one `WorkflowInstance` and has no orchestrator at all.
- `WorkflowInstanceRegistry.createWorkflow(filePath)` (`WorkflowInstanceRegistry.ts:217`)
  returns the _existing_ instance when one for the same file is RUNNING/PAUSING/PAUSED
  (`isExecutionOwnerState`). It also disposes the panel's retired or idle viewed instance and
  steals panel focus. All three behaviours are wrong for a child.

**Decision:** add an optional `subWorkflowHost?: SubWorkflowHost` port to
`WorkflowExecutionContext` (`src/core/WorkflowExecutor.ts:217`). There is one shared
implementation, `SubWorkflowLauncher` in `src/core/orchestration/`, constructed with a
`SubWorkflowInstanceFactory` (`src/types/SubWorkflowTypes.ts`, with the port types). The factory
returns the narrow `SubWorkflowInstance` surface the launcher uses, which `WorkflowInstance`
implements; its options carry `concurrent` and grow as the child needs more (the ancestor chain,
the parent link, the inherited execution root):

- **VS Code and the hosted server:** `() => orchestrator.createExternalWorkflowInstance()`
  (`WorkflowInstanceRegistry.ts:210`, forwarded by `WorkflowOrchestrator.ts:976`). This is the
  same path `CommitMessageGenerator` uses: `extension.ts:1718` hands it to `ScmCommitCommand` as
  `createWorkflowInstance`. The instance is registered and announced to the dashboard, so it gets
  a dropdown row without changes to the dropdown.
- **CLI:** `runCommand` (`src/cli.ts:1010`) builds its one instance at `:1292`, with no
  orchestrator and no dashboard sink. Extract that construction into a helper, so the launcher's
  factory builds sibling instances with the same dependencies. Concurrent children get
  `hostCanProvidePty: false` (R5).

The launcher follows `CommitMessageGenerator`'s pattern: create the instance, load the
definition, `await instance.executeLoadedPromptFile(...)`, then read `promptQueue.getState()` for
the outcome. (The commit generator itself loads a prompt string through `loadPromptStringAsRun`
and gets its instance from `ScmCommitCommand`'s `createWorkflowInstance` factory. The launcher
loads a file through `loadPromptFile`, or an inline definition through `loadFromMemory`; see D13.)
`executeLoadedPromptFile` (`WorkflowInstance.ts:2507`) never throws on startup problems: a failed
preflight calls `failRuntime()` and other startup errors go to `finalizeFailure`, so the state ends
ERROR (R2). The launcher must therefore classify the outcome from queue state, not from "it
returned". The launcher captures the result before the registry retires and disposes the
finished child (`retireWorkflow`, `WorkflowInstanceRegistry.ts:311`).

```typescript
interface SubWorkflowHost {
  launch(request: SubWorkflowLaunchRequest): Promise<SubWorkflowHandle>;
}

interface SubWorkflowLaunchRequest {
  /** A resolved file (D5), or an inline definition already materialized with the parent's defaults (D13). */
  source:
    | { kind: "file"; resolvedPath: string }
    | { kind: "inline"; definition: PromptFile; displayName: string };
  parent: SubWorkflowParentLink;
  /** Parent's execution root + checkout root: inherited when the child has no `worktree` key (D4a),
   *  and used as the source checkout for the child's own worktree (D4b). */
  parentExecution: { executionRoot: string; executionCheckoutRoot: string };
  /** Owner tokens of every blocked ancestor's lease, root first (D4d). */
  delegationChain: readonly string[];
  /** Set when resuming a parent whose step already started a child (D6). */
  resumeChildRun?: { workflowKey: WorkflowKey; runRef: RunRef };
  ancestorPaths: readonly string[];
  /** True for a parallel member; the CLI factory then builds a headless-only child (R5). */
  concurrent: boolean;
}

/** Which parent step started the child. Queue steps have a stable `_runtime.stepId`; the
 *  finalStep does not (step ids are assigned to queue steps only), so a pass is identified by
 *  its phase and 0-based loopIndex. */
type SubWorkflowParentLink = { workflowKey: WorkflowKey; runRef: RunRef } & (
  { phase: "queue"; stepId: string } | { phase: "finalStep"; loopIndex: number }
);

interface SubWorkflowHandle {
  readonly workflowKey: WorkflowKey;
  readonly runRef: RunRef;
  readonly done: Promise<SubWorkflowResult>;
  pause(): Promise<void>;
  cancelPause(): Promise<void>;
  stop(): Promise<void>;
}

interface SubWorkflowResult {
  status: PromptTerminalStatus; // COMPLETED | FAILED | CANCELLED
  /** For CANCELLED: whether the parent requested it via handle.stop(), or the child was stopped directly. */
  cancelledBy?: "parent" | "child";
  /** FAILED before any child step reached RUNNING (preflight, load or validation); only changes the message (R2). */
  failedToStart?: boolean;
  failureMessage?: string;
  /** Projected from the child's `_runtime.worktree`; feeds D4e and the D12 `SubWorkflowOutput` metadata. */
  worktree?: Pick<
    WorkingFileWorktreeRuntime,
    | "mode"
    | "branchName"
    | "baseCommit"
    | "finalBranchTip"
    | "changedFileCount"
    | "landingOutcome"
    | "mergeOutcome"
    | "conflictFiles"
  >;
}
```

The context is assembled in one place, `WorkflowStartupPipeline.buildWorkflowExecutionContext`
(`src/core/orchestration/WorkflowStartupPipeline.ts:500`), from ports `WorkflowInstance`
supplies (`createWorkflowStartupContextPort`, `WorkflowInstance.ts:2174`). The host is passed
to `WorkflowInstance` and threaded through that port, so it is the one place the port gets
plumbed in. A missing host is a configuration error: the step fails with
"Sub-workflow steps are not supported in this host".

### D2. Stop: forward through the step's cancel resource, and propagate up through the outcome

`WorkflowInstance.stop()` (`WorkflowInstance.ts:2786`) cancels each entry in
`activeTargetResources`: it cancels process runners, kills PTY sessions, and collects
integrations. When **no entry has an `integration`** (not only when no entry exists), it falls
back to `getDetectorIntegration()` and waits up to 10 s for it (`:2878`, `:2918`). A step blocked on a child has no integration, PTY, or process runner. So the sub-workflow
step registers a `subWorkflow` handle on its entry, `stop()` calls `handle.stop()` for it, and
the detector fallback runs only when no entry carries an integration **or** a `subWorkflow`
handle. Otherwise stopping a parent blocked on a child would always wait out the 10 s timeout.

- **Parent stopped** → the cancel resource stops the child → the child ends STOPPED → `done`
  resolves CANCELLED → the parent step is CANCELLED → the parent confirms stopped.
  Propagation is recursive, because the child's own sub-workflow step does the same.
- **Child stopped directly** (from its own dropdown row) → `done` resolves CANCELLED → the parent
  step is CANCELLED and the parent stops. A stop is never negotiated through `onFail`.

### D3. Pause: reuse PAUSING ("pause after the current step"); no cross-instance state mirroring

The previous draft mirrored the child's `executionState` onto the parent. That means writing
into another instance's `WorkflowStateMachine` from outside. Resume would also break, because
`WorkflowInstance.resume()` (`:2606`) restarts execution through `startWorkflowExecution` while
the old executor is still awaiting the child, leaving two executors on one run.

ctrlyoke's pause already means "pause at the next step boundary": a long AI step keeps running
while the instance sits in PAUSING. A sub-workflow step is just a long step, so:

- **Pause the parent** → the parent enters PAUSING as usual, and `pause()` is forwarded to the
  active child through the handle. The child pauses at _its_ next step boundary and shows PAUSED
  in its own row. The parent stays PAUSING until the child is resumed: a PAUSED child never
  finishes on its own, so the parent's step stays unsettled (the launcher waits through the
  child's pause, `SubWorkflowInstance.whenExecutionSettled`, round 6).
- **Cancel the pause on the parent** (resume while PAUSING; `WorkflowInstance.cancelPause()`
  already exists) → forwarded to the child: `cancelPause()` while the child is still PAUSING,
  `resume()` once it is PAUSED. The forward must not await the child's remaining run.
- **Pause or resume the child directly** → nothing is propagated to the parent. The parent stays
  RUNNING, and its step row shows the child's live state ("Sub-workflow paused"), so the dashboard
  stays accurate without touching the parent's state machine.

Forwarding is one hook in `WorkflowInstance.pause()`/`cancelPause()`. When the active target is a
sub-workflow step, call the handle as well. No orchestrator-level parent↔child registry is
needed: the handle held by the running step _is_ the downward link. This also works in the CLI,
where there is no registry.

### D4. Worktree rules: the parent's checkout is the child's "source checkout"

A child's own `worktree` setting is always honoured. The parent only decides two things: where
a child with **no** `worktree` key runs, and which checkout a child's worktree **branches from
and merges back into**. Today that second checkout is always the VS Code workspace folder's
checkout. That is wrong once the parent is itself in a worktree, and it is what makes fan-out
and merge-back work.

| Child file's `worktree`           | Where the child runs                    | Branches from                    | `merge: true` merges into |
| --------------------------------- | --------------------------------------- | -------------------------------- | ------------------------- |
| _absent_                          | The parent's execution root (inherited) | —                                | —                         |
| `false`                           | The workspace's main checkout, as today | —                                | —                         |
| `true` / `{ mode: managed, … }`   | A new managed worktree                  | `base`, else the parent's `HEAD` | The parent's checkout     |
| `"branch"` / `{ mode: named, … }` | The named worktree (created or reused)  | `base`, else the parent's `HEAD` | — (named never merges)    |

**D4a. Inheritance (absent key).** "Implement in a worktree, then run a test sub-workflow"
must test the parent's changes, not main. The parent holds a lease on its root (exclusive if
it is a worktree), so the inheriting child needs a **delegated lease** (D4d).

**D4b. Source checkout = the parent's execution checkout.** `SubWorkflowLaunchRequest` carries
the parent's execution checkout root. The child's `WorktreeManager` call uses it as
`sourceCheckoutRoot`, instead of `getStateRoot()` (`WorkflowInstance.ts:1502`, which returns
`this.workspaceFolderPath ?? this.platform.getWorkspaceRoot()`; used as `sourceCheckoutRoot` at
`:5019`). `WorktreeManager` then normalizes it with `repoToplevel` (`requireRepositoryRoot`,
`WorktreeManager.ts:3668`). Keep `getStateRoot()` itself unchanged for the child, because history
stays under the initiating checkout's state root.
That gives:

- `base` defaults to the parent's current `HEAD`;
- `targetBranch` is the parent's branch;
- `merge: true` lands in the parent's checkout.

Nested fan-out recurses: a grandchild branches from and merges into its parent's worktree,
which later merges into the root. Resolve the **worktrees root directory** from the
repository's main checkout, not from the source checkout. Today `resolveWorktreeRootFor`
(`WorktreeManager.ts:625`) passes the source checkout to `resolveWorktreeRoot`
(`src/utils/WorktreeUtils.ts:354`), whose fallback is `<dirname(source)>/<basename(source)>.worktrees`.
Children of a worktree parent would therefore land in a nested `<parent-wt>.worktrees/` folder.
Resolve the main checkout as the parent directory of `git rev-parse --git-common-dir` (already
used by `ExecutionRootScope`), and pass that to `resolveWorktreeRoot`. An explicit `worktrees.root`
setting still wins. A top-level run started in the main checkout resolves the same as today. A
top-level run started in a linked worktree now places new worktrees under the main checkout's
`<main>.worktrees/` too (shipped in round 9, `555dba694`; CHANGELOG **Changed**). A worktree's
ownership record names the checkout it branched from, which for a child is its parent's
worktree, so the record, not the caller, is the source of truth when that run is resumed (see
Progress, round 9 review).

**D4c. Uncommitted parent work before a worktree child starts.** A new worktree branches from
a commit, so uncommitted changes in the parent's checkout would silently be missing from the
child. The most common case is the "merge and fix" step before the next wave. Before
launching any worktree child, or once before a parallel group fans out so every lane shares one
base, check the parent's execution checkout:

- **Clean:** proceed.
- **Parent is a ctrlyoke-managed worktree:** checkpoint-commit with the same deterministic
  message settlement uses (`buildManagedAutoCommitMessage`). ctrlyoke already owns commits on
  that branch.
- **Parent is the main checkout or a named worktree:** this is a start failure → `onFail`, with
  the message "Commit or stash the parent's changes before starting worktree sub-workflows (dirty:
  N files)". ctrlyoke never commits to a checkout the user owns.

**D4d. Leases.** `ExecutionLeaseRequest` and the persisted `ExecutionLease` gain
`delegationChain?: string[]`: the owner tokens of every blocked ancestor, root first.
`isCompatible` (`ExecutionRootLeaseManager.ts:157-165`) today compares only the two modes
(`shared-native`, `exclusive-worktree`) and returns true only for two shared-native leases. It must
instead receive the request and the existing lease, and it additionally allows:

1. An existing lease whose `ownerToken` is in the request's chain. The ancestor is blocked
   waiting on this child.
2. Two delegated leases with the same immediate delegator. These are siblings inheriting one
   root, the same sharing parallel prompt members already have.

A **merge lease** from a child (`mergeManagedWorktree`, `WorktreeManager.ts:1004`; the
source-lease acquire is at `:1034-1042`) carries
the chain too, so the blocked parent's own lease (shared-native on main, or exclusive on a
worktree) no longer turns `merge: true` into `blocked`. Rule 2 deliberately does **not** apply
to merge leases. A merge into a checkout where an inheriting sibling is still editing stays
blocked, and D8's preflight rejects that combination up front.

**Sibling merges wait; they don't block.** Today `mergeManagedWorktree` makes one
`leaseManager.acquire({ mode: "exclusive-worktree", … })` attempt on the source checkout and
turns any conflict into `mergeOutcome: "blocked"`. Two isolated lanes that settle seconds apart,
both with `merge: true`, would leave the later one `blocked` even though nothing is wrong. A merge
lease request that carries a delegation chain therefore **waits**, bounded by a new
`WORKTREE_MERGE_LEASE_WAIT_MS` (120 s; R4), when the only conflicting live lease is another merge
lease with the same immediate delegator. Merge leases are ordinary `exclusive-worktree` leases
today, so `ExecutionLease` also gains an optional `purpose: "merge"` to tell them apart from an
editing lease. `acquire` itself never waits, so the loop lives in `mergeManagedWorktree`. It
catches `ExecutionLeaseConflictError`, checks the conflict against the rule above, and calls its
existing `retry()` with backoff. Any other acquire error still ends `blocked` at once, as today.
Each waiter re-runs the merge guard after acquiring (the code already does this as
`postLeaseGuardFailure`, `:1051-1056`). **As built (round 10):** a lane's settlement
(`completeManagedRun`) already holds the repository-wide worktree mutation lock across landing,
merge and removal, so siblings in fact queue on that lock, whose wait for a chained `merge: true`
settlement is raised from 5 s to the same 120 s; the lease wait guards merges taken outside that
lock. A sibling's merge commit
leaves the target clean and on the right branch, so the later lane merges on top of it. Only a
real git conflict ends `conflict`. A merge lease with no chain (an ordinary top-level managed run)
keeps today's fail-fast behaviour. Both new lease fields (`delegationChain`, `purpose`) are
optional. An older ctrlyoke that ignores them sees an ordinary conflicting lease and fails
closed, so the persisted lease format needs no version bump.

**D4e. Merge results are data, not failures.** `merge: true` can end `fast-forward`,
`merge-commit`, `conflict` (aborted cleanly, with `conflictFiles`), or `blocked`. The child
run's outcome is not changed by these, and neither is the parent step's: a COMPLETED child is a
COMPLETED step. The outcome goes into the step's recorded metadata (D12a), so both `$step:N` and
`$step:summary:N` report it, with a warning badge when
it isn't a clean merge. This fits the merge-and-fix pattern: the parent's next step resolves
whatever didn't merge cleanly.

**Queue-after-running** uses the same table. A file with no `worktree` key queued after a
managed-worktree run continues in that worktree.

**Prerequisite bugs** (both filed while preparing this revision, and both make fan-out
unreliable):

- [`managed-worktree-setup-runs-inside-mutation-lock`](../bugs/implemented/managed-worktree-setup-runs-inside-mutation-lock.md):
  fixed; `setup` runs after the mutation lock is released, so concurrent managed starts no
  longer time out on someone else's setup.
- [`managed-worktree-landing-blocked-when-agent-commits-everything`](../bugs/implemented/managed-worktree-landing-blocked-when-agent-commits-everything.md):
  fixed; forward commits on the recorded branch land and merge normally.

### D5. Path resolution: reuse `PromptFileResolver`; no `.ctrlyoke/workflows/` candidate

The previous draft claimed the resolution order was "same as promptStep" and listed
`.ctrlyoke/workflows/`. That directory is not a candidate today, and ctrlyoke does not own a
durable workflows folder (`src/ui/WorkflowLibraryHandlers.ts:415`). Resolve the `workflow` value with
`PromptFileResolver.resolvePath`. Its candidates (`getCandidates`) are: absolute path, then the
source definition's directory (trusted roots only), then the workspace root or named root, then
`<workspaceRoot>/.ctrlyoke/`, then a candidate resolved against the run's `sourceCheckoutRoot`
(`getSourceRuntimeCandidate`/`getSourceRuntimeFallbackCandidate`). A `./` or `../` path yields
no candidates at all unless `allowWorkflowRelativeReferences` is on. It applies the same
trusted-root filtering (`isCandidateAllowed`). This is a single source with prompt file
references; any future change to the order applies to both. Pass the parent's execution
checkout (D4b) as the resolver's `sourceCheckoutRoot`. Then a child file that so far exists only
on the parent's worktree branch still resolves, instead of missing in the main checkout.

- **Parse time:** check that the file exists the way `validatePromptReference` does
  (`PromptFileParser.ts:963`, which delegates to `PromptFileResolver`), keeping the authored value
  as written.
- **Run time:** resolve to an absolute path again before launch, because the file may have moved.
- **Child loading:** the child file is loaded with the full parse/validate pipeline
  (`loadPromptFile`), so a schema error in the child fails the parent step with the validation
  message.

### D6. Resume and reload: reattach to the recorded child run instead of starting a new one

The `_runtime.childWorkflowKey`/`childRunRef` written on launch is what makes this possible.
When the parent re-executes a sub-workflow step (resume after a stop, or a window reload while
the step was in flight) and those fields are already set:

- **The recorded child run is COMPLETED:** the parent step completes without relaunching. This
  covers a crash between the child finishing and the parent recording it.
- **The recorded child run is STOPPED, ERROR, or interrupted:** continue that run through the
  existing continuation path (`executeContinuationAtRun`, `WorkflowInstance.ts:2435`) instead of
  creating a new lineage.
- **The child run directory is missing** (trashed): launch fresh and overwrite the linkage.

An explicit **re-run** of the parent (a new run seeded from the definition) starts with clean
step `_runtime` and therefore always launches fresh child runs.

### D7. Parent link is persisted on the child run

The child's run `manifest.json` records `parentRun: { workflowKey, runRef, phase, stepId | loopIndex }`
(a queue step by `stepId`, a finalStep pass by `loopIndex`; see `SubWorkflowParentLink` in D1).
It is a new optional field on `WorkflowRunManifest` (`src/types/WorkflowTimelineTypes.ts:103`),
written by `TimelineRecorder.initializeRunAt` (`src/core/orchestration/TimelineRecorder.ts:53`).
The launcher passes it through load options, so it is in the very first manifest write. A run
bundle exported from a child keeps `parentRun`. When the parent isn't in the importing project,
the "Started by" link renders as unavailable instead of failing. This lets:

- the child's dropdown row and run view show "Started by _<parent name>_", with a link back;
- history/search reach the parent from a child run;
- D6 confirm that a recorded child run really belongs to this parent step before reattaching.

This is new and separate from the existing variant/re-run provenance (`sourceWorkflowKey`/
`sourceRunRef` on `PromptFile`, `CtrlYokeTypes.ts:657-659`), which means "derived from", not
"spawned by".

### D8. Where the step is allowed

- **`steps[]`:** yes.
- **`finalStep`:** yes. Each pass launches a fresh child run (D6 reattach applies only within one
  pass). `parentRun.loopIndex` distinguishes the passes in history.
- **Inside a `parallel` group:** **yes, in v1.** Two cases drive this. The first fans out
  several authored workflows onto their own worktrees, joins, then merges on the parent's branch
  before the next wave. The second is
  [isolated parallel lanes](#motivating-case-isolated-parallel-lanes): single-step members, often
  inline (D13) and often queued by an orchestrator agent (D14), each in its own worktree. Lanes
  are why single-step sub-workflows in a group must not be deferred: without them, the only way
  to run parallel work is in one shared tree. See
  [Parallel Sub-workflow Steps](#parallel-sub-workflow-steps) for what this needs.
- **Single-step root** (`singleStepRoot`): **yes**, as a new `rootWorkflowStep` arm alongside
  `rootScriptStep`. A file that holds only `type: workflow` / `workflow: waves/f1.ctrlyoke.yaml`
  is the start of a lazy queue: you run it, then append the next workflows while the first one
  runs. `steps: [ { type: workflow, … } ]` already covers this, but blocking the shorter form
  gains nothing and leaves an odd gap next to root prompts and scripts. As with a root script,
  workflow-only keys at the root (`worktree`, for example) belong to the **parent**; the child's
  worktree still comes from the child file (D4), and nothing else is inherited (D11). The arm
  accepts exactly `rootScriptStep`'s workflow-only keys (`worktree`, `vars`,
  `trustedExternalRoots`, `maxSteps`), not `conditions` or `worktreePresets` (R9).
  `.prompt.md` cannot express this form.

### D9. Outcome mapping and `onFail`

| Child terminal state                                                  | Parent step                                       | Parent workflow                                                                                                                                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| COMPLETED                                                             | COMPLETED                                         | advances                                                                                                                                                                                                 |
| ERROR, failed, or failed to start (missing file, schema error, cycle) | `onFail: stopWorkflow` (default) → FAILED         | stops (`runtime.fail()`)                                                                                                                                                                                 |
|                                                                       | `onFail: continue` → COMPLETED + `failureMessage` | advances                                                                                                                                                                                                 |
| STOPPED (by anyone)                                                   | CANCELLED                                         | stops, regardless of `onFail`. Inside a parallel group, a lane stopped directly lets its siblings finish first; a fail-fast or parent cancel does not wait. See [Parallel](#parallel-sub-workflow-steps) |
| COMPLETED, but `merge: true` ended `conflict`/`blocked`               | COMPLETED + warning (D4e)                         | advances                                                                                                                                                                                                 |

`onFail` uses the existing `ScriptStepAction` type and `CONDITION_ACTIONS` values, and reuses
`scriptStep.onFail`'s schema (`workflow-schema.json:1164-1177`, including its `varPlaceholder`
arm; R10). For `continue`, scripts today record a plain COMPLETED with no warning state, only a
`Log.warn` (`WorkflowExecutor.ts:3421-3424`). The sub-workflow step
does the same, and also sets `failureMessage`. The row renders a warning badge when a COMPLETED
sub-workflow step has a `failureMessage`. No new terminal status is introduced.

There is no `onPass`; a completed child always advances the parent.

### D10. Cycle detection only; no depth limit

`WorkflowExecutionContext.ancestorPaths` holds the resolved absolute paths of every workflow file
in the active chain, root first, compared case-insensitively on Windows. If the resolved child
path is already in the list, the step fails before launch with a message that names the cycle
(`a.ctrlyoke.yaml → b.ctrlyoke.yaml → a.ctrlyoke.yaml`). A long chain with no cycle is just N
sequential instances. Queuing the same file after itself is not a cycle, because the ancestor
chain contains only _active_ parents.

### D11. Variables and harness are not inherited

A **file-referenced** child uses its own `vars` plus host-level `--var` overrides, and its own
`harness`, falling back to settings defaults (not the parent's harness). `{{var}}` substitution
is not applied to the `workflow` path in v1. The path gets no `VAR_SUBSTITUTION_POLICY` entry,
and the schema gives it no `varPlaceholder` arm (R10). Only the execution root is inherited (D4), because
it is about _where_ the code lives, not _how_ the workflow is configured. A file is a reusable
unit that must behave the same whichever workflow references it.

An **inline** child (D13) is different. It is authored inside the parent, and it replaces what
would otherwise have been an ordinary step of the parent. It inherits the parent's workflow-level
execution properties and `vars` exactly as a prompt step would, and its own keys override them.
D13 says how that is materialized.

### D12. Step references mean the same thing for every step kind; `:summary` bounds any of them

> Prompt and script steps already behave this way (see Status). What remains is the **workflow
> arm**: the `SubWorkflowOutput` metadata (`subWorkflowSettled` event), nested child-run rendering, and its summary budget.

A merge step has to know what each lane produced. Today it has no way to find out:

- a step that sends nothing to a harness produces no `$step:N` item, because empty items are
  skipped (`RunOutputResolver.ts:1270` for scripts, `:1312` for prompts);
- `{{worktree.*}}` variables and `CTRLYOKE_WORKTREE_*` environment variables don't exist;
- a managed branch name contains the child's `runRef`, so it can't be written into the parent
  ahead of time;
- cross-run `priorContext: { workflow, run }` needs keys known when the workflow is
  authored.

A previous draft solved this with a "result summary" (metadata plus the child's final response)
as the step's output. That made `$previous` mean a summary after a workflow step and the full
output after any other step, and most workflows' final response is just "committed abc123".
Rejected.

#### D12a. Full output: one meaning for every step kind

`$previous`, `$previous:N`, `$step:…`, `$all`, `$finalStep`, `$allFinalStep`, and every
`priorContext` selector mean the step's **full output**, whatever its kind:

| Step kind | Full output                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Prompt    | Authored prompt + response (unchanged)                                                                                            |
| Script    | Command, stdout, stderr, exit code (unchanged) **plus the verdict**: passed/failed, `expected`, `actual` (from `ScriptVerdict`)   |
| Workflow  | A metadata block, then **every step of the child run**, each rendered by these same rules (recursively for nested workflow steps) |

- **Selection counts parent-level steps.** A workflow step is one step for `$previous`,
  `$previous:3`, and `$step:N`; the child's steps are nested inside it, not counted. `$step:1-3`
  over a three-lane wave yields three workflow entries.
- **The child's steps come from the existing cross-run reader.** The run-address form of
  `priorContext` (`{ workflow, run }`) already imports a whole run through
  `RunOutputResolver.resolveAllPriorContextItems` (`:1435`). The workflow arm calls it with the
  child's manifest, located from `_runtime.childWorkflowKey`/`childRunRef`. Child items are not
  marked `importedRun`, so the summary budget orders them as the workflow step's own content
  (D12b).
- **The metadata is the workflow step's own recorded output.** When the child settles, the step
  writes a `subWorkflowSettled` event (`TIMELINE_EVENT_TYPES.SUB_WORKFLOW_SETTLED`) to the parent's
  timeline. It is the counterpart of `scriptExecutionRecorded` (R3), and its payload is a
  `SubWorkflowOutput`: the resolved path, `childWorkflowKey`, `childRunRef`, and outcome.
  When the child had a worktree, it also holds mode, branch, base, tip, files changed, and the
  merge result (D4e), taken from the child's `_runtime.worktree` (`WorkingFileWorktreeRuntime`,
  `CtrlYokeTypes.ts:714-748`). A workflow step therefore always has output and is never skipped
  by `$previous`. Add the event to `OutputHistoryTimelineAdapter`, `RunOutputResolver`,
  `HistoryRunDocumentBuilder` and `RunBundleReader`, which all switch on event type.
- **Missing child history** (run directory deleted): the metadata renders with a
  `<childRunUnavailable/>` marker instead of child steps. This is not an error.
- **The script verdict** is already rendered for every script step (shipped 2026-10-13).
  `PriorContextItem.subWorkflow?: { output, children }` and its rendering are done (round 3).

```xml
<step index="2" type="workflow" name="f1-location" workflow="waves/f1-location.ctrlyoke.yaml"
      workflowKey="f1-location-2026-10-09T10-12-03" runRef="run-2026-10-09T10-12-03" outcome="completed">
<worktree mode="managed" branch="ctrlyoke/f1-location/run-2026-10-09T10-12-03" base="5a1c460" tip="9f02c1d" filesChanged="14"/>
<merge result="conflict">src/completions/WorkflowLocationTypes.ts</merge>
<step index="1" name="Implement">
<prompt>…</prompt>
<response>…</response>
</step>
<step index="2" type="script" name="Tests">
<command>npm test</command>
<stdout>…</stdout>
<exitCode>0</exitCode>
<verdict outcome="passed" compareSource="exitCode" operator="eq" expected="0" actual="0"/>
</step>
</step>
```

The full output of a large child is large. That is the same trade-off as `$all` today, and the
editor's prior-context preview and token count show it before the run. The `:summary` detail
is the bounded alternative.

#### D12b. Summary detail — shipped; only the workflow arm remains

The grammar (`$<kind>:summary…`), `priorContextDetail`, per-kind caps, "full wins", and the
truncation markers shipped with
[`PRIOR_CONTEXT_DETAIL_PLAN.md`](../implemented/PRIOR_CONTEXT_DETAIL_PLAN.md). What this plan
still adds is the **workflow** row of the summary table:

| Step kind | Summary                                                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow  | Metadata in full; each child step's summary by the existing rules, within the summary budget (`PRIOR_CONTEXT_LIMITS.SUMMARY_BUDGET_BYTES`, 400 KB, applied by `applySummaryBudget`); the earliest steps are omitted whole first |

- **Workflow budget.** Render the metadata and every child step's summary. Feed the child steps
  into the existing `applySummaryBudget` (`HarnessIntegration.ts:314`) as one ordered run of
  positions _inside_ the workflow step, so they share the prompt's one `SUMMARY_BUDGET_BYTES`
  with the parent's own summary steps. There is no second budget. Ordering follows the shipped
  chronology (`5dbca60d7`): an earlier parent step's children are omitted before a later step's,
  and within one child run the earliest steps go first. An omitted child step uses the shipped
  marker (`<step index="3" name="implement" omitted="all" omittedBytes="41213"/>`), not a new one.
  The last summary in the prompt is never omitted. The workflow step's metadata block is never
  omitted, because without it a merge step loses the lane's branch. Nested workflow steps
  flatten into the same ordering, so recursion stays bounded.
- **One renderer per step kind**, dispatched through Phase 0's exhaustive `getStepType` switch
  inside `summarizePriorContextItem`, so a future step kind must define its summary to compile.

The staging-plan merge step therefore says "Merge every branch reported in `$step:summary:1-3`
…". That gives each lane's branch, its merge result, and the tail of each of its step outputs, at
a bounded size. A script merge step that needs fixed branch names should use named worktrees,
whose branch is authored.

#### D12c. Alternatives: pulling child output on demand

Prior context _pushes_ output into the prompt before the step starts. An agent can also _pull_
it while it works, which suits a merge step that only needs to dig into one lane. Neither path
replaces `$previous`/`$step:summary:…`: both need the agent to know to look, cost turns, and give an
author no way to state up front what the step depends on. They are the escape hatch behind the
summary's truncation markers, and they need the D12a metadata (child `workflowKey`/`runRef`) to
find the child run.

- **`ctrlyoke history show` already works, with no change.** It addresses any run in the
  project, with `--limit`/`--json`/`--kind` paging and filters:

  ```sh
  ctrlyoke history show --workflow <childWorkflowKey> --run <childRunRef> --step 2 --tail 4000
  ```

  Managed worktree runs keep the initiating checkout's `stateRoot`, so child runs live in the
  same history as the parent. **Settled (R6):** the CLI does _not_ resolve that state root from
  inside a worktree. It keys the project on the cwd's realpath, so the guide always passes
  `-d <main checkout>`. It requires a shell tool and the CLI on `PATH`.

- **MCP `read_output` needs one addition (done in round 4; `workflow_status` takes the same `run`).** It is scoped to the agent's own attached run
  (`mcp-server.ts`: `resolveRun` → that run's manifest), and `indices` select that
  run's steps. `resolveRun` (`mcp-server.ts:2328`) takes the address from the session
  (`requireRunAddress`), never from the arguments. On a workflow step it would return only the
  metadata. Add an optional `run: { workflowKey, runRef }` argument to `McpReadOutputArguments`
  (`McpToolDefinitions.ts:160`) that redirects the read, with `indices` and the
  existing `cursor`/`limit`/`tail` paging applying to that run unchanged. Only **descendants** of
  the attached run are accepted: walk the target's `parentRun` chain (D7) up to the attached run,
  and reject anything else with a message naming the allowed scope. This keeps `read_output`'s
  "your own workflow" contract while extending it to the children your steps started.
  `workflow_status` gains the same `run` argument so the agent can list a child's steps first.
  The truncation markers name the call directly, for example
  `read_output { run: {…}, indices: [3], tail: 8000 }`.

### D13. Inline single-step definitions

A lane is usually one prompt that needs its own worktree. Making the author, or an agent, write a
separate workflow file for each one is friction. For an agent it is worse: a child file written
into the repo is an untracked file in the parent's checkout. The D4c dirty check then refuses the
fan-out, and the `committed` gate fails the step that wrote it. So `workflow` takes either form:

- **A string:** a path to a workflow file (D5). Unchanged.
- **An object:** an inline **single-step** definition. It is a prompt step or a script step, plus
  an optional `worktree`. It reuses the `promptStep`/`scriptStep` definitions; no new step shape
  is introduced.

Rules for the inline form:

- **Single step only.** The object can't hold `steps`, `finalStep`, `parallel`, or another
  `type: workflow` step. Anything larger, and any nesting, uses a file. That keeps the parent
  file readable and keeps the cycle check (D10) file-based.
- **Workflow-only keys:** only `worktree`. `vars` and `maxSteps` are inherited from the parent.
  `trustedExternalRoots` is the parent's effective set, because external-root approval is keyed to
  a workflow file's identity and an inline child has none. `conditions` aren't needed, because a
  preset is materialized when it is attached. Any other workflow-only key is a schema error.
- **Inheritance (D11):** at launch the child definition is **materialized**. That means the
  parent's workflow-level execution properties (`harness`, `model`, `executionMode`, `agent`,
  `skills`, `mcpServers`, `hooks`, `secrets`, `additionalArgs`, `toolPermissions`, `errorBehavior`,
  and the workflow-level `endCondition`/`preCondition`), plus the parent's _effective_ `vars`
  (after host `--var` overrides), overlaid with the inline step's own keys. The result is
  written as the child's root, so the child's run file is self-contained and never re-reads the
  parent. A lane therefore runs with the same harness, model and permissions an ordinary step in
  that position would.
- **Variable substitution (R10).** The parent never substitutes inside an inline definition: it
  joins `VAR_SUBSTITUTION_EXCLUDED_FIELDS`. The child's own run-start and dispatch passes substitute
  it with the copied vars, so `{{var}}` in an inline prompt resolves exactly as it would in a
  parent step. Materialize from the authored step, not the parent's run-start-resolved copy, so
  nothing is substituted twice.
- **Condition presets.** Authored YAML shares a condition through a YAML anchor (the
  `&committed` pattern in `spec-driven-loop`), which already resolves at parse time. `{ use }` is
  MCP-only and is resolved in `materializeAppendStep` before wrapping (D14). The child therefore
  needs no `conditions`, and an agent attached to a lane can't use the parent's presets. That is
  acceptable in v1, because lane agents implement and don't queue.
- **Sessions and prior context don't cross the boundary.** The inline step is the first step of
  a new run. A numeric `sessionId`, `sessionId: finalStep`, a numeric or relative `priorContext`
  selector, and `$previous`/`$step:`/`$all`/`$finalStep` references in an inline prompt would
  address the child run, where they select nothing. They are therefore a **validation error**
  that names the boundary. An inherited `resumeSession` or relative `priorContext` is dropped
  when the child is materialized. The run-address form, `priorContext: { workflow, run }`, still
  works. Passing the parent's output into a lane is listed under Not In Scope.
- **Loading:** the launcher loads the materialized definition through
  `PromptFileLoader.loadFromMemory` (`PromptFileLoader.ts:130`), the path
  `WorkflowInstance.loadFromTemplate` (`:1702`) uses. It creates the lineage and
  copies root-level properties (including `worktree`) into the child's working file, with no
  `originalFile`, so D6 reattach needs no source file. `loadPromptStringAsRun`
  (`WorkflowInstance.ts:1751`) is unsuitable, because it builds a bare `{ prompt }` file and keeps
  workflow overrides in memory only. `loadFromMemory` currently catches errors, notifies the user
  and returns `undefined`. Split it into a throwing core (`loadFromMemoryOrThrow`) and the
  existing notifying wrapper, so a bad definition is a start failure → `onFail` with the real
  message, with no stray notification.
- **Naming:** the child lineage is named from the step's `name`, else
  `<parent name> · step <N>`.
- **Parse-time validation** runs with the parent file, through the same schema arms. There is no
  D5 file-existence check.
- **Save** writes the inline object back as authored, never the materialized form.

### D14. Agent-queued lanes: `worktreePresets` and `append_step`

MCP `append_step` accepts only flat prompt steps (`MCP_APPEND_QUEUE_ITEM_FLAT_SCHEMA`,
`McpToolDefinitions.ts:324`, with `additionalProperties: false`). It requires `prompt` and has no
`type`/`script` properties, so script steps never validate. `materializeAppendStep`
(`mcp-server.ts:472`) only expands author-defined condition presets. That is deliberate. The
author defines every script, and an agent may only pick a named preset. A worktree carries a
script too: `setup`. A sub-workflow file reference would let an agent run any scripts, hooks or
`additionalArgs` it had written into a file. So MCP never accepts `type: workflow` with a path or
an arbitrary inline object. Instead:

- **`worktreePresets`** is a new root property in `workflowOnlyProperties`, with the same pattern
  as `conditions`: a map from name to a worktree definition the author owns. In v1 a preset can
  only be the managed object form (`{ mode: managed, merge?, keep?, base?, setup? }`). Every use
  creates a fresh branch, so lanes in one group can never collide on a named branch. Agents can
  name a preset but never supply or override its fields. `setup`, like condition scripts, runs
  only as the author wrote it.
- **Lookup** follows the condition-preset resolver. Put a `McpWorktreePresetResolver.ts` beside
  `src/utils/McpConditionPresetResolver.ts`, sharing its own-property lookup
  (`getDeclaredConditionPreset`'s `Object.hasOwn`, from `425793e02`) and its list formatter through
  one generic helper, so `use: "toString"` can't resolve to a prototype member here either.
- **`append_step` items** gain an optional `worktree: { use: "<preset>" }`, both flat and as
  `parallel` members. `materializeAppendStep` builds the prompt step as it does today, then wraps
  it into `{ type: workflow, name, workflow: { …promptStepFields, worktree: <preset copy> } }`.
  The preset is copied by value at append time, as condition presets are, so later edits to the
  preset don't change queued lanes. The wrapped step then follows D13.
- **Errors:** an unknown preset is rejected with the list of available names. A workflow with no
  `worktreePresets` rejects `worktree` with "This workflow defines no worktree presets, so steps
  can't be queued in their own worktree". Creating worktrees and branches stays the author's
  opt-in. A lane whose preset has `merge: true` can't join a running prompt or script step
  through `parallelWithCurrent`, because that step is editing the tree the lane would merge into.
  `appendStepsToActiveParallelGroup` rejects it with the `MERGE_INTO_SHARED_ROOT` message.
  Without `merge`, the join is allowed.
- **`validateStepHarnessAndModelCapabilities`** checks the wrapped step's effective harness and
  model, which is the same answer as for an unwrapped step, because D13 inherits the same
  defaults.
- **`workflow_status`** lists lane steps as `type: workflow` with their child
  `workflowKey`/`runRef`, live child status, and the D12a worktree metadata. Its `metadata`
  (`mcp-server.ts:1385-1405`) already reports `conditionPresets` (`summarizeMcpConditionPresets`,
  `b318c17f5`). It gains a sibling, `worktreePresets: [{ name, merge, setup }]`, where `setup` is
  the first-line preview, as for condition scripts. An empty list means lanes are unavailable.
- **Ungated lanes warn.** `formatUngatedAppendedStepsWarning` already warns when an appended
  sequential step has no end condition while presets exist. Extend it to lanes: warn when a lane
  carries no `endCondition` while a condition preset exists. The guidance says lanes **should**
  carry `committed`.
  `read_output` on a lane's index returns the D12a output. D12c's `run` argument reaches into
  the child run.
- **`edit_step`** on a pending lane edits the wrapped prompt fields, and accepts
  `worktree: { use }` to switch presets. Clearing `worktree` unwraps the lane back into a plain
  prompt step, and setting it on a pending prompt step wraps it. `remove_step` and
  `reorder_steps` are unchanged. A lane is recognized by shape (`agentLaneParts`: an inline
  prompt step with a managed worktree object and no `onFail`), so an authored step of that exact
  shape is editable too; every other workflow step is refused. The merge-lane join refusal
  applies to any edit that makes a pending member of the running group a `merge: true` lane.

The orchestrator guidance (`workflow-orchestrator.agent.md`, `<parallelSteps>`) and the
`spec-driven-loop` template change with this:

- **Agent:** when `workflow_status` lists a worktree preset, queue parallel members as lanes. A
  lane may run the full gate, needs no sibling-ownership rules or coordination tools, and
  **should** carry `endCondition: { use: "committed" }`. Set `failFast: false` for long lanes.
  Queue a sequential integration step after the group that resolves any lane reported as
  `conflict`/`blocked`, then runs the gate on the combined result. The current shared-tree rules
  stay, scoped to members queued without a preset.
- **Template:** `spec-driven-loop` declares
  `worktreePresets: { lane: { mode: managed, merge: true, setup: "{laneSetup}" } }` with a new
  `laneSetup` text entry in `_templateMeta.variables` (the template has no root `vars`; R13).
  It defaults to `npm ci` and is described as "Installs dependencies in each parallel lane's
  fresh worktree; leave blank if none are needed". As built, a blank uses the default (Decisions, round 11),
  so the description tells the author to set the created workflow's `setup: ""` instead. The comment above `conditions:`
  (`spec-driven-loop.ctrlyoke.yaml:109-113`), which says the gate isn't workflow-level because
  parallel steps share one tree, changes to say that applies only to shared-tree parallel members.
  `large-spec-loop` is unchanged in v1 (R12).

---

## Phase 0 — Prerequisite: make step-kind branching exhaustive

> **Done in round 1** (`d1b4765a1`, `1b40f353f`, `5f3a93d27`, `af172c7a2`). `getStepType`,
> `isPromptStep` and `assertNever` live in `CtrlYokeTypes.ts`; `StepKindBranchGuard.test.ts` is
> the guard. Note for the new kind: the guard flags only ternaries and `if`/`else` pairs, so
> early-return checks (`if (isScriptStep(s)) return …;` followed by prompt-only code) and
> negative checks (`!isScriptStep(s)`, `step as PromptStep` casts) are **not** compiler-guided.
> Adding `STEP_TYPES.WORKFLOW` must sweep those by hand. The text below is the original brief.

About 62 non-test files (counted 2026-11-26, about 204 sites) branch on `isScriptStep(...)` /
`STEP_TYPES.SCRIPT` with an implicit "otherwise it's a prompt". The heaviest are
`PromptQueue.ts` (13), `editorStore.ts` (12), `mcp-server.ts` and `PromptFileParser.ts` (10 each),
`WorkflowStepSanitizer.ts` and `ExecutionPreviewService.ts` (9 each), `FinalStepFooter.tsx` (8),
and `stepContextMenuItems.ts`, `StepChipRail.tsx`, `WorkflowInstance.ts`, `WorkflowExecutor.ts`
and `CliPropertyOverrides.ts` (7 each). Since `eba32a7db`, nearly every check names
`isScriptStep`. The remaining direct `step.type === STEP_TYPES.SCRIPT` guards count too, for
example `RunContinuationService.assertStepHasRequiredContent` (`:1498`). Adding a third kind to
the `WorkflowStep` union would compile cleanly and silently treat sub-workflow steps as prompts in
every one of those places.

Before adding the new step kind:

1. Add `getStepType(step): WorkflowStepType` and an `isPromptStep` guard to `CtrlYokeTypes.ts`,
   next to `isScriptStep` (`:1120`, generic over `Extract<T, { type: SCRIPT }>`; keep that shape
   for `isPromptStep`). Neither exists yet. `USER_INPUT_STEP_PLAN.md:6` already names this as its
   dependency.
2. Convert each binary `isScriptStep ? … : …` branch that reads kind-specific fields into an
   exhaustive `switch (getStepType(step))` with an `assertNever` default, or into `isPromptStep`
   where only prompt fields matter.
3. This lands on its own, with no behaviour change, and makes adding the new kind a
   compiler-guided change. `USER_INPUT_STEP_PLAN.md` adds a fourth step kind and benefits from
   the same refactor; whichever plan lands second only adds `case` arms.
4. Add a `scripts/` check, or a unit test like `VarSubstitutionPolicy.test.ts`, that fails on a
   new bare `isScriptStep(x) ? … : …` ternary over a `WorkflowStep` outside an allow-list. Without
   it, the next feature quietly reintroduces the binary pattern. Use the allow-list for sites
   that really are script-vs-everything, for example "does this step run a shell command".

---

## Schema Design (`schemas/workflow-schema.json`)

Definitions live under **`$defs`** (draft 2020-12). Step definitions do not set
`additionalProperties`; strictness comes from the `workflowStep` wrapper's
`unevaluatedProperties: false` (`:953`), and the new definition follows that pattern. The wrapper
(`:921-954`) is `allOf[ oneOf[promptStep, scriptStep], not worktree, not trustedExternalRoots,
not maxSteps ]`; the new arm goes in that inner `oneOf` (R8).

### Extract a shared step-lifecycle runtime definition

`promptRuntimeMetadata` (`:1594-1677`) mixes execution-property echoes with lifecycle fields the
queue relies on (`stepId` for `claimStepById`, `startedAt`, `completedAt`, `terminalStatus`,
`elapsed`, `failureMessage`, `terminalFailure`). Extract the lifecycle fields into
`stepLifecycleRuntime`, and have `promptRuntimeMetadata` `allOf` it. Script steps keep reusing
`promptRuntimeMetadata`.

### `subWorkflowStep`

The display properties (`name`, `enabled`, `color`) are declared inline in `promptStep`
(`:1022-1043`) and again in `scriptStep` (`:1072-1093`); `rootScriptStep` `$ref`s the
`scriptStep` copies. Extract them into a `stepDisplayProperties` def that all
three step definitions `allOf`. This removes the duplication and keeps the new step from adding
a third copy.

```json
"subWorkflowStep": {
  "type": "object",
  "description": "Runs another ctrlyoke workflow file to completion as its own child run, with its own lineage, run history, and dashboard entry. The child keeps its own harness, vars, and finalStep. If the child file has no worktree key, it runs in the parent's execution root; otherwise its worktree setting is honoured. The parent step waits until the child run ends.",
  "allOf": [{ "$ref": "#/$defs/stepDisplayProperties" }],
  "properties": {
    "type": { "type": "string", "const": "workflow", "description": "Marks this step as a sub-workflow step." },
    "workflow": {
      "description": "The workflow to run: a path to a workflow file, or an inline single-step definition (a prompt or script step plus an optional worktree). A path is resolved like a prompt file reference. An inline definition inherits this workflow's execution settings and vars, as an ordinary step would; a file inherits nothing.",
      "oneOf": [
        { "type": "string", "minLength": 1 },
        { "$ref": "#/$defs/inlineSubWorkflowDefinition" }
      ]
    },
    "onFail": {
      "$comment": "Same shape as scriptStep.onFail (enum or varPlaceholder); extract it as a shared stepOnFail def rather than copying (R10).",
      "$ref": "#/$defs/stepOnFail",
      "description": "What to do when the child run fails or cannot start. 'stopWorkflow' fails this step and stops the parent; 'continue' records the failure on the step and advances. A stopped child always stops the parent."
    },
    "_runtime": { "$ref": "#/$defs/subWorkflowRuntimeMetadata" }
  },
  "required": ["type", "workflow"]
}
```

### `subWorkflowRuntimeMetadata`

```json
"subWorkflowRuntimeMetadata": {
  "type": "object",
  "description": "Runtime linkage to the child run this step started (added automatically during execution).",
  "allOf": [
    { "$ref": "#/$defs/stepLifecycleRuntime" },
    {
      "properties": {
        "childWorkflowKey": { "type": "string", "description": "Lineage key of the child run." },
        "childRunRef": { "type": "string", "description": "Run reference of the child run; used to open it and to reattach on resume." },
        "resolvedWorkflowPath": { "type": "string", "description": "Absolute path the workflow reference resolved to when the child launched." }
      }
    }
  ],
  "unevaluatedProperties": false
}
```

### Wiring

- `workflowStep`'s inner `oneOf` gains `{ "$ref": "#/$defs/subWorkflowStep" }`. `steps[]` and
  `finalStep` both reference `workflowStep`, so both accept it.
- `parallelGroupItem.parallel.items` already references `workflowStep`, so groups accept the
  new kind with no structural change. Update its description: "members share the workspace
  and worktree" now applies only to prompt and script members, and to sub-workflow members
  whose file or inline definition has no `worktree` key (D4). Add one sentence pointing to lanes:
  "To give a member its own working tree, make it a `type: workflow` step with an inline
  `worktree`."
- `singleStepRoot` (`:496-552`) gains a third arm, `rootWorkflowStep`, mirroring
  `rootScriptStep` (`:553-642`). `rootScriptStep` has its own `unevaluatedProperties: false` and
  lists `worktree`, `vars`, `trustedExternalRoots` and `maxSteps` explicitly, so the new arm lists
  the same four keys and accepts neither `conditions` nor `worktreePresets` (D8, R9).
- **`inlineSubWorkflowDefinition`** (D13): `oneOf` the `promptStep` and `scriptStep` arms, each
  `allOf`'d with `{ properties: { worktree: { $ref: "#/$defs/worktreeConfig" } } }` and
  `unevaluatedProperties: false`. A `type: workflow` value, `steps`, `finalStep`, `parallel`, and
  every other workflow-only key are rejected. The D13 rule against cross-boundary session and
  prior-context references can't be expressed in JSON Schema, so it is a parser validation.
- **`worktreePresets`** (D14) joins `workflowOnlyProperties` (`:443-495`). It is an object whose
  keys follow the `conditions` key pattern (`^[A-Za-z][A-Za-z0-9_-]*$`, `:470-472`) and whose
  values `$ref` the managed object arm of `worktreeConfig` (`:370-398`). Split that arm out as
  `managedWorktreeConfig` so the preset and `worktreeConfig` share it. It is valid at the root of
  a `steps` workflow and is ignored by everything except MCP materialization (D14).
- **Var-substitution policy (R10):** add `worktreePresets` and every inline `workflow` location
  to `VAR_SUBSTITUTION_EXCLUDED_FIELDS`. `VarSubstitutionPolicy.test.ts` fails until they are
  listed, because `promptStep`/`scriptStep` fields accept placeholders inside the inline arm.
- (`priorContextDetail` already exists in `executionProperties`; no change.)
- The root `allOf`/`if not _templateMeta` block (`:13-103`) only constrains `harness` and
  `_runtime.harness`, so it doesn't reject the new kind and needs no change (R8).
- After editing, run `npm run schema:update`. This regenerates the YAML schema,
  `SchemaDescriptions.ts`, `WorkflowSchemaOutline.ts`, and the reference docs. The change is
  additive, so no `schema:bump` is needed.

---

## Type System (`src/types/`)

```typescript
// DashboardConstants.ts — STEP_TYPES (:4526)
export const STEP_TYPES = {
  PROMPT: "prompt",
  SCRIPT: "script",
  WORKFLOW: "workflow",
} as const;
// PREVIEW_STEP_TYPES (:2065) is a separate dry-run copy; it gains WORKFLOW too (R11).

// PROMPT_PROPERTIES (:4791) gains:
WORKFLOW_REF: "workflow",
// ON_FAIL already exists; reuse it.

// New: SUB_WORKFLOW_STEP_COPY_FIELDS (NAME, ENABLED, COLOR, WORKFLOW_REF, ON_FAIL), the parser's
// copy whitelist, alongside SCRIPT_STEP_COPY_FIELDS (:4913).

// New (R4): WORKTREE_MERGE_LEASE_WAIT_MS = 120_000.
// New (D8/D4c): PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES (:1583) gains WORKTREE_COLLISION,
// MERGE_INTO_SHARED_ROOT.

// WorkflowTimelineTypes.ts — TIMELINE_EVENT_TYPES (:43) gains (R3):
SUB_WORKFLOW_SETTLED: "subWorkflowSettled",

// D12 constants (PRIOR_CONTEXT_DETAILS, PRIOR_CONTEXT_SUMMARY_SEGMENT,
// PRIOR_CONTEXT_LIMITS incl. SUMMARY_BUDGET_BYTES, PROMPT_PROPERTIES.PRIOR_CONTEXT_DETAIL)
// already exist.
```

```typescript
// CtrlYokeTypes.ts
export interface SubWorkflowStep extends StepDisplayProperties {
  type: typeof STEP_TYPES.WORKFLOW;
  workflow: string | InlineSubWorkflowDefinition; // D13
  onFail?: ScriptStepAction; // continue | stopWorkflow
  _runtime?: SubWorkflowRuntimeMetadata;
}

export interface StepLifecycleRuntime {
  stepId?: string;
  startedAt?: number;
  completedAt?: number;
  terminalStatus?: PromptTerminalStatus;
  elapsed?: number;
  failureMessage?: string;
  failureKind?: FailureKind; // moved here in round 2: PromptQueue writes it on every kind
  rewoundFailure?: boolean; // likewise; schema $defs/stepLifecycleRuntime matches
  terminalFailure?: boolean;
}

export interface SubWorkflowRuntimeMetadata extends StepLifecycleRuntime {
  childWorkflowKey?: WorkflowKey;
  childRunRef?: RunRef;
  resolvedWorkflowPath?: string;
}

export type WorkflowStep = PromptStep | ScriptStep | SubWorkflowStep; // (:1106)

export function isSubWorkflowStep(step: WorkflowStep): step is SubWorkflowStep {
  return step.type === STEP_TYPES.WORKFLOW;
}

// D13: a prompt or script step plus an optional worktree. Never another SubWorkflowStep.
export type InlineSubWorkflowDefinition = (PromptStep | ScriptStep) & {
  worktree?: WorktreeConfig;
};

// D14: author-owned presets; only the managed object form. WorktreeObjectConfig
// (= Extract<WorktreeConfig, { mode: string }>, CtrlYokeTypes.ts:270) already exists.
export type ManagedWorktreeConfig = Extract<
  WorktreeObjectConfig,
  { mode: typeof WORKTREE_MODES.MANAGED }
>;
export type WorktreePresets = Record<string, ManagedWorktreeConfig>;
```

`resolvedWorkflowPath` stays unset for an inline child. Its `_runtime` still records
`childWorkflowKey`/`childRunRef`, which is all D6 needs. `PromptFile` (the workflow root type)
gains `worktreePresets?: WorktreePresets`.

`PromptRuntimeMetadata` (`:1201`, today `extends ExecutionProperties`) also extends
`StepLifecycleRuntime`, matching the schema extraction. `SubWorkflowOutput` (the D12a metadata:
resolved path, child keys, outcome, and the `SubWorkflowResult.worktree` projection) sits next to
`ScriptRuntimeOutput` (`:1145`). It is the payload of the `subWorkflowSettled` timeline event (R3).
`WorkflowRunManifest` (`WorkflowTimelineTypes.ts:103`) gains `parentRun?: SubWorkflowParentLink`
(D7).
`WorkflowExecutionContext` gains `subWorkflowHost?` (D1) and `ancestorPaths?: readonly string[]`
(D10).

---

## Parser (`src/core/PromptFileParser.ts`)

- `normalizePromptFile` (`:1030`): the `steps[]` loop (script → `buildScriptStep` at `:1098`,
  else `validatePromptReference` + `buildPromptStep` at `:1103-1107`) and the `finalStep` branch
  (`:1149-1163`) gain a `STEP_TYPES.WORKFLOW` arm that calls a new `buildSubWorkflowStep`, which
  copies `SUB_WORKFLOW_STEP_COPY_FIELDS`. The `finalStep` branch has no `else` and drops anything
  that is neither script nor prompt, so it needs the arm explicitly.
- The parallel-member path (`:1236`): `isPromptOrScriptSource` (`:1246-1257`) becomes
  `isParallelMemberSource` and accepts `type: workflow`. Members go through
  `buildSubWorkflowStep`. Other step kinds (e.g. `USER_INPUT_STEP_PLAN.md`'s `userInput`) are
  still rejected (`promptFileParser.test.ts:604-617`), following `dev/implemented/PARALLEL_STEPS_PLAN.md:53-56`'s
  explicit-opt-in rule.
- `validateWorkflowSteps` (`:1436`): a sub-workflow branch next to the script early return
  (`:1486-1491`), before the `!item.prompt` check (`:1494`). For a string `workflow`, it requires a non-empty value and runs the file-existence
  check from D5. For an inline object (D13), it validates the inner step with the existing
  prompt/script rules. It then rejects numeric/`finalStep` `sessionId` values, numeric or relative
  `priorContext` selectors, and `$previous`/`$step:`/`$all`/`$finalStep` references in the inner
  prompt, with a message naming the run boundary.
- `buildSubWorkflowStep` keeps an inline object as authored. Materializing it (D13) happens only
  at launch, so Save round-trips the authored form.
- Step-reference shift reporting (`StepReferenceShifts.ts`; it reports, never rewrites) and the completions that offer step
  numbers skip the inside of an inline definition, because its references could only ever address
  the child run.
- The root `type: "script"` single-step branch (`:1034-1043`) gets a sibling for root
  `type: "workflow"`, which builds a one-step queue through `buildSubWorkflowStep` (D8). It must
  come before the single-prompt branch (`:1046`).
- `getValidKeysAtPointer` (`:669`): unknown-key warnings use `defs.singleStepRoot` (`:694`) and
  pick up the new arm with no change. The `suggestionCandidatesOnly` path hard-codes
  `type === script ? oneOf[1] : oneOf[0]` (`:684-692`). Replace it with a step-type → arm lookup,
  so a root `type: workflow` suggests the workflow keys (R15).

---

## Execution Architecture

### Dispatch

`executeTargetContract` (`WorkflowExecutor.ts:2339`) currently routes disabled steps to
`handleSkippedStep` (`:2372`), script steps to
`executeScriptStep(authoredStep, viewIndex, context, target)` (`:2383`), and everything else into
the inline AI attempt loop. After Phase 0 this is a `switch (getStepType(step))` with a new
`executeSubWorkflowStep(authoredStep, viewIndex, context, target)` arm. `authoredStep` is the
run-start-resolved step. For an inline `workflow` it is still the authored object, because R10
excludes it from substitution. `viewIndex` is -1 for the final step (`:2350`), and the new arm
follows the same convention.

Parallel members reach the same `executeTargetContract` through `ParallelGroupRun.runMember` →
`executeWithSnapshot` → `executeTarget`, so the dispatch arm serves both paths. What the
group itself needs is in [Parallel Sub-workflow Steps](#parallel-sub-workflow-steps).

### `executeSubWorkflowStep`

1. `context.dashboardProvider.updateStepStatus(..., RUNNING)`, guarded by `stepIndex >= 0`, the
   same call script steps make (`:3177`).
2. For a string `workflow`, resolve the reference (D5). If it is missing or unresolvable, it is
   a start failure → `onFail`. For an inline object, materialize it with the parent's resolved
   workflow-level defaults (D13). The parent's working file is already loaded in the context, so
   this is a pure function, shared with the editor preview.
3. Cycle check against `context.ancestorPaths` (D10), for files only. A cycle is a start failure
   → `onFail`. An inline child can't contain a workflow step, so it can't close a cycle.
4. If `_runtime.childRunRef` is set, follow D6 (complete immediately, reattach, or launch fresh).
5. Otherwise call `context.subWorkflowHost.launch({ source, parent, parentExecution, delegationChain, ancestorPaths })`,
   appending `resolvedPath` to `ancestorPaths` for a file source.
   For a sequential step, run the D4c dirty check first. For parallel members, group preflight
   has already run it once.
6. As soon as the handle exists, persist `childWorkflowKey`, `childRunRef`, and
   `resolvedWorkflowPath` to the step's `_runtime`. This lights up the dashboard link and makes
   D6 work if the host dies mid-step.
7. Store the handle on the target's `ActiveTargetResources` entry (`WorkflowInstance.ts:272`,
   today `target`, `attemptIndex?`, `integration?`, `processRunner?`, `ptySessionId?`) in a new
   `subWorkflow?: SubWorkflowHandle` field. The entry is keyed per target (`queue:<i>` /
   `final:<n>`), so a parallel group holds one entry per child. Extend `cancelTarget` (`:1082`),
   `releaseTargetResources` (`:997`) and `stop()` (`:2786`) to call `handle.stop()`, which is what
   D2 needs. Extend `pause()` (`:2584`) and `cancelPause()` (`:2595`) to forward to every live
   `subWorkflow` handle (D3). The handle reaches the instance through the existing
   `registerActiveTarget` context callback, so the executor still holds no instance reference.
8. `await handle.done`, then map the result using D9. Record the D12a `SubWorkflowOutput` as a
   `subWorkflowSettled` timeline event. Record the outcome exactly as `executeScriptStep` does:
   `promptQueue.cancelStep` on abort (`:3383`), `promptQueue.failStep` on a stopping failure
   (`:3482`), and on success no queue call at all, because the coordinator commits the target
   outcome. Use the same `runtime.completeAttempt`/`failAttempt`, `recordAttemptTerminal` and
   `persistRuntimeMetadata`. Then `commitSequentialOutcome` (`:1986`), the final-step loop and
   `ParallelGroupRun` need no sub-workflow knowledge beyond what the parallel section lists. Factor
   the shared tail out of `executeScriptStep` (a `settleNonHarnessStep` helper) instead of copying
   it.
9. Always clear the `subWorkflow` field in `finally`.

### `SubWorkflowLauncher.launch` (`src/core/orchestration/SubWorkflowLauncher.ts`)

1. `createInstance()` from the host factory (D1).
2. Load the file through the normal file path (`instance.loadPromptFile(resolvedPath)`). For an
   inline definition, load it through the throwing `loadFromMemory` variant (D13). For reattach,
   use the run-continuation path. Pass the parent link (D7), the ancestor chain, and any
   inherited execution root (D4) through `loadPromptFile`/execution options. Do not use
   post-hoc setters.
3. Start `instance.executeLoadedPromptFile()` without awaiting it. Wrap it into `done`, which
   reads `promptQueue.getState().status` after settlement and maps COMPLETED / STOPPED / ERROR to
   `SubWorkflowResult`. Startup failures also end ERROR (R2). `failedToStart` is set when no child
   step reached RUNNING. A load that throws before `executeLoadedPromptFile` (missing file,
   validation error, a bad inline definition) settles `done` FAILED with `failedToStart: true`
   directly, without awaiting execution.
4. Return the handle once `workflowKey`/`runRef` are known (after load).

### Final-step interaction

A sub-workflow `finalStep` runs inside the outer final-step loop like any other final step.
Appending a sub-workflow step to a running instance (see Queuing below) grows the in-memory
queue, which the loop-back check (`:796-824`) already sees. External on-disk appends (MCP,
a future `ctrlyoke step add`) are also seen now: the loop merges the run file under lock before
the check (`mergeDiskStepsUnderLock`, fixed in `234708f1e`;
`dev/bugs/implemented/final-step-loop-decision-misses-unmerged-external-appends.md`).

### Prior-context resolution (D12)

Parsing, merging (per-index detail, full wins), the per-kind summarizer, and renumbering of
`:summary` tokens already exist. Only the workflow arm is new:

- **Resolving.** `resolvePriorContextItems` (`src/core/orchestration/RunOutputResolver.ts`)
  gains a third item arm after Phase 0's switch. A workflow step's value carries the
  `subWorkflowSettled` event; its children come from `resolveAllPriorContextItems` (also used by
  `AddressedPriorContextResolver.ts` for cross-run `priorContext`) on the child manifest,
  recursively for nested workflow steps.
- **Rendering.** `buildPriorContextXmlFromItems` (`HarnessIntegration.ts`) stays the single
  renderer for live injection and the editor preview (`PriorContextPreviewBuilder.ts`).
  `summarizePriorContextItem` (`:110`) gains the workflow arm; its children go through the
  existing `applySummaryBudget` (`:314`, `SUMMARY_BUDGET_BYTES`) in the shared chronological order
  (D12b). `PriorContextItem` (`HarnessIntegration.ts:70`, which already has `scriptVerdict` and
  `importedRun`) gains `subWorkflow?: { output: SubWorkflowOutput; children?: PriorContextItem[] }`.
  `children` is absent when the child run is unavailable. The preview builder lives at
  `src/utils/PriorContextPreviewBuilder.ts`.

---

## Parallel Sub-workflow Steps

The target pattern is the one run by hand for `dev/implemented/EDITOR_INTELLIGENCE_STAGING_PLAN.md`:

1. A wave of independent workflows, each on its own worktree.
2. A join.
3. A "merge and fix" step on the parent's branch.
4. The next wave, branching from the merged result.

As one authored workflow:

```yaml
# editor-intelligence.ctrlyoke.yaml (parent runs on the main checkout)
name: editor-intelligence
worktree: false
steps:
  - parallel: # wave 1
      - { type: workflow, workflow: waves/f1-location.ctrlyoke.yaml } # each child file: worktree: { mode: managed }
      - { type: workflow, workflow: waves/d1-lint-rules.ctrlyoke.yaml }
      - { type: workflow, workflow: waves/m1-palette.ctrlyoke.yaml }
    failFast: false # one lane failing should not kill hours of work in the others
  - name: Merge wave 1 and fix
    prompt: |
      Merge every branch reported in $step:summary:1-3 into the current branch, resolve conflicts,
      run `npm test`, fix failures, and commit the result.
  - parallel: # wave 2 branches from the merge step's commit (D4b/D4c)
      - { type: workflow, workflow: waves/f3-completions.ctrlyoke.yaml }
      - { type: workflow, workflow: waves/d2-diagnostics.ctrlyoke.yaml }
    failFast: false
  - name: Merge wave 2 and fix
    prompt: Merge every branch reported in $step:summary:5-6 into the current branch, …
```

A lane can instead use `merge: true` in its own file to auto-merge at settlement. Conflicts are
then reported in the step's metadata (D4e/D12a) and left for the merge step. Auto-merge suits lanes that
rarely conflict; leaving the merge to the AI step suits overlapping lanes.

### Isolated lanes (single-step members)

The [isolated-lanes case](#motivating-case-isolated-parallel-lanes) is the same machinery with
single-step members, usually inline (D13) or queued by an agent (D14). The two differ in what
gets reused:

- **Authored waves** reference reusable multi-step files whose configuration is their own (D11).
- **Lanes** are one-off steps that would have been ordinary members of a shared-tree group. They
  inherit the parent's defaults (D13), so swapping a shared-tree member for a lane changes only
  _where_ it runs.

A lane-only parent on the main checkout needs a strict subset of this section: P1–P3, P5 (only
D4d rule 1 for the merge lease), P6, P9, and P11–P15. P4 isn't needed because the parent's
checkout already is the workspace checkout. P10 isn't needed because lanes don't inherit the
root. That subset is landing step 3 below.

### What currently prevents this, and the fix for each

| #   | Blocker today                                                                                                                                                                                         | Fix in this plan                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | The parser only accepts prompt and script members (`isPromptOrScriptSource`, `PromptFileParser.ts:1246-1257`); the plan previously excluded the kind on purpose                                       | Accept `type: workflow` members (Parser section). The schema already references `workflowStep`.                                               |
| P2  | `ActiveTargetResources` has no slot for a child, so fail-fast's `cancelRunning` → `cancelTarget` (`ParallelGroupRun.ts:664`, `WorkflowInstance.ts:1082`) and `stop()` could not reach a running child | `subWorkflow` handle field per target (Execution step 7)                                                                                      |
| P3  | Group preflight assumes a harness member: `checkHarnessReady` (`ParallelGroupPreflight.ts:359`), `ensureIsolatedIntegration` (`:371`), session-collision checks (`:332`)                              | Sub-workflow members skip those checks, as script members already skip harness and session checks. They get their own checks instead (below). |
| P4  | Every child resolves its worktree base from, and merges into, the VS Code workspace checkout (`getStateRoot()`), not the parent's checkout                                                            | D4b source-checkout override                                                                                                                  |
| P5  | `merge: true` into a checkout where the parent holds a lease is refused as `blocked` (`WorktreeManager.ts:1043-1047`); the parent always holds one                                                    | D4d delegated merge lease                                                                                                                     |
| P6  | Wave N+1 branches from `HEAD`, so uncommitted fixes from the merge step are silently missing                                                                                                          | D4c dirty-parent check before fan-out                                                                                                         |
| P7  | Concurrent managed starts with a slow `setup` fail with a lock timeout, or take over the 30 s-stale mutation lock                                                                                     | Fixed; managed `setup` runs outside the mutation lock                                                                                         |
| P8  | A child whose agent commits its own work never lands or merges                                                                                                                                        | Fixed; managed settlement accepts forward commits on the recorded branch                                                                      |
| P9  | The merge step has no way to learn each lane's branch                                                                                                                                                 | D12: the step's output carries the branch metadata; `$step:summary:a-b` reads every lane at a bounded size                                    |
| P10 | Several children inheriting one exclusive worktree root would conflict on their leases (round 12: never true; inheriting children take shared-native leases, which coexist)                           | D4d sibling-delegation rule                                                                                                                   |
| P11 | Two lanes with `merge: true` that settle together race for the source checkout's merge lease; the loser ends `blocked` because `mergeManagedWorktree` tries `acquire` once                            | D4d: sibling merge leases wait (bounded) and re-run the merge guard                                                                           |
| P12 | A one-prompt lane needs its own workflow file, and an agent that writes one dirties the parent's tree, so the D4c check and the `committed` gate both fail                                            | D13 inline single-step definitions                                                                                                            |
| P13 | MCP `append_step` accepts only flat prompt steps and can't name a worktree; agents can't supply `setup` scripts                                                                                       | D14 `worktreePresets` + `worktree: { use }` on `append_step` items                                                                            |
| P14 | `RunContinuationService.assertStepHasRequiredContent` (`:1498`, used for active-group joins and run edits) rejects anything without a `prompt` that isn't a script                                    | Phase 0 converts it to the exhaustive switch                                                                                                  |
| P15 | In the CLI, concurrent children would each try to own the single TTY (`supportsConcurrentInteractiveSessions` is always false there and only checked within one group)                                | R5: the CLI factory builds concurrent children with `hostCanProvidePty: false`                                                                |

### Group preflight for sub-workflow members

`preflightParallelGroupMember` (`ParallelGroupPreflight.ts:178`) gains a sub-workflow branch.
It resolves and **parses each child file once**; the launcher reuses that parse. An inline
member (D13) needs no resolution, and its materialized definition is built here once and reused
the same way. It classifies the child's execution plan from its `worktree` key using the D4
table, then checks:

- **Unresolvable path, child validation error, or cycle (D10)** → a per-member issue. The member
  settles FAILED and its `onFail` applies, as preflight failures do today.
- **Two members targeting the same named worktree branch** → `WORKTREE_COLLISION` (a new
  `PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES` entry, beside `SESSION_COLLISION`). Only one could
  ever hold its exclusive lease.
- **One member working in the parent's root while another has `merge: true` into it** →
  `MERGE_INTO_SHARED_ROOT`. "Working in the parent's root" covers an inheriting sub-workflow
  member **and any ordinary prompt or script member**, because both edit that tree. The merge
  would land under an agent that is still editing, or `mergeManagedWorktree`'s dirty-tree guard
  would turn it into `blocked`. The author's fix is to give that member its own worktree (make it
  a lane), or drop `merge`.
- **Parent checkout dirty and any member creates a worktree** → the D4c rule, applied **once for
  the group** before any worker starts. Every lane then branches from one commit.

The existing `INTERACTIVE_MULTIPLEX` check (`:337-356`) is about one instance multiplexing
interactive terminals. It fires only between interactive members of **one group**, using a static
per-host flag: VS Code passes `true`, and the CLI always passes `false`. It never counts sessions
in other instances. Children are separate instances whose own steps go through their own
preflight, so a sub-workflow member counts as non-interactive here. **Settled (R5):** that is
safe in VS Code, which multiplexes terminals. In the CLI, concurrent children are built
headless-only (`hostCanProvidePty: false`), so they never compete for the TTY.

### Group behaviour

- **Width:** `queue.maxParallelSteps` (default 6) caps concurrently running children. Each
  child's own parallel groups apply their own width, so total harness concurrency is the
  product. That is documented, not capped, in v1.
- **Fail fast:** with `failFast: true` (the schema default), a failing lane cancels its siblings
  through `cancelRunning` → `cancelTarget` → `handle.stop()`. The abort-caused CANCELLED rewrite
  (`ParallelGroupRun.ts:566-572`) fires only when the signal aborted, fail-fast triggered, and the
  member reports FAILED. A stopped child resolves CANCELLED rather than FAILED, so it is already
  CANCELLED and needs no rewrite. Add a test that a fail-fast-stopped lane is classified as a
  sibling cancellation, not a user stop (`cancelledBy: "parent"`). The authoring
  guide recommends `failFast: false` for long fan-outs.
- **Stopping one lane directly** (from the child's own dropdown row): only that member settles
  CANCELLED. Its siblings keep running, because stopping one lane should not discard others'
  work. At the join, any user-cancelled member makes the group return `stopped`, so
  `finishParallelGroupRun` (`WorkflowExecutor.ts:1456`) stops the parent **instead of
  advancing to the merge step with a missing lane**. Resuming the parent recovers the settled
  members (`getRecoveredGroupOutcome`, `WorkflowExecutor.ts:1163`) and reattaches the stopped
  lane's child run (D6). The
  handle tells the two cancellations apart: `SubWorkflowResult.cancelledBy` is `"parent"` when
  the cancel came through `handle.stop()`, and `"child"` otherwise.
- **Stopping the parent:** `subscribeToStop` → `cancelRunning` stops every child (D2).
- **Pause:** `ParallelGroupRun` already stops dispatching new members on PAUSING. D3's forwarding
  pauses every running child at its next step boundary. The parent stays PAUSING until they
  settle, the same contract as a running prompt member.
- **Snapshots:** the group "before"/"after" snapshot covers the parent's root, which includes
  members that inherit it. Children in their own worktrees don't touch it, and their changes
  reach the parent only through merges, which the next snapshot captures. No change needed.
- **Recovery:** members are identified by `stepId` as today. Settled members are recovered;
  in-flight ones re-execute and take the D6 reattach path.

### Ad-hoc fan-out: "Run alongside the current step"

The manual version of this pattern is starting workflows side by side while one is already
running. `appendStepsToActiveParallelGroup` (static, `RunContinuationService.ts:593`) already
supports `QUEUE_POSITION.PARALLEL_WITH_CURRENT`: it joins the active group or promotes the
running step into a new `failFast: false` group. It takes any `WorkflowStep`, but its
`assertIncomingStepsHaveRequiredContent` → `assertStepHasRequiredContent` guard knows only two
kinds: anything that isn't `type: script` must have a non-empty `prompt`. A sub-workflow step
would be rejected until Phase 0 converts that guard (it belongs on the Phase 0 list). Add a
**"Run workflow alongside current step…"** entry next to "Queue workflow to run next…" (see
Entry points). It sends `appendMode: "subWorkflow"` with `position: "parallelWithCurrent"`. It is
subject to that path's existing rules: the run must be RUNNING, width must be > 1, and the run
must not be in the final-step phase. The in-memory `instance.appendFromFile` path does **not**
honour `PARALLEL_WITH_CURRENT`: `PromptQueue.appendSteps` (`:2132`) → `resolveQueueInsertIndex`
(a free function in `DashboardConstants.ts:3575`) turns it into a plain insert index after the
current group or step, and never joins or promotes. So this entry must route through
`RunContinuationService.appendStepsToActiveParallelGroup`, as the MCP `append_step` handler does
(`mcp-server.ts:1529`).

---

## Queuing a Workflow After One That's Already Running

The previous draft said this needed only a different payload on `appendFromFileForClient`. That
is half true:

- **Without a run address**, `appendFromFileForClient` (`WorkflowOrchestrator.ts:2165`) calls
  `instance.appendFromFile` (`WorkflowInstance.ts:2951`). That appends to the live instance's
  queue in memory, even while it is RUNNING, but it spreads `parsed.steps` and drops the file's
  workflow-level settings.
- **With a run address**, it calls `appendAndContinueAtRun` (`:2197`), which **refuses an
  actively executing run** unless it is PAUSED (`RunLifecycleService.validateExplicitContinuationTarget`,
  `:888`). It also drops `position` and `parallelGroups`.

**Design:** add one shared builder, used by every entry point:

```typescript
// WorkflowInstance (or a small helper next to appendFromFile)
buildSubWorkflowReferenceStep(filePath: string): SubWorkflowStep
// → { type: STEP_TYPES.WORKFLOW, workflow: <path relative to the workspace root if inside it, else absolute> }
```

Then add an `appendMode: "inline" | "subWorkflow"` parameter, default `"inline"`, to
`appendFromFileForClient` and `instance.appendFromFile`. In `"subWorkflow"` mode the appended
tail is `[buildSubWorkflowReferenceStep(path)]` instead of `parsed.steps`. The child file is
still parsed once up front to fail fast on schema errors; its steps are not used. Route by state:

- **Instance RUNNING/PAUSING/PAUSED** → `instance.appendFromFile(..., "subWorkflow")` (in-memory
  append; it is picked up at the next step boundary and, if the queue already drained, by the
  final-step loop-back).
- **Run COMPLETED/STOPPED/ERROR** → `appendAndContinueAtRun(address, [step], …)`. This is the
  existing continue-a-finished-run path; it just gets a one-element tail.

### Entry points

| Surface                                                                               | Change                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WorkflowSwitcher.tsx` dropdown row context menu (`hooks/useWorkflowContextMenu.tsx`) | New item **"Queue Workflow to Run Next…"** on running/paused/finished run rows, and **"Run Workflow Alongside Current Step…"** on running rows (see Parallel, ad-hoc fan-out). Landed (round 13) on the viewed run's row only. |
| `WorkflowControls.tsx` queue `SplitButton` (`:110`)                                   | New option **"Queue as sub-workflow…"** next to the existing inline "Queue Workflow".                                                                                                                                          |
| Workspace viewer file menus (`hooks/useWorkflowFileMenuItems.ts`)                     | Same option for a workflow file.                                                                                                                                                                                               |
| VS Code explorer                                                                      | New `ctrlyoke.queueAsSubWorkflowFromContext` command next to `ctrlyoke.queueFromContext` (`extension.ts:1110`).                                                                                                                |

All of them send the existing `APPEND_FILE` message (`AppendFileMessage`,
`WebviewMessageTypes.ts:2717`) with a new optional `appendMode` field (`APPEND_MODES` constant;
default `inline`). There is no new message type. The handler is `DashboardMessageRouter.ts:1357`,
not `CtrlYokeWebviewProvider.ts`, which only forwards messages. It currently always passes
`QUEUE_POSITION.END`; the "alongside" entry needs it to forward a `position` too, so add that
optional field to the message in the same change. The hosted server shares that router through
`DashboardApplication`, so hosted parity comes free. Picking the file follows the existing split:
VS Code uses a native picker via `selectWorkspacePath` (`src/platform/VsCodeDashboardHostActions.ts:74`);
hosted mode uses `WorkflowFilePickerModal` (`components/workflow/WorkflowFilePickerModal.tsx`).

Existing inline append behaviour (splicing steps into the current run and session) is unchanged.

---

## Dashboard

### Parent step row

Rows are `WorkflowStepRow` (`components/steps/WorkflowStepRow.tsx`), which renders
`WorkflowStepItem` (`components/steps/WorkflowStepItem.tsx`), and script steps are a branch inside
it (`WorkflowStepItem.tsx:302-307`). After Phase 0 that branch becomes a switch, and the sub-workflow
arm renders:

- a workflow icon, a **"Workflow"** badge, and the referenced file's name as the subtitle.
  `getStepText` (`WorkflowStepRow.tsx:98`) returns the path for a file reference, and the inner
  step's text for an inline definition. There is no harness/model badge or token count. An inline
  lane shows its inherited harness/model as the inner step would ("(expected)" while its child
  runs, what the child ran with once it settles), plus a worktree badge;
- a live status badge for the child, looked up by `_runtime.childWorkflowKey` from the
  workflows the store already tracks (running / paused / completed / failed);
- the warning badge from D9 when the step completed with a `failureMessage`;
- an **"Open run →"** link once `childRunRef` is set. It calls
  `navigateToWorkflowAddress(vscode, { workflowKey, kind: "run", runRef }, name)`
  (`utils/runNavigation.ts:111`). One run-address link covers both a live child and a finished
  one, so no separate "View live output" and "View run" states are needed.

The step's output area (`components/layout/OutputSection.tsx`) renders the D12a metadata: outcome, branch,
and merge result. It does not mirror the child's step output; that lives in the child's own view
behind "Open run →". (Prompts in the parent that reference the step still receive the child's
output, per D12.) Inside a `ParallelGroupPanel`, members
are ordinary `WorkflowStepRow`s, so each lane gets this variant with no panel change. The
existing per-member output filter chips (`utils/outputRows.ts:179-209`) filter those metadata blocks.

### Prior-context controls

The Full / Summary control and `:summary` chips already exist. The prior-context preview and
`useAttachmentTokenCount` go through the same resolver and renderer as live injection, so they
pick up nested workflow output with no separate code path.

### Child run

The child's dropdown row and run header show **"Started by _<parent>_"**, linked to the parent
run via the same `navigateToWorkflowAddress` call, from `parentRun` in the child's manifest (D7).
The dropdown needs no other change.

### Editor

- **Step-type toggle** (`components/layout/EditorSection.tsx:304`/`:322`, `editorStore.setStepType`
  at `:1289`): a third **Workflow** option. `setStepType` today only flips a script flag (and
  closes the properties drawer for script). Change it to store a `WorkflowStepType`, so there is
  one source for the mode instead of a second boolean. `EditorSection` has its own `isScriptMode`
  (`:215`), which derives from it.
- **`components/editor/StepEditor.tsx`:** an `isSubWorkflowMode` path alongside `isScriptMode`
  (`:335`). It shows a workflow-file field with a browse button (same picker split as above), an
  `onFail` select (reuse the script step's select component), and the shared name/color/enabled
  fields. All prompt-only and script-only sections are hidden. A **File / Inline** switch picks
  D13's inline form. Inline shows the existing prompt or script editor for the wrapped step, plus
  a worktree control. The control reuses the workflow-level worktree editor, so there is no
  second copy. (An earlier revision also gave the workflow-properties editor a
  `worktreePresets` list "next to `conditions`". There is no `conditions` editor: both catalogs
  are author-only YAML, preserved but not edited by the dashboard; see Decisions, round 15.)
- **Building properties:** `StepEditor`'s `buildScriptUpdate` reads the editor through
  `getScriptStepEditorValues`/`getScriptStepUpdateFromEditor` (`utils/scriptStepProperties.ts`),
  which `utils/executionPreview.ts` and the inline builder share (round 16). The duplication earlier revisions flagged is gone. Add
  `getSubWorkflowStepPropertyUpdate` in a sibling `utils/subWorkflowStepProperties.ts`, used the
  same way by the editor and the preview. `editorStore` still repeats script-field resets in four
  places (`:590-597`, `:698-731`, `:1036-1138`, `:1843-1877`). Fold them into one
  `resetStepKindFields(kind)` helper before adding the workflow kind's resets.

### Execution preview

`ExecutionPreviewService.ts` (9 script branches) and `utils/executionPreview.ts`: a sub-workflow
step previews as a single "Runs _<file>_" entry. The preview does not expand child steps in v1.
An inline child previews as its wrapped step, resolved with D13's materialization, plus a
"in its own worktree" note when it has one.

---

## CLI and MCP

- **CLI (`src/cli.ts`):**
  - The CLI constructs its `WorkflowInstance` with a `SubWorkflowLauncher` whose factory builds
    sibling instances with the same dependencies, through the helper extracted from `runCommand`
    (D1). Concurrent children are headless-only (R5).
  - Child step progress goes through the same console reporter, prefixed with the child
    workflow's name.
  - `CliJsonResultBuilder.ts` adds `subWorkflowRuns: [{ stepId, workflowKey, runRef, status }]`
    to the parent's JSON result.
  - The exit code reflects only the parent's outcome, which already incorporates `onFail`.
  - The `--step` selection and `CliPropertyOverrides.ts` (6 script branches) are covered by
    Phase 0.
- **MCP server (`src/mcp-server.ts`):** no new tool. An earlier revision said the append tools
  validate against `workflowStep` and would accept `type: workflow` once the schema arm existed.
  That was wrong. `append_step` publishes its own flat prompt-only schema
  (`MCP_APPEND_QUEUE_ITEM_SCHEMA`), rejects script steps, and lets agents attach only
  author-defined presets. Agents get **lanes only**, through D14 (`worktree: { use }` →
  materialized inline child). They never get file references or arbitrary inline definitions.
  `edit_step` gains the D14 wrap and unwrap. `workflow_status` reports lane steps and
  `worktreePresets`. Its 9 script branches are covered by Phase 0. `read_output` and
  `workflow_status` gain the optional descendant-only `run` argument (D12c); the tool
  descriptions in `McpToolDefinitions.ts` mention it.
- **`ctrlyoke history show`** (`src/cli/HistoryInspectionCommands.ts:566`): no change; it already
  reads any run, including child runs (D12c). The authoring guide shows the command, with
  `-d <main checkout>` (R6), next to `$step:summary:…`.
- **`SCRIPT_GENERATED_STEPS_PLAN.md`:** **settled (R7).** `ctrlyoke step add` validates against
  `workflowStep` and appends through `RunContinuationService.appendStepsToRun`, so it accepts the
  full `subWorkflowStep`, file and inline, once Phase 0 lands. It is author-side, so D14's MCP
  restriction doesn't apply.

---

## Completions (`src/completions/`)

- `WorkflowLocationTypes.ts`:
  - add `WORKFLOW_OBJECT_KINDS.SUB_WORKFLOW_STEP`;
  - detect it in object-kind detection (`:155-172`) by `type: workflow`, ahead of the "anything
    else is a prompt step" fallback. An object under a sub-workflow step's `workflow` key is the
    inline definition: classify it as a prompt or script step by the existing rules, so inline
    editing gets prompt/script completions plus `worktree`;
  - map its text-holding key (`workflow`) to a new file-path role.
- `WorkflowFileCompletionCore.ts`: slot kinds (`:150-167`) gain the workflow kind for group,
  parallel-member and `finalStep` slots. Root key filtering (`rootKeyIsRelevant`, `:171`) gains a
  `subWorkflowOnly` set from `WORKFLOW_SCHEMA_OUTLINE[SUB_WORKFLOW_STEP]`
  (`src/types/generated/WorkflowSchemaOutline.ts`), which `schema:update` generates. Prompt and
  script keys are suppressed. Exclude sub-workflow steps from session candidates (`:465-472`,
  which today filter `!isScriptStep`; Phase 0 turns that into `isPromptStep`). They stay
  prior-context candidates, because D12 gives them output.
- `WorkflowPropertySnippets.ts`: update the `type` snippet detail (`:31`) to
  `"prompt" | "script" | "workflow"`, and add a sub-workflow step snippet.
- Path completion for the `workflow` value: reuse the existing prompt-file-path completion,
  filtered to workflow file extensions.
- (`:summary` completions, diagnostics, and `priorContextDetail` value completion already exist.)
- Docs: the `ctrlyoke-syntax` skill (`src/templates/skills/ctrlyoke-syntax/SKILL.md`) and the
  tech-support agent gain the workflow-step meaning of `$previous`.

---

## YAML Authoring UX

```yaml
# parent.ctrlyoke.yaml
harness: claude-cli
worktree: true # managed worktree; children without their own worktree key run in it too

steps:
  - name: Implement feature
    prompt: Implement the feature described in #file:spec.md

  - name: Test and fix (own harness, same worktree)
    type: workflow
    workflow: workflows/test-and-fix.ctrlyoke.yaml
    onFail: continue

  - name: Ship it
    prompt: Create a PR for the completed changes.

finalStep:
  type: workflow
  workflow: workflows/post-build-checks.ctrlyoke.yaml
```

---

## Edge Cases

| Scenario                                                          | Handling                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cycle (A → B → A)                                                 | Start failure naming the cycle (D10) → `onFail`                                                                                                                                                                      |
| Deep chain with no cycle                                          | Allowed; no depth limit                                                                                                                                                                                              |
| Same file queued after itself                                     | Allowed; not an active-ancestor cycle                                                                                                                                                                                |
| Child file missing or unresolvable                                | Start failure → `onFail`                                                                                                                                                                                             |
| Child schema/validation error                                     | Start failure carrying the validation message → `onFail`                                                                                                                                                             |
| Child fails (ERROR)                                               | `onFail` (D9)                                                                                                                                                                                                        |
| Child stopped (from either level)                                 | Parent step CANCELLED, parent stops (D2)                                                                                                                                                                             |
| Parent paused while blocked                                       | Parent PAUSING; pause forwarded to the child (D3)                                                                                                                                                                    |
| Child paused directly                                             | Parent stays RUNNING; the step row shows the child's paused state (D3)                                                                                                                                               |
| Window reload or crash mid-child                                  | The parent resumes and reattaches to the recorded child run (D6)                                                                                                                                                     |
| Child has no `worktree` key                                       | Runs in the parent's execution root via a delegated lease (D4a/D4d)                                                                                                                                                  |
| Child has `worktree: false` / managed / named                     | Honoured as authored. Worktrees branch from, and merge into, the parent's checkout (D4b)                                                                                                                             |
| Parent checkout dirty when a worktree child starts                | Managed parent: checkpoint commit. Main/named parent: start failure → `onFail` (D4c)                                                                                                                                 |
| Child `merge: true` conflicts or is blocked                       | Step COMPLETED with warning; recorded in the step's metadata for later steps (D4e/D12a)                                                                                                                              |
| Child names the same named worktree the parent holds              | Delegated lease applies only to inheritance; an explicit conflicting worktree fails to start (as built, the earlier "already checked out in the initiating source checkout" check fires before the lease) → `onFail` |
| Child has its own `finalStep`                                     | Runs as part of the child run                                                                                                                                                                                        |
| Two parallel members target the same named worktree               | `WORKTREE_COLLISION` preflight issue                                                                                                                                                                                 |
| Parallel member inherits the root another merges into             | `MERGE_INTO_SHARED_ROOT` preflight issue                                                                                                                                                                             |
| One parallel lane stopped by the user                             | Siblings finish; parent stops at the join; resume reattaches the stopped lane                                                                                                                                        |
| One parallel lane fails, `failFast: true`                         | Siblings' children are stopped (CANCELLED); group fails                                                                                                                                                              |
| Nested fan-out (a child that fans out itself)                     | Grandchildren branch from and merge into the child's worktree (D4b); lease chains cover every level (D4d)                                                                                                            |
| `worktree` key on a sub-workflow step                             | Schema error (the existing `workflowStep` wrapper rule)                                                                                                                                                              |
| `{{var}}` in the `workflow` path                                  | Not substituted in v1 (D11)                                                                                                                                                                                          |
| Host without `subWorkflowHost`                                    | Step fails with "not supported in this host"                                                                                                                                                                         |
| Root file is only a workflow step                                 | Valid one-step queue; append more workflows while it runs (D8)                                                                                                                                                       |
| `$previous` after a workflow step                                 | Metadata plus every child step's full output, recursively (D12a)                                                                                                                                                     |
| `$step:summary:N` over a very long child                          | One shared 400 KB summary budget; earliest child steps omitted whole (`omitted="all"`), metadata and the last summary always kept (D12b)                                                                             |
| CLI parallel group of lanes whose steps are interactive           | Children built headless-only; no TTY contention (R5)                                                                                                                                                                 |
| Bundle with `subWorkflowSettled` imported by an older ctrlyoke    | Import refused with "is not a recognized timeline event"; no timeline schema bump (R3)                                                                                                                               |
| Agent appends a lane to a paused worktree parent                  | Accepted: the R14 bug was fixed in `ffc623b4f`                                                                                                                                                                       |
| Child run history deleted before a later reference                | Metadata with `<childRunUnavailable/>`; not an error                                                                                                                                                                 |
| Inline child references `$previous` or a numeric `sessionId`      | Validation error naming the run boundary (D13)                                                                                                                                                                       |
| Inline child holds `steps`, `parallel`, or `type: workflow`       | Schema error; use a file (D13)                                                                                                                                                                                       |
| Agent names an unknown worktree preset, or the workflow has none  | `append_step`/`edit_step` error listing the available presets (D14)                                                                                                                                                  |
| Agent passes `type: workflow` or a file path to `append_step`     | Rejected by the flat item schema; agents only get lanes (D14)                                                                                                                                                        |
| Two `merge: true` lanes settle at the same time                   | The later merge waits for the earlier one's lease, then merges on top of it (D4d)                                                                                                                                    |
| Shared-tree member in the same group as a `merge: true` lane      | `MERGE_INTO_SHARED_ROOT` preflight issue                                                                                                                                                                             |
| `merge: true` lane joins a running step via `parallelWithCurrent` | Rejected with the `MERGE_INTO_SHARED_ROOT` message (D14)                                                                                                                                                             |

---

## File Change Summary

| File                                                                                                                                     | Change                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~62 files with `isScriptStep`/`STEP_TYPES.SCRIPT` branches                                                                               | **Phase 0:** exhaustive `getStepType` switch / `isPromptStep`, plus the binary-ternary guard check                                                                                                                                                 |
| `src/types/WorkflowTimelineTypes.ts`, `src/core/orchestration/TimelineRecorder.ts`                                                       | `SUB_WORKFLOW_SETTLED` event (R3); `WorkflowRunManifest.parentRun` written by `initializeRunAt` (D7)                                                                                                                                               |
| `OutputHistoryTimelineAdapter.ts`, `HistoryRunDocumentBuilder.ts`, `RunBundleReader.ts`                                                  | Handle the new event type                                                                                                                                                                                                                          |
| `src/utils/VarSubstitutionPolicy.ts`                                                                                                     | Exclude inline `workflow` objects and `worktreePresets` (R10)                                                                                                                                                                                      |
| `src/utils/McpWorktreePresetResolver.ts` (new), `src/utils/McpConditionPresetResolver.ts`                                                | Preset lookup/summary sharing one own-property helper (D14)                                                                                                                                                                                        |
| `src/cli/CliExecutionMode.ts`, `src/cli.ts`                                                                                              | Instance-construction helper reused by the CLI launcher factory; headless-only concurrent children (R5)                                                                                                                                            |
| `src/ui/webview-react/utils/subWorkflowStepProperties.ts` (new)                                                                          | Property update shared by `StepEditor` and the preview                                                                                                                                                                                             |
| `schemas/workflow-schema.json` (+ `npm run schema:update` outputs)                                                                       | `stepLifecycleRuntime` + `stepDisplayProperties` extraction, `subWorkflowStep`, `subWorkflowRuntimeMetadata`, `workflowStep` arm, `parallelGroupItem` description                                                                                  |
| `src/types/DashboardConstants.ts`                                                                                                        | `STEP_TYPES.WORKFLOW`, `PROMPT_PROPERTIES.WORKFLOW_REF`, `SUB_WORKFLOW_STEP_COPY_FIELDS`, `WORKFLOW_OBJECT_KINDS.SUB_WORKFLOW_STEP`, `APPEND_MODES`                                                                                                |
| `src/types/CtrlYokeTypes.ts`                                                                                                             | `SubWorkflowStep`, `StepLifecycleRuntime`, `SubWorkflowRuntimeMetadata`, union, `isSubWorkflowStep`, `getStepType`, `isPromptStep`, manifest `parentRun`                                                                                           |
| `src/types/WebviewMessageTypes.ts`                                                                                                       | Optional `appendMode` on `AppendFileMessage`                                                                                                                                                                                                       |
| `src/core/PromptFileParser.ts`                                                                                                           | `buildSubWorkflowStep`, `finalStep` arm, validation, parallel rejection                                                                                                                                                                            |
| `src/core/WorkflowExecutor.ts`                                                                                                           | Context `subWorkflowHost`/`ancestorPaths`, dispatch arm, `executeSubWorkflowStep`                                                                                                                                                                  |
| `src/core/orchestration/SubWorkflowLauncher.ts` (new)                                                                                    | `SubWorkflowHost` implementation shared by every host                                                                                                                                                                                              |
| `src/core/WorkflowInstance.ts`                                                                                                           | Context plumbing, pause/cancel-pause forwarding, `appendFromFile` `appendMode`, parent link and inherited root in load/execution options                                                                                                           |
| `src/core/orchestration/ExecutionRootLeaseManager.ts`                                                                                    | `delegationChain` on requests and leases; ancestor and sibling compatibility (D4d)                                                                                                                                                                 |
| `src/core/orchestration/WorktreeManager.ts`, `src/core/WorkflowInstance.ts`                                                              | Source-checkout override (D4b), worktrees root from the main checkout, checkpoint commit (D4c), delegated merge lease (D4d)                                                                                                                        |
| `src/core/ParallelGroupRun.ts`, `src/core/ParallelGroupPreflight.ts`, `DashboardConstants.ts` (preflight codes)                          | Sub-workflow preflight branch, `WORKTREE_COLLISION` / `MERGE_INTO_SHARED_ROOT`, once-per-group dirty check, user-cancelled lane → stop at join                                                                                                     |
| `src/core/orchestration/RunOutputResolver.ts`                                                                                            | Workflow item arm (child run via `resolveAllPriorContextItems`)                                                                                                                                                                                    |
| `src/core/HarnessIntegration.ts`, `src/utils/PriorContextPreviewBuilder.ts`                                                              | `PriorContextItem.subWorkflow`, nested XML, workflow arm of `summarizePriorContextItem`                                                                                                                                                            |
| `src/mcp-server.ts`, `src/utils/McpToolDefinitions.ts`                                                                                   | Descendant-only `run` argument on `read_output` and `workflow_status` (D12c); `worktree: { use }` on `append_step` items, lane wrapping in `materializeAppendStep`, `edit_step` wrap/unwrap, `worktreePresets` in `workflow_status` metadata (D14) |
| `src/core/orchestration/PromptFileLoader.ts`                                                                                             | Throwing `loadFromMemory` variant for inline children (D13)                                                                                                                                                                                        |
| `src/core/orchestration/RunContinuationService.ts`                                                                                       | Phase 0 conversion of `assertStepHasRequiredContent`; `MERGE_INTO_SHARED_ROOT` check on `parallelWithCurrent` lane joins (D14)                                                                                                                     |
| `src/core/orchestration/ExecutionRootLeaseManager.ts`, `WorktreeManager.ts`                                                              | Lease `purpose: "merge"`; sibling merge leases wait (D4d)                                                                                                                                                                                          |
| `src/templates/agents/workflow-orchestrator.agent.md`, `src/templates/workflows/spec-driven-loop.ctrlyoke.yaml`                          | Lane guidance; `worktreePresets.lane` + `laneSetup` variable (D14)                                                                                                                                                                                 |
| `src/templates/skills/ctrlyoke-syntax/SKILL.md`, `src/templates/agents/ctrlyoke-tech-support.agent.md`                                   | Workflow-step `$previous` documentation                                                                                                                                                                                                            |
| `src/core/WorkflowOrchestrator.ts`, `WorkflowInstanceRegistry.ts`                                                                        | Launcher factory via `createExternalWorkflowInstance`; `appendFromFileForClient` `appendMode` routing                                                                                                                                              |
| `src/ui/DashboardMessageRouter.ts`                                                                                                       | `APPEND_FILE` handler passes `appendMode`                                                                                                                                                                                                          |
| `src/extension.ts`, `package.json`                                                                                                       | `ctrlyoke.queueAsSubWorkflowFromContext` command and menu entry                                                                                                                                                                                    |
| `src/cli.ts`, `src/cli/CliJsonResultBuilder.ts`                                                                                          | CLI launcher factory, child progress output, `subWorkflowRuns` in JSON                                                                                                                                                                             |
| `src/ui/webview-react/components/steps/WorkflowStepItem.tsx`, `components/steps/WorkflowStepRow.tsx`                                     | Sub-workflow row variant, live child badge, "Open run" link, `getStepText`                                                                                                                                                                         |
| `src/ui/webview-react/components/layout/EditorSection.tsx`, `components/editor/StepEditor.tsx`, `store/editorStore.ts`                   | Workflow step type (`setStepType` stores a `WorkflowStepType`), editor mode, `resetStepKindFields`                                                                                                                                                 |
| `src/ui/webview-react/hooks/useWorkflowContextMenu.tsx`, `components/workflow/WorkflowControls.tsx`, `hooks/useWorkflowFileMenuItems.ts` | "Queue workflow to run next…" / "Queue as sub-workflow…"                                                                                                                                                                                           |
| `src/ui/webview-react/components/workflow/WorkflowSwitcher.tsx`                                                                          | "Started by" label on child rows                                                                                                                                                                                                                   |
| `src/core/ExecutionPreviewService.ts`, `ui/webview-react/utils/executionPreview.ts`                                                      | Single-entry preview                                                                                                                                                                                                                               |
| `src/completions/*`                                                                                                                      | Object kind, key filters, snippets, path completion                                                                                                                                                                                                |
| `docs/` guide page                                                                                                                       | Authoring guide for sub-workflows (the reference pages are generated)                                                                                                                                                                              |

---

## Tests

- **Schema:** valid in `steps`, `finalStep`, `parallel`, and at the single-step root (with a
  root `worktree` applying to the parent); rejected with a step-level `worktree` or unknown keys.
- **Prior context (D12, workflow arm):**
  - `$previous` after a workflow step yields the metadata plus every child step, recursively
    for a three-level chain; `$previous:2` counts parent-level steps;
  - workflow budget: earliest child steps omitted first in chronological order, metadata and the last summary kept, one budget shared with parent steps and nested children;
  - deleted child history renders `<childRunUnavailable/>`;
  - the editor preview matches live injection for a workflow step at both detail levels.
- **`read_output` / `workflow_status` (D12c):** a child and a grandchild run are readable through
  `run`, with paging unchanged; a sibling's or unrelated run is rejected with the scope message.
- **Parser:** normalization of the `finalStep` and parallel-member arms; missing-file
  validation; `userInput` still rejected in groups.
- **Parallel (fake host):**
  - a three-lane fan-out joins and then advances;
  - `failFast` stops sibling children;
  - a user-stopped lane lets its siblings finish, then stops the parent, and resume reattaches it;
  - each new preflight code;
  - the once-per-group dirty check;
  - every lane's metadata resolves through `$step:a-b` and `$step:summary:a-b`.
- **Worktrees (real git, temp repos):**
  - a managed child of a worktree parent branches from the parent's `HEAD` and merges into the
    parent's branch;
  - `merge: true` succeeds while the parent holds its lease;
  - merge conflict reported, not failed;
  - checkpoint commit on a managed parent.
- **Executor (Mocha, fake `SubWorkflowHost`):** each row of the D9 table; cycle detection
  (including Windows case-insensitivity); runtime linkage persisted before `done`; D6 reattach
  for each branch (completed, continue, missing directory).
- **Propagation:**
  - parent stop → child stop (no 10 s wait);
  - child stop → parent stops;
  - parent pause → child paused while the parent stays PAUSING;
  - cancel pause → forwarded;
  - pausing the child directly leaves the parent RUNNING;
  - a three-level chain for recursion.
- **Lease:**
  - a delegated request is compatible with every lease in its chain, and with siblings that
    share its delegator;
  - it is incompatible with unrelated leases;
  - a merge lease is incompatible with sibling delegates.
- **Append:** `appendMode: "subWorkflow"` on a RUNNING instance (in-memory, one step) and on a
  COMPLETED run (`appendAndContinueAtRun` with a one-element tail); inline mode unchanged.
- **Inline definitions (D13):** materialization overlays the inline keys on the parent's
  workflow-level defaults and `vars`; cross-boundary references are rejected; Save round-trips
  the authored object; a bad inline definition is a start failure with the real message; D6
  reattach works with no source file.
- **Agent lanes (D14):** `append_step` with `worktree: { use }` wraps flat items and `parallel`
  members into inline children carrying a by-value preset copy; unknown or missing presets are
  rejected; `type: workflow` and file paths are rejected; `edit_step` wraps and unwraps;
  `workflow_status` lists lanes and presets; a `merge: true` lane can't join a running step.
- **Sibling merge wait (D4d, real git):** two `merge: true` lanes settling together both merge,
  the second on top of the first; a real conflict still ends `conflict`; a chainless merge lease
  still fails fast; a waiter gives up with `blocked` after `WORKTREE_MERGE_LEASE_WAIT_MS` (use a
  fake clock); a non-conflict acquire error still ends `blocked` at once.
- **Var substitution (R10):** `VarSubstitutionPolicy.test.ts` passes with the new exclusions;
  `{{var}}` in an inline prompt resolves in the child to the parent's effective value (including a
  `--var` override), once; a `{{var}}` in a `workflow` path stays literal.
- **Timeline (R3):** `subWorkflowSettled` round-trips through `OutputHistoryTimelineAdapter`,
  history documents and run-bundle export/import.
- **Launcher (R2):** a child that fails preflight and a child whose file fails to load both
  settle `failedToStart: true`; a child that fails mid-run does not.
- **CLI concurrency (R5):** a parallel group of two lanes in the CLI builds both children with
  `hostCanProvidePty: false`; a sequential child keeps the TTY.
- **Phase 0 guard:** the binary-ternary check fails on a new `isScriptStep(x) ? … : …` outside
  the allow-list.
- **CLI:** a nested run end to end with the JSON `subWorkflowRuns`.
- **UI (Vitest):** row variant, live badge lookup, the "Open run" link address, the editor mode
  toggle, and the context-menu item.

---

## Not In Scope (v1)

- **Variable passthrough** from parent to child (D11).
- **AI-generated summaries.** The `:summary` detail is a deterministic excerpt (D12b).
- **Configurable summary caps.** Fixed constants in v1 (D12b).
- **Automatic merging at the join.** Merge-back is the child's own `merge: true` or an authored
  merge step. ctrlyoke does not add an implicit "merge all lanes" phase.
- **A global concurrency cap** across nested fan-outs (see Parallel, Width).
- **Worktree variables** (`{{worktree.branch}}`, `CTRLYOKE_WORKTREE_*`) for ordinary steps. D12
  covers the sub-workflow case; a general version is a separate plan.
- **`{{var}}` in the `workflow` path** (D11).
- **Sub-workflows as `endCondition`/`preCondition`.**
- **Cross-workspace workflow files** beyond what trusted roots already allow (D5).
- **Expanding child steps inline** in the parent view or the execution preview.
- **Depth limits.** Cycle detection is the only guard (D10).
- **Step-level `worktree`.** Rejected, not deferred; see
  [Why not let steps override `worktree`?](#why-not-let-steps-override-worktree).
- **Parent output inside an inline child.** `$previous`/`$step:` in an inline definition is a
  validation error (D13). A lane gets what it needs from its prompt, the repo, or a run-address
  `priorContext`. A later version could resolve those references in the parent at launch and
  bake them into the child's prompt.
- **Multi-step inline definitions**, and named-mode or agent-supplied worktree presets (D13,
  D14).

---

## Rough Effort Estimate

| Work                                                                                                            | Days  |
| --------------------------------------------------------------------------------------------------------------- | ----- |
| Phase 0: exhaustive step-kind branching across ~62 files, plus the guard check                                  | 1.5–2 |
| Schema (lifecycle extraction, new defs, wiring) + types + parser                                                | 1     |
| `SubWorkflowLauncher` + executor arm + outcome mapping + cycle check                                            | 2     |
| Stop/pause forwarding (D2/D3)                                                                                   | 1     |
| Worktree rules D4a–e: source-checkout override, dirty check, lease chains, delegated merge                      | 2–2.5 |
| D12 workflow arm: `subWorkflowSettled` event, nested child-run rendering, workflow summary budget               | 1     |
| D12c: descendant-only `run` argument on `read_output`/`workflow_status`                                         | 0.5   |
| Parallel: member acceptance, preflight branch and codes, user-cancelled lane at join, ad-hoc "alongside" entry  | 2     |
| Resume reattach (D6) + manifest parent link (D7)                                                                | 1     |
| Queue-after-running: `appendMode` plumbing + entry points                                                       | 1     |
| Dashboard row, "Started by" label, editor mode, preview                                                         | 1.5–2 |
| CLI integration + completions                                                                                   | 1     |
| D13 inline definitions: schema arm, boundary validation, materialization, throwing `loadFromMemory`             | 1     |
| D14 agent lanes: `worktreePresets`, `append_step`/`edit_step`/`workflow_status`, orchestrator agent + template  | 1.5   |
| D4d sibling merge wait (`purpose: "merge"`, bounded retry)                                                      | 0.5   |
| Revision 5 additions: timeline event wiring (R3), var-substitution exclusions (R10), CLI headless children (R5) | 0.5–1 |
| Tests (including real-git worktree fan-out tests)                                                               | 3–4   |

**Remaining total: about 24–26 days** (the prerequisite bugs and the step-kind-agnostic D12
work are done). The sequential-only slice (landing steps 1–2 below, now including D4a + D4d
rule 1, plus queue-next from step 6) is roughly 9–11 days of that. The isolated-lanes slice
(step 3) adds about 6–7 days on top.

**Suggested landing order** (each step after Phase 0 ships on its own):

1. **Phase 0.** No behaviour change; it also unblocks `USER_INPUT_STEP_PLAN.md`.
2. **Sequential core:** schema, types, parser, executor arm, launcher, stop/pause, cycle
   detection, root workflow step, D12a workflow metadata and full output (including the
   workflow summary budget). Usable from authored YAML. This is a complete sequential chaining
   feature for parents on the main checkout: `isCompatible` (`ExecutionRootLeaseManager.ts`)
   already lets two `SHARED_NATIVE` leases coexist, so a child with no `worktree` key runs
   alongside the blocked parent, and a managed-worktree child branches from the main checkout as
   today. A parent that is itself in a worktree holds an `exclusive-worktree` lease, so an
   inheriting child would conflict. **Decided (R1): D4a + D4d rule 1 (ancestor delegation only,
   about 1 day) ship in this step**, so the headline "implement in a managed worktree, then run a
   test sub-workflow in it" case works from the first release. A worktree child of a worktree
   parent needs D4b; see the Progress Decision "D4b moves ahead of the rest of step 4" for why
   it lands with step 3 instead of a start error.
3. **Isolated lanes, for a parent on the main checkout.** The
   [motivating case](#motivating-case-isolated-parallel-lanes), shipped before the full worktree
   rules because it needs only a subset of them (see
   [Isolated lanes](#isolated-lanes-single-step-members)):
   - D13 inline definitions and D14 agent lanes, including the orchestrator agent and the
     `spec-driven-loop` template;
   - parallel acceptance of sub-workflow members, with their preflight branch;
   - the D4c dirty check;
   - D4d rule 1 for merge leases, plus the sibling merge wait;
   - `MERGE_INTO_SHARED_ROOT`;
   - the user-cancelled-lane join rule;
   - D6/D7, because recovery of an in-flight lane must reattach rather than create a second
     worktree for the same work.

   D4b (the source-checkout override and the main-checkout worktrees root) lands with this step
   too (Progress Decisions).

4. **Remaining worktree rules (D4d rule 2).** Nested fan-out and sibling delegation.
   (R14's bug, [`mcp-queue-mutations-refused-on-paused-worktree-run`](../bugs/implemented/mcp-queue-mutations-refused-on-paused-worktree-run.md),
   is already fixed in `ffc623b4f`.)
5. **Authored waves end to end:** inheriting members, `WORKTREE_COLLISION`, and named-worktree
   members. This is the staging-plan pattern.
6. **Entry points:** queue next, run alongside.
7. **Editor and completions polish**, including the inline-definition editor mode.

---

## Progress

Maintained by the orchestrating final step of the workflow that implements this plan. Only that
step edits this section; implementation steps report contradictions and deferrals in their
summaries instead.

### Done

- **Round 1 (reviewed 2026-11-26): Phase 0 and the schema extraction.** No behaviour change;
  `npm test` green (8421 extension, 4917 UI).
  - `d1b4765a1`: `getStepType`, `isPromptStep`, `assertNever` in `CtrlYokeTypes.ts`; `src/core/*.ts`
    and `src/types/` converted.
  - `1b40f353f`: orchestration, CLI, MCP, utils, completions, git converted.
  - `5f3a93d27`: webview converted; the shared `assertNever` replaced `WorkflowSwitcher`'s copy.
  - `af172c7a2`: `StepKindBranchGuard.test.ts` (AST guard; allow-list keyed by file, function and
    condition text; stale entries fail) and a `types-core.instructions.md` bullet.
  - `3212e3294`: `stepDisplayProperties`, `stepLifecycleRuntime`, `stepOnFail` and
    `managedWorktreeConfig` `$defs`; `StepLifecycleRuntime` interface.
  - `cc8b84914` (review fix): `managedWorktreeConfig` had been given the named-branch _string_
    shorthand instead of the managed _object_ arm D14 needs; moved, with a pinning test. The
    shared `name` description now matches `VAR_SUBSTITUTION_POLICY` (`steps[].name` is
    substituted at dispatch; the old prompt copy wrongly said "Not substituted").

- **Round 2 (reviewed 2026-11-26): sequential core, part 1.** The step kind exists in types,
  schema and parser, and the executor runs it through a `SubWorkflowHost`, but no host passes one
  yet, so a workflow step fails with "Sub-workflow steps are not supported in this host". `npm test`
  green (8442 extension, 4917 UI).
  - `51ea7af0b`: `isExecutionStep`, `getExecutionRuntime` (step 1a stopped after the helpers; the
    sweep itself landed in 1c).
  - `8dac5b624`: tests narrow step kinds (`src/test/helpers/stepAssertions.ts`).
  - `b0ad3c606`: `STEP_TYPES.WORKFLOW`, `SubWorkflowStep`, `SubWorkflowRuntimeMetadata`,
    `isSubWorkflowStep`, `getWorkflowStepText`, `SUB_WORKFLOW_STEP_COPY_FIELDS`,
    `PROMPT_PROPERTIES.WORKFLOW_REF`, and the case arms. `failureKind`/`rewoundFailure` moved
    into `StepLifecycleRuntime`.
  - `e9fc0f29c`: schema `subWorkflowStep`, `subWorkflowRuntimeMetadata`, `rootWorkflowStep`;
    parser `buildSubWorkflowStep` (steps, finalStep, root), D5 parse-time check, R15 index;
    parallel members still rejected with a message saying so.
  - `8993bd372`: port types in `src/types/SubWorkflowTypes.ts` (plus `SubWorkflowInstance`,
    `SubWorkflowInstanceFactory`), `SUB_WORKFLOW_CANCELLATION_SOURCES`, `SubWorkflowLauncher`.
  - `0c73d6c33`: context `subWorkflowHost`/`ancestorPaths` (root seeded with the instance's own
    definition path), `executeSubWorkflowStep`, `settleNonHarnessStep`,
    `ActiveTargetResources.subWorkflow` registration.
  - `0044312f5` (review fixes): `settleNonHarnessStep` had changed script behaviour (an errored
    script under `onError: continue` no longer failed its queue step), now restored; a cancelled
    child had called `confirmStopped()` itself, it now only requests the stop and lets the outcome
    coordinator confirm and commit it; a launch that throws before the child exists now reads
    "Sub-workflow could not start: …"; the schema's `stepLifecycleRuntime` now carries
    `failureKind`/`rewoundFailure` to match the type (a workflow step's `_runtime` with either
    failed validation); workflow steps bulk-edit `enabled`/`color` like scripts; literal
    `"missing"`/`"continue"` comparisons replaced with constants.

- **Round 3 (reviewed 2026-11-26): sequential core, part 2.** A sequential `type: workflow`
  step runs end to end in every host. `npm test` green (8457 extension, 4917 UI). Gaps the
  review found are round 4's first three steps.
  - `71a01baa0`: one `SubWorkflowLauncher` per host (`WorkflowInstanceRegistry` through
    `createExternalWorkflowInstance`; CLI through `src/cli/CliWorkflowInstanceFactory.ts`);
    `WorkflowInstance implements SubWorkflowInstance`. The launcher now starts execution before
    returning the handle, because a real instance allocates its `runRef` when execution starts,
    not on load (D1/launch item 4 assumed "after load").
  - `1e331f55f`: D2/D3 forwarding in `WorkflowInstance` (`forwardSubWorkflowControl`); the
    detector fallback is skipped while a child handle is live; `resume()` during PAUSING goes
    through `cancelPause()`. Real-instance stop tests were attempted and dropped (see round 4).
  - `47af3d0b3`: D7 `parentRun` through `loadPromptFile` options into
    `TimelineRecorder.initializeRunAt`; preserved on rewrites, cleared for seeded re-runs,
    round-trips through bundles. No timeline format bump.
  - `a7a68ce5a`: D4a (absent `worktree` key inherits `parentExecution`) and D4d rule 1
    (`delegationChain` on the request and the lease; `isCompatible(request, existing)`).
  - `afa9a4fb9`: `SubWorkflowOutput`, `TIMELINE_EVENT_TYPES.SUB_WORKFLOW_SETTLED`, recorded once
    per launched child; readers handle it.
  - `4dc23c75c`: `PriorContextItem.subWorkflow`, recursive child resolution in
    `RunOutputResolver.resolveSubWorkflowChildren`, nested XML, `<childRunUnavailable/>`, the
    workflow arm inside the shared summary budget.
  - `4c1eea8a7`: `docs/workflows/sub-workflow-steps.md`, CHANGELOG (with the R3 bundle note),
    schema description corrections.
  - `aee34c9d2` (review fix): a CLI child no longer inherits the parent's `--session-id`
    override flag; its config comes from a pure `resolveCliSubWorkflowInstanceConfig`, so the
    test no longer casts into private fields. `SubWorkflowInstanceOptions` named.
  - **Found in review** (all fixed in round 4, except where round 4 notes otherwise):
    - a `finalStep` sub-workflow always fails with "Sub-workflow parent run identity is
      unavailable": the executor requires `_runtime.stepId`, which only queue steps have. D1's
      `SubWorkflowParentLink` is now a phase-discriminated union;
    - no real-instance stop/pause propagation tests; the step that tried reported a child
      script whose stop "waited on the detector fallback" past the 30 s suite timeout, which may
      be a real bug in stopping a script step;
    - `HistoryRunDocumentBuilder` indexes the event as a fake script output
      (`"Sub-workflow settled: <status>"`) and `getAttemptIndex` returns 0 for it;
    - `resolveSubWorkflowChildren` calls `WorkflowPaths.manifestPath` outside its `try`, so an
      invalid `childRunRef` (e.g. from an imported bundle) throws instead of rendering
      `<childRunUnavailable/>`; no depth guard on the recursion;
    - the `workflow=` attribute renders the absolute `resolvedWorkflowPath`, not the authored
      path the D12a example shows; unset worktree fields render as `branch=""`;
    - `summarizePriorContextItem` has no workflow arm in an exhaustive step-kind switch (a
      workflow item falls into the prompt branch with empty text);
    - `SubWorkflowOutput` re-declares `SubWorkflowResult`'s fields instead of deriving them, and
      `PriorContextItem.subWorkflowOutput` is dead;
    - no resolver-backed prior-context tests (three-level chain, `$previous:2` counting,
      deleted child, preview = live injection), and no bundle or history-document test for the
      event.

- **Round 4 (reviewed 2026-11-26): round-3 gaps, D12c and D6.** `npm test` green (8471
  extension, 4917 UI) before the review fix. Gaps the review found are round 5's first three
  steps.
  - `a1abe6b13`: `SubWorkflowParentLink` is phase-discriminated (`FINAL_STEP_PHASES`); a
    `finalStep` sub-workflow launches with `{ phase: finalStep, loopIndex }`; real parent/child
    finalStep test; one instance builder in `subWorkflowHost.integration.test.ts`.
  - `490c3b0a0`: `stop()` settles a script-only stop when its process runners shut down instead
    of on the 10 s detector fallback (pre-existing bug; CHANGELOG Fixed). Only two of the
    requested real-instance tests landed (plain script stop, parent stop → child stop).
  - `8cd3dca9a`: `subWorkflowSettled` has its own history candidate extraction and real
    `attemptIndex`; `resolveSubWorkflowChildren` renders `<childRunUnavailable/>` for invalid
    or unreadable addresses and has a visited-set guard; `workflow=` is the authored path; unset
    worktree attributes are omitted; `PriorContextItem.stepKind`; `SubWorkflowOutput` derives
    from `SubWorkflowResult`; resolver-backed three-level, `$previous:2`, deleted/invalid child,
    preview-parity, bundle and history-document tests.
  - `a0c91b91f`: D12c `run` argument on `read_output`/`workflow_status` (`resolveSelectedRun`
    in `src/mcp-server.ts`; ancestry walk bounded at 128 links); docs and CHANGELOG.
  - `66b970cc2`: D6 reattach (executor checks the recorded child's manifest `parentRun`;
    completed → settle without launch; otherwise `resumeChildRun` → launcher continues through
    `executeContinuationAtRun`). **Shipped without any of its requested tests** (the step said so).
  - `26547a380` (review fix): `490c3b0a0`'s fast path returned before cancelling harness
    integrations, so stopping a parallel group with a prompt member beside a script member left
    the prompt harness running; failing test first. Also a missing newline after `<worktree/>`
    and a `read_output` hint on `<childRunUnavailable/>` that named the unreadable run.
  - **Found in review, not yet fixed** (round 5 steps 1–3):
    - D6: no executor branch tests and no real-instance resume test; `parentRun` compared with
      `JSON.stringify` (key-order dependent); the continuation handle in `SubWorkflowLauncher`
      duplicates the fresh-launch handle and lacks its `.catch` on `done`; `stateRoot` is an
      optional request field read with `!`; the executor reads the parent's whole `events.jsonl`
      on every settle to avoid a duplicate `subWorkflowSettled`; the executor constructs
      `TimelineRecorder` directly;
    - propagation tests still missing: child stop → parent STOPPED, three-level root stop,
      pause/resume with a single child execution, pausing the child directly leaves the parent
      RUNNING;
    - D12c: `handleReadOutput` applies the attached run's `groupStartBoundary` to a descendant
      run's indices; `workflow_status`/`read_output` never expose a workflow step's
      `childWorkflowKey`/`childRunRef`/outcome, so an agent cannot discover the address the
      docs tell it to use; the budget stub's `readOutput` hint is dead code (`applySummaryBudget`
      never positions items inside a child, so `item.subWorkflow` is always unset there);
    - prior context: `PriorContextItem.stepKind` is optional and rendering still branches on
      `item.subWorkflow`/`item.scriptOutput`; the resolver's visited set omits the root run, so
      A→B→A renders A once more; no cycle test; inline `import()` types remain in
      `SubWorkflowInstance` (`src/types/SubWorkflowTypes.ts`);
    - MCP tests missing: the attached run passed as `run`, a traversal `workflowKey`, a
      finalStep-phase child.

- **Round 5 (reviewed 2026-11-26): round-4 gaps and the first user-facing surfaces.** `npm test`
  green (8480 extension, 4926 UI). Two of its six steps fell short again; see "Found in review".
  - `56d1d63ab`: `isSameSubWorkflowParentLink` (field-wise, phase-discriminated) replaces both
    `JSON.stringify` comparisons; `SubWorkflowLaunchRequest.stateRoot` is required; one
    `executionHandle` builds fresh and continuation handles (the continuation now has the
    `.catch`); the parent timeline is read only on the COMPLETED-reattach branch. **Shipped
    with only a key-order test**: no executor branch tests, no continuation-rejection test, no
    real-instance resume test, and the executor still constructs `TimelineRecorder`.
  - Round 5 step 2 (propagation tests) **committed nothing.** It wrote a real-instance stop →
    resume test instead and reported that **continuing a stopped parent skips its cancelled
    workflow step** (`currentIndex` past it, "next target: none"), so D6's continuation branch is
    never reached from a real resume. It also reported that its propagation cases "failed
    independently", without saying why. Both are unverified leads for round 6.
  - `ac3429c54`: D12c `groupStartBoundary` applies only to the attached run; `workflow_status`
    lists a settled queue workflow step's `childRun { workflowKey, runRef, outcome }`;
    `read_output` on a workflow step returns its D12a XML through
    `buildPriorContextXmlFromItems`; budget stubs inside a child carry an escaped
    `read_output { run, indices }` hint (`PriorContextItem.containingRun`); `stepKind` is
    required and rendering switches on it; the resolver seeds the visited set with the root
    run; unreadable children log at warn; inline `import()` types gone; MCP tests for the
    attached run as `run`, traversal keys and a finalStep-phase child.
  - `f14e72cc5`: `subWorkflowRuns` in `run --json` (`CliJsonSubWorkflowRun`: queue children by
    `stepId`, a finalStep child by 1-based `pass`), docs `docs/cli/ci.md`/`ctrlyoke.md`. **Items
    1, 3 and 4 were not done**: no child progress prefix (its CHANGELOG line claimed one), no
    exit-code test, no compiled-CLI end-to-end test.
  - `e7a60901e`: dashboard workflow row (badge, subtitle, live child status by
    `childWorkflowKey`, D9 warning, "Open run →"), `MESSAGE_TYPES.SUB_WORKFLOW_SETTLED` live
    message plus history projection as a status line, `RunSummary.parentRun` and "Started by" on
    the run row and header (unavailable when the parent lineage is not in `recentWorkflows`),
    `SUB_WORKFLOW_DASHBOARD_LABELS`, docs and CHANGELOG.
  - `86aaa82a9`: D4c for sequential children: `prepareParentCheckoutForWorktreeChild`
    (`WorktreeManager.ts`) runs in the launcher after the child parses and before it executes
    (worktree creation happens at execution, so nothing is double-loaded); reattach skips it;
    managed parent → `buildManagedAutoCommitMessage` checkpoint, otherwise start failure.
  - `47c33ad74` (review fix): `dirtyParentWorktreeChildMessage(count)` replaces
    `String.replace("N", …)` on a placeholder constant; one `readQueueSubWorkflowOutputs` scan
    shared by `workflow_status`/`read_output`; one visited-key helper in `RunOutputResolver`;
    `WORKFLOW_VIEW_ADDRESS_KIND.RUN` instead of `"run"` literals; one "Started by" lookup in
    `WorkflowSwitcher`; the false CLI-prefix CHANGELOG claim removed.
  - **Found in review, not yet fixed** (round 6 steps 1–4):
    - D6: everything listed under round 5's first commit above, plus the continuation-skip lead;
    - propagation tests still missing (fourth time on the roadmap): child stop → parent STOPPED,
      three-level root stop, pause/resume with a single child execution, pausing the child
      directly leaves the parent RUNNING;
    - CLI: child progress prefix, exit-code tests, compiled-CLI end-to-end test; the JSON shows
      only the latest finalStep pass's child (the `_runtime` copy), not one entry per pass;
    - D4c: `managed` comes from the instance's own `activeWorktree`, so a D4a child running
      inside its parent's managed worktree (no worktree of its own) refuses a grandchild with
      the user-checkout error instead of checkpointing; it must classify the _checkout_ it
      shares, not its own config;
    - MCP: `workflow_status` exposes `childRun` only for queue steps, not a finalStep child;
      `read_output` hand-builds the workflow `PriorContextItem` instead of reusing the
      resolver's construction.

- **Round 6 (reviewed 2026-11-27): round-5 gaps and D13.** Every step committed what it was
  asked for; `npm test` green (8507 extension, 4926 UI) before the review fix. The review
  (three parallel reviewers over the diffs) found real defects in the D13, stop/pause and CLI
  work; they are round 7's first four steps.
  - `3c4226bce`: D6 from a real resume. Root cause: `PromptQueue.markPromptCompleted` recorded
    `completedAt`/`terminalStatus` only for prompt and script steps, so a cancelled workflow step
    reloaded as pending behind `currentIndex` and was skipped. It now records them for every
    kind, and `rewindCancelledSubWorkflowStepForContinuation` returns a stopped run's
    cancelled sequential workflow step with a recorded child to pending (from
    `executeContinuationAtRun` and `resume()`'s STOPPED branch). Executor D6 branch tests, a
    launcher continuation-rejection test, a seeded re-run test; the executor reads manifests
    and settlements through `OutputHistoryManager` (`readRunManifest`,
    `hasSubWorkflowSettlement`) and no longer constructs `TimelineRecorder`.
  - `f522e1b16`: two load-sensitive tests hardened (`SecretRedactionMiddleware` binds
    127.0.0.1; `StepCommands` teardown retries).
  - `b9e9232e9`: the four real-instance propagation cases, finally. Root causes fixed: a
    script or workflow step at index 0 always stopped through the 10 s fallback (startup
    attaches an integration to the first target; the executor now clears it for non-prompt
    steps); a paused child failed the parent with "unexpected state: paused" (the launcher
    waits through a pause, `whenExecutionSettled`); resuming a PAUSING parent never resumed a
    PAUSED child (the handle now calls `resume()`). Stop tests fail on the fallback warning.
  - `101d05010`: CLI child progress prefixed with the nearest child workflow name, compiled-CLI
    parent → child → grandchild test, exit-code tests, `subWorkflowRuns` rebuilt from
    `subWorkflowSettled` events (one per pass).
  - `eacc6d14e`: D4c classifies the checkout through managed-worktree ownership records
    (`findManagedWorktreeRecordForCheckout`), MCP `workflow_status` reports the latest
    finalStep child with its pass, `read_output` builds workflow items through
    `RunOutputResolver.resolveWorkflowPriorContextItem`.
  - `2ff595e64`: D13 part 1: `InlineSubWorkflowDefinition`, `isInlineSubWorkflowDefinition`,
    `getSubWorkflowDisplayName`, schema `inlineSubWorkflowDefinition` (no schema bump: it
    widens a field that has not shipped), parser boundary validation, R10 exclusions.
  - `ac4d88c36`: D13 part 2: `materializeInlineSubWorkflow`
    (`src/utils/InlineSubWorkflowMaterializer.ts`), `PromptFileLoader.loadFromMemoryOrThrow`,
    `SUB_WORKFLOW_SOURCE_KINDS.INLINE` launch source, inline D6 reattach and D4c, docs and
    CHANGELOG.
  - `e2c4f2934` (review fix): `2ff595e64` made `getWorkflowStepText` return the step name, so
    the dashboard's enabled toggle wrote the name into `workflow` (a named file step lost its
    path, an inline step became a string), MCP reported the name as `workflow`, and runtime
    identity keyed on the name. It returns content again; labels use
    `getSubWorkflowDisplayName`.
  - **Found in review, not yet fixed** (round 7 steps 1–4):
    - D13 launch: an inline child without `worktree` runs in the main checkout under a
      worktree parent (`loadFromMemoryOrThrow` skips the D4a `parentExecution` move
      `loadPromptFile` does); the materializer's key list omits `sandbox`/`sandboxMode`/
      `priorContextDetail` (derive it from `EXECUTION_PROPERTY_KEYS`), copies every inline key
      (`enabled`, `color`, `onFail`, `_runtime`, …) to the child root, leaves `worktree` on the
      step, and its `resumeSession`/`priorContext` deletion is dead code; `trustedExternalRoots`
      is the user/workspace approvals, not the parent's effective set; the lineage name goes
      through `path.basename` (a step named `check src/core` becomes `core`) and a finalStep
      child is named `step <N+1>` on every pass instead of through `FinalStepLabels.ts`;
      `resolvedWorkflowPath` stores the display name; relative prompt-file references in an
      inline prompt may resolve differently in the child; no end-to-end `--var` test; the docs
      promise inherited permissions, untrue for sandbox.
    - D13 validation: the inline arm admits `_runtime` (an authored `_runtime.sessionId` would
      resume a session in the child); the boundary regex checks only `prompt` (not
      `retryPrompt`/`passRetryPrompt`), misses `$allFinalStep`, and flags references in code
      fences and after a letter; `priorContext` keywords `all`/`finalStepAll`/
      `finalStepPrevious` pass; `VarSubstitutionPolicy.test.ts`'s excluded-path check was
      weakened from segment matching to exact equality.
    - Stop/pause: `cancelPause` on a PAUSED child awaits the child's whole remaining run, so the
      parent's persisted state stays `pausing` until the child finishes; a stop or pause while
      `host.launch` is still running reaches no handle, so the child keeps running after the
      parent confirms STOPPED; a PAUSED child that is disposed never settles `done`; the
      settle check tests `=== PAUSED` rather than the active states; the continued child skips
      its own cancelled step (see Decisions); no test for a finalStep pass stopped mid-child.
    - CLI: `subWorkflowRuns` has one entry per `subWorkflowSettled` event, so a retried step or a
      stopped-then-continued child appears twice; in-flight children vanished from the JSON
      (`f14e72cc5` listed them with `status: null`); entries look up the current step list, not
      the event's step definition; the child reporter in `src/cli.ts` is a slimmed copy of the
      root handlers (no harness/model headers, pass labels, parallel headers or retry tallies);
      a nameless file child is labelled `child workflow`; the `onFail: continue` test does not
      prove the child ran and failed.
    - MCP: `readQueueSubWorkflowOutputs` and `readLatestFinalStepSubWorkflowOutput` each read
      the whole timeline, duplicating `RunOutputResolver`'s `subWorkflowRuns` projection, with
      casts and an `"target" in event` check; the read_output parity test compares the resolver
      with itself.
    - D4c: `findManagedWorktreeRecordForCheckout` matches on path only, unlike the existing
      discovery code that also requires the branch and skips prunable entries, so a stale record
      can make a user's worktree count as managed and get a checkpoint commit; the
      `WorkflowInstance` wiring has no test (the real-git test passes `managed: true` by hand),
      no realpath (`/var` vs `/private/var`) or negative case, and git errors are swallowed
      without a log.

- **Round 7 (reviewed 2026-11-27): round-6 gaps and parallel member acceptance.** `npm test`
  green (8544 extension, 4926 UI). Three parallel reviewers went over the diffs. Four of the five
  steps did what they were asked; the CLI/MCP/D4c step (codex) did about half of it and added
  none of its tests. Gaps are round 8.
  - `77de5308d`: D13 launch. `inheritParentExecutionRoot` (`WorkflowInstance.ts`) is the one D4a
    rule for file loads, inline loads and D6 continuations (continued file children had skipped
    it too). The materializer derives inherited keys from `EXECUTION_PROPERTY_KEYS` minus
    `sessionId`/`resumeSession`/relative `priorContext`, builds from the parent's authored
    (unresolved) definition, keeps the inline step's keys on the child's step and moves only
    `worktree` to the root. `InlineParentDefinition` gives the child the parent's
    `sourceDefinitionPath` (references and trust resolve from the parent's file) and declared
    `trustedExternalRoots`. Lineage name is exact (`<parent> · step N`,
    `<parent> · final step pass N` through `formatFinalPassPhrase`). No `resolvedWorkflowPath` for
    inline children. End-to-end `--var` test (substituted once).
  - `04b0ca1c0`: D13 validation. `_runtime` rejected in the inline arm (schema, parser,
    `isInlineSubWorkflowDefinition`); the boundary check uses `parseInlinePriorContextRefs` over
    `getPromptReferenceTexts` (the list `StepReferenceShifts` uses), which is the same masked
    parser runtime uses; `PRIOR_CONTEXT_KEYWORDS` for `priorContext`; segment matching restored
    in `VarSubstitutionPolicy.test.ts`.
  - `98345e880`: stop/pause. `cancelPause` no longer awaits the child's run;
    `SubWorkflowControlRelay` (`src/core/orchestration/SubWorkflowControlRelay.ts`) records a
    stop/pause that arrives during `host.launch` and replays it on attach (a pause that reaches a
    still-IDLE child is held until it runs); `SubWorkflowInstance.onDidDispose` settles a disposed
    PAUSED child CANCELLED; the settle wait uses the active states;
    `rewindCancelledStepForContinuation({ anyStepKind })` re-runs a D6-continued child's
    interrupted step (top-level continue unchanged); finalStep pass reattach pinned.
  - `751ca46dd`: partial. `subWorkflowRuns` dedups by step/pass and `runRef` and lists in-flight
    queue children; MCP `workflow_status`/`read_output` read the resolver projection (no casts);
    `findManagedWorktreeRecordForCheckout` checks branch, prunable and realpath. **Not done:**
    the single-sourced CLI reporter, and every requested test (items 1, 3, 4).
  - `3f2dd823f`, `35921c171`: parallel members part 1. `isParallelMemberSource`; preflight
    sub-workflow branch (`prepareSubWorkflowLaunch` shared with sequential steps; a FILE launch
    source may carry `parsed`); per-member failures under `onFail`; D4c once per group with
    `parentCheckoutPrepared` members skipping the launcher's check; required
    `SubWorkflowLaunchRequest.concurrent`; real-instance lanes, stop-every-lane, fail-fast and
    real-git group D4c tests; docs section "Parallel sub-workflow steps".
  - `d61476b83` (review fix): MCP `workflow_status` kept the _first_ settlement of a finalStep
    pass (`>` instead of `>=`), so a continued finalStep child reported its stale cancelled
    outcome.
  - **Found in review, not yet fixed** (round 8):
    - CLI JSON: `subWorkflowRuns` reads `stepId` from the settlement's step definition, which is a
      snapshot with `_runtime` stripped (`stripStepRuntime`), so **settled queue children are
      never built from events**; entries come only from current `_runtime`, a retried step's
      earlier child vanishes, and `status` is the parent step's `terminalStatus`, not the child's
      `outcome.status`. The finalStep in-flight entry is always `status: null` and may report the
      previous pass's child under the current pass. None of the four requested regression tests
      exist; the existing unit test passes only because its fixture sets `_runtime`.
    - CLI reporter still a slimmed copy of the root handlers (`src/cli.ts` ~929-990).
    - MCP: no two-pass or same-pass-continued finalStep test, no real `read_output` parity test;
      `workflow_status` reads the timeline twice (scanner + projection).
    - D4c: `findManagedWorktreeRecordForCheckout` adds a third inline copy of the branch-plus-path
      matching (`WorktreeManager.ts` ~797, ~1876, ~1947); `resolveRepositoryContext` is outside
      its try and the `WorkflowInstance` caller still swallows with `.catch(() => undefined)`;
      none of the stale-record, main/named, realpath or wiring tests exist.
    - Stop/pause: the D6 continuation path is unprotected. The handle returns once
      `loadWorkingFile` binds identity, before `executeLoadedPromptFile`'s startup guard, and the
      child is then STOPPED/PAUSED, not IDLE, so a stop takes the 10 s fallback and can skip the
      rewind, a pause is lost (parent stuck PAUSING), and `cancelPause` can start a second
      `resume()` beside the continuation's own. The dispose listener subscribes after
      `await execution`, so a dispose before the settle wait is missed and `done` can hang. The
      relay is registered after `resolvePath`, so a stop during it takes the fallback and still
      launches. `subWorkflowSettled` records FAILED for a stopped-while-loading child whose step
      settles CANCELLED. The relay's `forward` copies `forwardSubWorkflowControl`. Missing tests:
      stop before launch, stop while launch throws, pause-then-stop before attach, real
      `dispose()` firing `onDidDispose`, stop/pause during a D6 continuation.
    - Parallel: the prepared-member cache is not cleared when group preflight throws (cleared
      only in the group run's `finally`), so a fixed child file or a fixed invalid child stays
      cached across Continue; the once-per-group D4c check runs even when the group does not fan
      out (width 1: an earlier member's edits are never checked before a later lane branches,
      which is P6); `concurrent` is recomputed from live `dynamicQueueConfig` rather than the
      group's `preflight.effectiveWidth`; a fixed `setTimeout(300)` in the stop-every-lane test.
    - Parallel: a fail-fast-cancelled lane resolves CANCELLED and D9 then stops the parent
      (STOPPED) instead of failing it; `cancelledBy` is recorded but the join never reads it.
    - D13: a `{{var}}` in an inline step's `name` stays literal in the child's lineage name (the
      materializer reads the run-start step; `steps[].name` substitutes at dispatch); a parent
      with no source file (template, prompt string, MCP) gives the child its own display name as
      trust identity, so workflow-scoped approvals don't reach it; no test of D4a or the
      source-path restore through `executeContinuationAtRun`; the missing-asset warning resolves
      an inline child's relative paths from the workspace; `ParallelGroupTopology.ts` still scans
      only `step.prompt`; `getPromptReferenceTexts` has an unused `script` parameter; the
      sanitizer silently turns an inline `workflow` carrying `_runtime` into the text form; the
      dotted exclusions in the restored policy test can never match (paths are view-relative).

- **Round 8 (reviewed 2026-11-27): round-7 gaps and the lane join rule.** `npm test` green
  (8595 extension, 4926 UI). Three parallel reviewers went over the diffs. The six `claude-cli`
  steps did what they were asked; the D13 step (codex) fixed most of the code but added few of
  its tests, and its trust-identity fix introduced a bug. Gaps are round 9.
  - `b440dcf53`: `subWorkflowSettled` records the queue step's `stepId` (optional; older events
    fall back to the index); `SubWorkflowSettlements.ts` selects one entry per child run for
    both CLI `subWorkflowRuns` and MCP; `status` is the child's `outcome.status`; in-flight
    finalStep children only for the running pass; fixtures built with `TimelineRecorder`;
    `workflow_status` reads the timeline once (`scanQueueStatusMetadata`); a real `read_output`
    parity test against `PriorContextPreviewBuilder`.
  - `53db230b7`: `CliRunProgressReporter` reports the root and every child through the same
    handlers (`applyCliLinePrefix` is the one prefix rule); children get harness/model headers,
    pass labels, parallel headers and retry tallies; a compiled-CLI test pins the root's exact
    output; stronger `onFail: continue`, nested and finalStep-child compiled tests.
  - `746238e02`: `gitWorktreeEntryMatchesManagedRecord` shared by the checkout lookup and both
    discovery paths (recoverable discovery now skips prunable entries; stale discovery treats a
    bare `prunable` line as stale, both intended); one `Log.warn` and "not managed" on any
    failure; real-git stale/prunable/main/named/symlink tests and a `WorkflowInstance` wiring test.
  - `4dfb23edb`: dispatch-substituted lineage name; parent trust identity through
    `InlineParentDefinition`; missing-asset base from the parent's path; `ParallelGroupTopology`
    through `getPromptReferenceTexts`; the sanitizer rejects an inline `workflow` with
    `_runtime`. Tests only for the topology and sanitizer items.
  - `b6dbb8268`: stop/pause/cancelPause held until the child's execution cycle starts (fresh
    and D6 launches, one mechanism); dispose watched from creation; the relay registered before
    the step's first await; one result mapping for step and `subWorkflowSettled`; one exported
    `forwardSubWorkflowControl`; a settled handle ignores further controls.
  - `aaa9c939b`: the prepared-member cache is scoped to one group dispatch; a member re-parses
    at claim if its file changed; group D4c only at effective width > 1; `groupEffectiveWidth`
    drives `concurrent`; condition wait in the stop-every-lane test.
  - `d6095b6d8`: a lane cancelled by its parent never requests the parent's stop (fail-fast
    fails the group under the failing member's `onFail`); a directly stopped lane lets siblings
    finish and the group returns stopped (`stopsWorkflowAtJoin`, in memory); Continue re-enters
    such a group and reattaches the stopped lane through D6.
  - `c46238928` (review fix): the diff tests restored `getBoundingClientRect` by assignment,
    leaving an own property on `HTMLElement.prototype` that hid `HarnessDropdown.test.tsx`'s
    `Element.prototype` spy when files shared a worker (`stubBoundingClientRect`).
  - **Found in review, not yet fixed** (round 9):
    - Registry vs launcher (bug): children are registry instances, and the registry retires and
      disposes any unviewed instance it sees COMPLETED/ERROR/STOPPED. `restoreFromWorkingFile`
      emits the restored STOPPED/ERROR state during a D6 continuation's load, so in VS Code the
      child can be disposed mid-load, `done` settles at once (the parent stops again or fails),
      and the disposed child's execution keeps running without a lock heartbeat; a later
      Continue can put a second executor on it. "Disposed while RUNNING settles CANCELLED" is
      unsafe for the same reason. Integration tests bypass the registry.
    - Join rule across a restart (bug): `stopsWorkflowAtJoin` is in memory only. A lane stopped
      directly, then a host restart while a sibling still runs: the reloaded run is STOPPED
      inside the group, `rewindCancelledStepForContinuation` checks `currentIndex-1` (before the
      group), recovery returns a plain CANCELLED, and the group joins and advances without the
      lane. Derive it from persisted state instead.
    - Join rule gaps: an ad-hoc-promoted anchor that is a workflow step takes the sequential path
      (stops the parent on fail-fast or a direct stop); under `anyStepKind` a group's cancelled
      prompt members are not rewound, so a D6-continued child skips them; a fixed
      `setTimeout(200)` in `waitForChildPausedCycle`.
    - D13 (bug): the child's `sourceDefinitionPath` is set to the trust identity, which is also
      the reference base, the append-rebasing destination and the `ancestorPaths` fallback. A
      template parent ("Review loop") gives a child that resolves `./x` from the process cwd,
      and a restored parent's working-file path makes its run directory a reference base. The
      executor rebuilds the trust rule a third time. Missing tests: the executor's name
      substitution end to end, a no-file parent's trust identity, a D6-continued inline child
      in a managed worktree resolving a parent-relative reference, the missing-asset base; the
      dotted-exclusion test is tautological; `getPromptReferenceTexts` was widened to
      `step: object` with a cast; other non-inline objects still become the text form.
    - CLI/MCP: child identity is `runRef` alone in `SubWorkflowSettlements.ts` and the builder
      (`RunRef` is unique only within one lineage; two lanes starting in the same millisecond
      collide), so key by `workflowKey` + `runRef`; a continued child still running shows its
      earlier `cancelled`; an old event whose index no longer holds a workflow step is dropped
      by the CLI but kept by MCP; the event → settlement conversion is written twice; the
      nameless-child label prefers the key slug over the file name (the docs say file name);
      child subscriptions live until the root's release; no MCP test for the `stepId` lookup
      after a reorder.
    - D4c: three more branch-plus-path copies (activation discovery, `currentOwnership`,
      `reconcileBlockedManagedWorktrees`) that deliberately allow prunable entries; no test
      that the warning is logged once.
    - Landing step 2 promised a start error for a worktree child of a worktree parent until
      D4b; the code gives none and branches from the main checkout, so a D4c checkpoint on a
      managed parent is missing from the grandchild's worktree. Decision below.

- **Round 9 (reviewed 2026-11-27): round-8 bugs, D4b, and the lane merge path.** All six
  `claude-cli`/`opus` steps did what they were asked and committed tests; `npm test` green (8638
  extension, 4926 UI, packaging). Three parallel reviewers went over the diffs; no review fix
  was committed this pass (every finding needs a failing test first and is round 10's first
  three steps).
  - `365efda94`: the launcher owns a child from creation until `done` settles
    (`releaseInstance`); the registry's retire, `unregisterClient` and `createWorkflow` paths skip
    owned ids; a child disposed while RUNNING is stopped and awaited before `done` settles
    (CANCELLED, `cancelledBy: "child"`); a PAUSED child is not stopped on dispose; `stop()` on a
    disposed instance confirms STOPPED directly. Real-registry D6 tests for STOPPED and ERROR
    children, host-dispose marker test.
  - `d3032d9e7`: `rewindCancelledStepForContinuation` re-enters a group open at the head as well
    as one that joined just before it, from persisted state only (cancelled + `childRunRef`); an
    adopted anchor follows the group rule (membership from the step's group; fail-fast now
    cancels adopted members too); `anyStepKind` rewinds every cancelled member; condition wait
    in `waitForChildPausedCycle`.
  - `b7f0e51a7`: an inline child's trust identity is its own field, read only by
    `getWorkflowTrustSourcePath()` and the harness trust path (`workflowTrustSourcePath` on the
    execution context and `WorkflowContext`); its `sourceDefinitionPath` is the parent's
    (undefined for a no-file parent); empty substituted names fall back to the default label;
    `isExcludedPolicyField`; structural `getPromptReferenceTexts`; the sanitizer throws for any
    non-string `workflow` that is not a valid inline definition.
  - `fd379ec9d`: children keyed by `workflowKey` + `runRef` (`subWorkflowChildKey`); a settlement
    older than the running step's `startedAt` is ignored (continued child shows `null`);
    `attributeSubWorkflowSettlements` and `toSubWorkflowSettlement` single-source the old-event
    rule and the event conversion; MCP `read_output` reads settlements through
    `RunMetadataScanner.findSubWorkflowSettlements`; the CLI label prefers the file name and a
    child's subscriptions are released on settle; `gitWorktreeEntryIsRecordCheckout`.
  - `555dba694`: D4b. A child with a parent link uses the parent's execution checkout as its
    source checkout (`prepareExecutionWorktree`; `workspaceCheckoutRoot` maps workspace folders
    into it); the worktrees root comes from the main checkout (`worktreePlacementCheckout`);
    the merge lease carries the delegation chain (held on `WorktreeInfo`); inline children that
    create a worktree get the parent file mapped into the parent's checkout
    (`inlineParentReferenceBase`). Docs table and two CHANGELOG **Changed** entries.
  - `17702aa39`: `MERGE_INTO_SHARED_ROOT` (`MERGE_INTO_SHARED_ROOT_GUIDANCE`; `worktreePlan`
    replaces `createsWorktree`; a `worktree: false` child counts as editing only when the parent
    runs in the main checkout); D6 recovery of in-flight lanes needed no code change, pinned by
    real-git reload and crash tests.
  - **Found in review, not yet fixed** (round 10 steps 1–3):
    - Dispose hang (bug, medium): a child disposed during a sequential AI prompt step never
      settles `done`. `dispose()` disposes the integration, which removes the
      `onResponseComplete` listener `waitForResponseComplete` relies on; a top-level step has no
      abort signal; `stop()` on the disposed instance confirms STOPPED without waking the
      executor, so `endDisposedExecution` waits forever and the id stays launcher-owned. The
      host-dispose test uses scripts only.
    - Join marks (bug, low): `membersStoppingWorkflowAtJoin` is never cleared at cycle start or
      when a step is reset, so a stale mark from a previous cycle can make a re-run anchor that
      a sibling cancels stop the parent at the join instead of failing it. The rewind checks the
      joined group before the open one (check the open one first). A released child that is not
      in a spent state (IDLE, PAUSED) stays in the registry until shutdown. No tests for the
      `unregisterClient`/`createWorkflow` ownership guards or for fail-fast against an adopted
      _prompt_ anchor (it runs outside the group's abort signal and may settle COMPLETED/FAILED).
    - Worktree record on a direct resume (bug): a child run continued on its own (its own row,
      `ctrlyoke run --run`) has no parent link, so it passes the main checkout as
      `sourceCheckoutRoot`; `ensureManagedWorktree` matches records by
      `sourceCheckoutRoot` + identity, misses the record that names the parent's worktree, and
      `writeRecord` overwrites it with main's base and target, so a later `merge: true` lands in
      main. Blocked or failed-setup child records are skipped by
      `discoverRecoverableManagedWorktreesIn`/`reconcileBlockedManagedWorktrees` (they filter
      on `sourceCheckoutRoot`) once the parent's worktree is gone. Missing tests: a
      managed-parent merge lane resumed after a crash (stale lease reclaim + record match),
      `parentRunsInMainCheckout` in the executor and the preview, a top-level run in a linked
      user worktree, `workspaceToSourcePathMapper` with a subfolder state root.
    - D13: the D6 continuation test never makes the _continued_ child resolve a `./` reference
      or check its trust identity (removing the re-adopt in `executeContinuationAtRun` would
      still pass); `isInlineSubWorkflowDefinition` accepts `{}` and `{ name }`, and `null`
      gets the "single prompt or script step" message; `HarnessAdapterUtils` repeats the trust
      fallback; the execution preview of an inline child has no `./` base and keys trust by its
      working copy (pre-existing).
    - Nits: `MERGE_INTO_SHARED_ROOT` fires at `maxParallelSteps: 1` (spec gives no exemption;
      document it); a misplaced doc comment above `HEADLESS` in the integration test.

- **Round 10 (reviewed 2026-11-27): round-9 gaps, the sibling merge wait, D14's MCP surface.**
  All six `claude-cli`/`opus` steps did what they were asked, with tests; `npm test` green (8713
  extension, 4926 UI, packaging). Three parallel reviewers read the diffs. Review fix
  `e7301ccda`: the docs, tool description and CHANGELOG claimed author-written workflow steps
  are never editable through `edit_step`, but the rule is by shape (Decision below); the
  `mcp-tools#append_step` anchor (VitePress slug `append-step`); a stop-path comment.
  - `33ac7cfc6`: an instance-lifetime abort signal on the top-level execution context, aborted
    by `stop()` on a disposed instance, so a child disposed mid-prompt settles CANCELLED
    (`cancelledBy: "child"`) and is released; each sequential step runs under its own abort
    signal, which a group's `cancelTarget` aborts, so fail-fast settles an adopted _prompt_
    anchor CANCELLED (it settled COMPLETED); join marks cleared on claim and pruned at cycle
    start (`pruneStaleJoinMarks`, keeps marks whose step is still CANCELLED); rewind checks the
    open group first; released IDLE/PAUSED unviewed children retired; ownership-guard tests;
    `commitSequentialOutcome` confirms a stop when a promoted anchor settles with no group run
    (it stuck in CANCELLING).
  - `a94526ba5`: records looked up by `workflowKey` + `runRef`; the recorded source checkout,
    base and target win on resume; a start fails naming a recorded source checkout that is gone
    (`assertRecordedSourceCheckoutExists`); `managedRecordDescendsFromCheckout` lets reclaim and
    failed-setup cleanup reach child records; real-git tests for a direct child continue, a
    crash-resumed merge lane, `parentRunsInMainCheckout`, a linked user worktree and a subfolder
    state root; CHANGELOG **Fixed** (released top-level runs continued from another checkout).
  - `cacab7606`: `describeInvalidInlineSubWorkflowDefinition` is the one inline-shape rule
    (type guard, parser, sanitizer, continuation; `workflow: null` no longer crashes the parser);
    `resolveWorkflowTrustSourcePath` single-sources the trust fallback;
    `WorkflowOrchestrator.getViewDefinitionSources` gives the preview a live inline child's
    reference base and trust identity; `substituteInlineStepName`; a D6-continued inline child
    re-runs its `./` prompt with the parent's base and trust identity.
  - `eac1d3d09`: D4d sibling merge wait. `EXECUTION_LEASE_PURPOSES.MERGE`,
    `WORKTREE_MERGE_LEASE_WAIT_MS`, `ExecutionLeaseConflictError.conflictingLeases`, bounded
    backoff only for same-delegator merge leases; a chained merge skips the pre-lease guard (the
    post-lease guard runs the same closure). The step found the real serialization point is
    `completeManagedRun`'s repo-wide mutation lock, and raised its wait for chained `merge: true`
    lanes from 5 s to 120 s (Decision below).
  - `f82a1b473`: D14 part 1. `worktreePresets` (schema, `ManagedWorktreeConfig`/`WorktreePresets`
    types, R10 exclusion, loader/parser/sanitizer), `McpNamedPresets.ts` shared by both preset
    resolvers, `workflow_status` `metadata.worktreePresets`, `append_step` `worktree: { use }`
    wrapping (flat and parallel; `inlineRunBoundaryErrors` checked at append time), real-MCP
    real-git lane test, docs and CHANGELOG.
  - `c79e59460`: D14 part 2. `edit_step` lane edit/switch/wrap/unwrap (`agentLaneParts`; the step
    id survives a kind change), `parallelWithCurrent` merge-lane refusal in both directions
    (`mergeIntoSharedRootIssueAmong`, pending members count), ungated-lane warning, running
    children reported in `workflow_status` `childRun`.
  - **Found in review, not yet fixed** (round 11 steps 1–3):
    - Stop of a PAUSED run whose head is inside a parallel group sticks in CANCELLING
      (pre-existing, affects released top-level runs): a paused group returns and no coordinator
      remains, but `confirmStopped` in `WorkflowInstance.stop()` defers whenever
      `getCurrentParallelGroup()` is set. No test covers it. A paused-then-disposed child
      inside a group has the same shape.
    - Missing tests: the new CANCELLING confirm in `commitSequentialOutcome`; retiring a released
      PAUSED child (only IDLE is tested; the pause must stay on disk and continuable).
    - `getViewDefinitionSources` matches the live instance on `workflowKey` alone; the code
      beside it gates on `sameViewAddress` (run too), so an older run's preview can take the live
      run's trust identity.
    - D14: `edit_step` can turn a pending member of the running group into a `merge: true` lane
      beside an editing member (the join refusal runs only in
      `appendStepsToActiveParallelGroup`); a kind-change edit keeps `stepId` but drops
      `rewoundFailure`, which protects a rewound failed step from remove/reorder; the join check
      decides "parent runs in the main checkout" from `_runtime.worktree === undefined` while the
      executor compares `executionRoot` with `stateRoot` (single-source it); no Save As/export
      test with `worktreePresets`; the runtime refusal message still says "a workflow step the
      workflow author wrote".
    - Merge wait: the lease wait is effectively unreachable in production (every chained merge
      runs inside the mutation lock), so its tests drive `mergeManagedWorktree` directly; the
      lock-wait change has no test that a sibling holding the lock past 5 s still lands, or that
      chainless and non-merge settlements keep 5 s; the 120 s lock wait takes no abort signal,
      so stopping the parent while a lane waits stalls up to 120 s.
    - Low, left: failed-setup cleanup treats a source checkout on an unmounted drive as gone
      (only BLOCKED + FAILED records with no live lease, branch deleted only if untouched);
      `substituteInlineStepName` drops an intact name when another field fails (cosmetic; the
      step fails anyway); join marks keyed by index (no edit path moves settled steps); a file
      child counts as neither editor nor merger at join time (as in preview).

- **Round 11 (reviewed 2026-11-27): round-10 gaps, lanes for agents and users.** All five
  `claude-cli`/`opus` steps did what they were asked, with tests; `npm test` green (8739
  extension, 4945 UI, packaging). Three parallel reviewers read the diffs. The live dashboard
  check the round's step 5 could not run (no Playwright in its session) was done in review:
  an authored two-lane group renders Workflow and Worktree badges and inherited harness/model
  per lane (a lane with its own `harness: codex-cli` shows Codex). Review fix `6f440a65b`: the
  agent's integration step now merges only lanes ending `conflict`/`blocked`/`abort-failed`
  (a lane with no changes has no `mergeOutcome` and maybe no branch), finds lanes by name, and
  makes every member of a merging-preset group a lane; docs/CHANGELOG no longer promise the
  worktree is kept when a stop ends the lease backoff (the lane has already landed and removed
  it); two misleading test comments.
  - `2a4238d26`: `WorkflowExecutor.hasLiveExecution()`; `stop()`'s `confirmStopped` defers only
    while the loop or a group run is live, and a PAUSED run with nothing in flight confirms at
    once (it stuck in CANCELLING; CHANGELOG **Fixed**); Continue re-enters the group; tests
    for the promoted-anchor confirm and retiring a released PAUSED child;
    `getViewDefinitionSources` gated on `sameViewAddress`.
  - `e0cfc94ff`: `edit_step` runs the `MERGE_INTO_SHARED_ROOT` join refusal for members of the
    running group (only edits that create a new conflict for that step); `carryQueueSlotRuntime`
    (`StepIdentity.ts`) carries `stepId` and `rewoundFailure` across a kind change;
    `runsInMainCheckout(executionRoot, stateRoot)` single-sources the rule for executor, preview
    and both RunContinuationService checks, with MCP passing `CTRLYOKE_EXECUTION_ROOT`; refusal
    wording; Save As keeps `worktreePresets`.
  - `a4731feb3`: injectable lock timeouts; real-git tests that a merging lane outlasts the short
    timeout and that chainless and non-merge settlements keep it; `withFileLock` takes a
    `signal` (`FileLockAbortedError`; the first attempt always runs, so a free lock is still
    taken); `stop()` aborts a settling lane's lock wait and merge-lease backoff
    (`waitForRetryDelay`), recording merge `blocked`; a lock timeout on a merging lane also
    records `blocked`.
  - `9623bd7e3`: orchestrator agent "Lanes" / "Shared-tree members" guidance, `committed` scoped
    to shared-tree members; `spec-driven-loop` declares `worktreePresets.lane` (`merge: true`,
    `setup: "{laneSetup}"`, default `npm ci`); CHANGELOG **Changed** (the template shipped in
    0.2.0).
  - `dcb55cafa`: lane rows show inherited harness/model and a worktree badge (branch once known);
    a COMPLETED lane with a `conflict`/`blocked`/`abort-failed` merge shows a warning badge
    (`subWorkflowDisplay.ts`, labels in `SUB_WORKFLOW_DASHBOARD_LABELS`); the settlement block is
    no longer dropped when a status activity shares its step (`isSubWorkflowSettlement`); CLI
    `--json` `subWorkflowRuns[].worktree` (additive).
  - **Found in review, not yet fixed** (round 12 steps 1–3):
    - Skill-mode MCP (bug, regression from `e0cfc94ff`): `runMcpToolCli` (`mcp-server.ts`
      ~3071) sets `CTRLYOKE_EXECUTION_ROOT` to `process.cwd()` when no `--execution-root` is
      given, and skill command lines pass it only for the coordination tools, so `edit_step` /
      `append_step` in skill mode take the agent's shell directory as the run's root. A run in
      the main checkout driven from `<repo>/src` then admits a merging lane beside a
      `worktree: false` member. The doc comment on `launchedExecutionRoot` says the opposite.
      No MCP test sets the variable; the edit path's `executionRoot` argument is untested.
    - Idle-pause stop (bug): the new PAUSED branch in `stop()` still runs
      `markInFlightPromptCancelled()` and `cancelAttempt(...)` before confirming, so a completed
      group member at the head is likely shown CANCELLED, and a sequential paused run's next
      (never started) step is cancelled and skipped on Continue (`finalizeCancelledPromptAfterStop`).
      Pre-existing after the 10 s detector, now instant. It should mirror the
      `preDispatchStartup` branch: nothing cancelled, nothing skipped. A stop landing just as a
      group pauses still waits the 10 s detector (state ends right; spurious warning).
    - Settlement paths that ignore the stop signal (bug): `WorkflowStartupPipeline`
      `settleProvisionedWorktreeAfterEarlyFailure` (~1488) and
      `releaseReservationsAfterSetupStop` (~1526) call `completeManagedRun` directly, so a
      `merge: true` lane stopped during its `setup` (likely with the template's `npm ci`)
      waits up to 120 s behind a sibling and a second Stop can't end it; the merge/keep-from-config
      logic is copied at four call sites. The stopped-merge message (`WorktreeManager.ts` ~416)
      says the worktree is kept, false on the lease path. `FileLockUnavailableError` before the
      lock is held gets no `mergeOutcome`. The "still lands" test starts its 1 s clock before
      the waiter reaches the lock, so it can pass without the fix under load.
    - Dashboard: a lane's harness colour differs between the steps list and the output
      blocks/chip rail (`outputRows.ts` `getEffectiveStepHarness`, `StepChipRail.tsx`
      `getChipHarnessId` still give a workflow step no harness); a finished lane's harness/model
      follow later workflow-setting changes instead of what it ran with; no panel-level
      inheritance test; `hasInlineWorktree` and the inline title re-derive
      `classifySubWorkflowWorktree` and `getSubWorkflowDisplayName`; `CliJsonSubWorkflowRun.worktree`
      is typed from an internal Pick (give the public contract its own interface); at the
      default steps-panel width (240 px) the two badges squeeze a lane's name to "L…"
      (seen live); a named worktree's badge could show its branch from the definition;
      no `ABORT_FAILED` severity case or "no badge unless COMPLETED" test.
    - Low, left: CLI `step edit` and the preview pass no execution root, so an inherited child
      counts as in the main checkout (errs toward refusing); a never-held lock's `blocked()`
      writes the record outside the lock (pre-existing); the hand-written manifest poll in
      `subWorkflowHost.integration.test.ts` (a third copy of that deadline loop).

- **Round 12 (reviewed 2026-11-27): round-11 gaps, landing steps 4 and 5.** All five
  `claude-cli`/`opus` steps did what they were asked, each gated by the `committed` preset;
  `npm test` green (8769 extension, 4959 UI, packaging). Two parallel reviewers read the core
  and worktree diffs; I reviewed the dashboard commit and checked it live (Playwright, 1280 px,
  default panel widths). Review fix `a14bc5ba3`: the blocked-merge dashboard reason no longer
  says the worktree is kept; the authored-waves tests compare wave-1 branches as a set (lanes
  settle in either order); the second-stop settlement test waits 60 s, not 10 s, for a real
  worktree add; the inheriting-members test no longer claims to prove rule 2.
  - `b9c108715`: skill-mode MCP sets `CTRLYOKE_EXECUTION_ROOT` only from `--execution-root`
    (an inherited value is dropped); stopping an idle PAUSED run cancels and skips nothing, and
    a stop landing while a pause unwinds waits (capped 5 s) for it; CHANGELOG **Fixed**.
  - `55b32c173`: every managed settlement goes through the stop-abortable
    `settleManagedWorktree` (`managedWorktreeSettlement(config)` single-sources merge/keep);
    separate stopped messages for the mutation-lock wait and the merge-lease backoff;
    `FileLockUnavailableError` records merge `blocked`; `mutationLockOpen` test seam.
  - `0462eecdb`: `resolveEffectiveStepHarness` colours a step in the list, chip rail and output
    alike; pending rows honour `ui.harnessColors` (CHANGELOG **Fixed**, a 0.2.0 bug); a lane
    with a child run marks its harness/model "(expected)"; a named lane shows its branch from
    the definition; `CliJsonSubWorkflowWorktree` is its own interface; `landingOutcome` values
    in `docs/cli/ci.md`.
  - `b1021b815`: D4d rule 2 (`isInheritingSibling`: delegated leases with the same immediate
    delegator, never a merge lease); real-git tests of inheriting members of a managed parent
    (and their D6 reattach) and of nested fan-out (lanes merge into the child's worktree, the
    child into main, chains `[P]` / `[P, C]`). Blocker P10 did not exist: inheriting children
    take shared-native leases, already compatible, so rule 2 only governs exclusive delegated
    leases (none exist today besides merge leases, which it excludes).
  - `59652e3b0`: `WORKTREE_COLLISION` (whole group at preflight, the late member alone at
    dispatch/join, like `SESSION_COLLISION`; `normalizeNamedWorktreeBranch` in
    `src/utils/BranchName.ts`); preview lists group issues on workflow members; named members
    (branch from `base` else parent `HEAD`, never merge, reused) and the parent-holds-it start
    failure; real-git authored-waves tests (wave 2's base is the merge commit; a dirty merge
    step fails wave 2). Bug fixed: a settled child's worktree metadata is now read from its run
    file (the in-memory queue never holds it), so settlements carry the lane's branch.
  - **Found in review, not yet fixed** (round 13 steps 1–2):
    - Stopping a PAUSED worktree run (bug): execution settles while PAUSED, which keeps the
      worktree reservation for Continue (`settleWorkflowExecution`, `pausedWorktreeReservation`);
      the idle-pause stop then confirms STOPPED and nothing settles the managed worktree or
      releases the lease, runner lock and heartbeat. Pre-existing for an idle pause
      (`2a4238d26`), extended by `b9c108715` to the mid-unwind case, which used to settle.
    - Stop then quick Continue (bug, low): the `preDispatchStartup` check precedes the 5 s
      unwind wait and is not re-checked, so a Continue during the wait leaves `stop()` on the
      cancellation path, which cancels and skips the never-started step.
    - `SubWorkflowLauncher.executionHandle` (bug, low): `settled` is set only after
      `withRecordedWorktree`'s disk read, so a parent stop or fail-fast in that window stops a
      finished child again (STOPPED → CANCELLING). The read's fallback for a missing/corrupt
      run file is untested.
    - Dashboard (seen live): inside a parallel group at the default panel width the title row
      is ~133 px; the icon (16), "Workflow" badge (53) and the collapsed worktree icon (24)
      leave the name ~28 px ("La…"). `shrink-1000` works, but it is not enough.
    - "(expected)" stands in for what a lane's child ran with; nothing records it. A reattached
      COMPLETED child settles without worktree metadata (pre-existing, narrow).
    - Tests: no executor-level test of a late-dispatched member or a `parallelWithCurrent`
      joiner hitting `WORKTREE_COLLISION`; the nested fan-out test does not check a lane's
      `baseCommit` against the child worktree's HEAD.
    - Low, left: a joiner is refused for a branch only an already-settled member held (the join
      path reserves settled members too; agents only get managed lanes); the preview sees
      collisions only between inline members (file children are not parsed, as with
      `MERGE_INTO_SHARED_ROOT`).

- **Round 13 (reviewed 2026-11-27): round-12 gaps, landing step 6 (entry points).** All four
  `claude-cli`/`opus` steps did what they were asked, each gated by the `committed` preset;
  `npm test` green (8805 extension, 4984 UI, packaging). Two parallel reviewers read the core
  and dashboard diffs. Live check (Playwright, 1280 px, default panel widths): the lane title
  now reads in full beside its worktree badge with the "Workflow" badge folded into the kind
  icon, and **New → Queue as Sub-workflow…** is present; the switcher row items were not
  exercised live (they need a run; Vitest covers them). Review fix `e0e0e077a`: the docs no
  longer say every dashboard entry asks for a file, and say Queue Next is unavailable for a run
  another process executes.
  - `62858595d`: a stopped PAUSED worktree run settles (`resolveRunEndReservation` /
    `settleRunEndReservations`, shared with `settleWorkflowExecution`): worktree landed per
    `merge`, lease, heartbeat and runner lock released; `stop()` waits for a pause to unwind
    before choosing a branch; a Continue pressed while that wait runs is ignored; the launcher
    marks a child settled before its run-file read (`readRunFile` seam); CHANGELOG **Fixed**.
  - `cfda4254f`: settlements carry `ranWith` (harness/model; inline child: its one step; file
    child: the last started queue prompt step), read with the worktree from the child's run file
    (`withRecordedRun`); a reattached COMPLETED child goes through the same read
    (`SubWorkflowHost.readCompletedChild`); a settled lane shows what it ran with, "(expected)"
    only while its child runs; `resolveEffectiveStepHarness` takes the ran-with index; the
    workflow row's title is a `@container/step-title` query that folds the "Workflow" badge
    below 240 px.
  - `e3627aea9`: `APPEND_MODES`, `buildSubWorkflowReferenceStep` (`src/core/SubWorkflowReferenceStep.ts`),
    `appendMode`/`position` on `APPEND_FILE`, `appendFromFileForClient` routing by state, the
    alongside join through `RunContinuationService` with the child's worktree plan in the join
    check, `ctrlyoke.queueAsSubWorkflowFromContext`; executor-level joiner `WORKTREE_COLLISION`
    test; nested fan-out `baseCommit` check; CHANGELOG **Added**, `docs/reference/commands.md`.
  - `06e5dcf40`: switcher row "Queue Workflow to Run Next…" / "Run Workflow Alongside Current
    Step…" (only on the viewed run's row), New → "Queue as Sub-workflow…", workspace viewer
    "Queue as Sub-workflow"; `SUB_WORKFLOW_QUEUE_LABELS`, `PARALLEL_DISPATCH_REFUSALS`,
    `postSubWorkflowAppend`, `useSubWorkflowFilePicker`; dashboard and workspace-viewer docs.
  - **Found in review, not yet fixed** (round 14 steps 1–3):
    - Continue then Stop while a pause unwinds (bug, verified by reading): the unwind wait runs
      only when the status is PAUSED, and the idle branch requires no live execution, so a Stop
      after a Continue that made the run RUNNING (executor still unwinding) takes the
      cancellation path: the next pending step is cancelled/skipped or the 10 s detector runs.
      The tests only cover the Continue after the execution settled.
    - Stop of a paused managed run merges without the strict artifact check (bug):
      `stopIdlePausedRun` passes `strictArtifactCleanupSucceeded: true` as a constant, but the
      pause ran only the best-effort cleanup, so a harness artifact left in the worktree lands
      with the merge; integrations parked in `lastRunIntegrations` (terminal tabs) are not
      closed with `WORKTREE_RELEASED`.
    - Overlapping `stop()` calls on a paused run (suspect): `stopWaitingOnPause` is a boolean
      the first stop's `finally` clears; the second stop falls into the cancellation path. The
      comment after `beginPreDispatchStartup` (`isResumeSuperseded`) says the idle branch
      settled the reservation, but the setup branch only confirms STOPPED; check for a leak.
    - A Continue ignored during a stop's wait gives the user no feedback (only `Log.info`).
    - A late joiner (dispatch or MCP join) failing its member preflight settles FAILED without
      consulting `onFail`, with no `terminalFailure: false`, so in a `failFast` group it cancels
      running siblings (`ParallelGroupRun.ts` ~532). Contradicts "Group preflight": a member
      failing preflight fails that member alone under its `onFail`.
    - `e3627aea9` smalls: `SUB_WORKFLOW_LIVE_APPEND_STATES` is `ReadonlySet<string>`, a copy of
      `ACTIVE_EXECUTION_STATES` minus CANCELLING; the instance and orchestrator call the builder
      with different roots (instance may fall back to `dirname(filePath)`); inline mode with
      `parallelWithCurrent` throws in the router's picker branch with no `showRunActionFailure`;
      the alongside path skips `recordSuccessfulRevisions`/`invalidateRunViews`; a test reaches
      `workflowExecutor` through `as unknown as`; an out-of-workspace file passes queue-time
      parsing but may be refused by the D5 trust filter only at launch (check).
    - Launcher smalls: redundant `.catch(() => COMPLETED)` on reattach; a run file read with no
      started prompt step ignores the in-memory `ranWith`; `SubWorkflowRanWith.harness` is
      `string`, cast to `HarnessId` unchecked in the webview.
    - Dashboard: `useSubWorkflowRanWithIndex` subscribes to the live entry arrays, so the steps
      panel and chip rail now re-render on every streamed chunk (render churn); a D6-continued
      child (same `childRunRef`) shows its earlier `ranWith` unmarked while running again; New
      and workspace-viewer "Queue as Sub-workflow" keep a passive label when the view is a
      settled run (the inline sibling says "Append and Continue…"); the hosted-vs-native picker
      branch is written twice (`WorkflowControls.tsx`, `useSubWorkflowFilePicker`); the switcher
      re-implements the parallel-dispatch refusal order and drops `useRunDispatchTargets`'
      "no step is running" check; the hosted picker reads the mutation address at pick time, not
      when the menu item was chosen.
    - Low, left: `package.json`'s Explorer item copies `ctrlyoke.hasQueuedSteps` (so it is hidden
      on an empty queue, like `queueFromContext`); a model-less `ranWith` shows no model (as a
      started prompt step does).

- **Round 14 (reviewed 2026-11-27): round-13 gaps, landing step 7 starts (file-reference
  editor).** All four `claude-cli`/`opus` steps did what they were asked, each gated by the
  `committed` preset; `npm test` green (8835 extension, 5020 UI, packaging). Two parallel
  reviewers read the core and dashboard diffs. No live check: no step had Playwright tools, and
  this pass did not run the dev host (round 15 step 4 checks the editor live). Review fix
  `17d5ce08d`: `postSubWorkflowAppend` with an explicitly captured `undefined` mutation no
  longer re-reads the displayed view (a default parameter applied to it); the joiner
  `WORKTREE_COLLISION` test's holder-lane wait (one flake under full `npm test`, passes alone)
  got a 25 s budget and an observed-state message; stale `stopPausedRun` comment names.
  - `bf34a97b5`: Continue-then-Stop during an unwind and overlapping stops stay on the paused
    path (`pausedRunStop` promise; a second stop joins the first); the paused-run branch runs
    before the setup branch, so a stop right after a Continue's `beginPreDispatchStartup`
    settles the kept reservation (the leak was real); `settleRetainedIntegrations` closes the
    pause's parked `lastRunIntegrations` with `WORKTREE_RELEASED` and runs the strict cleanup,
    whose result decides the landing; an ignored Continue notifies
    (`PAUSED_STOP_IGNORES_CONTINUE_MESSAGE`); CHANGELOG **Fixed** widened.
  - `3e45dcc18`: a late member (slot dispatch or join) failing member preflight goes through its
    `onFail` and never fail-fasts siblings; `SUB_WORKFLOW_LIVE_APPEND_STATES` derived and
    typed; only the orchestrator calls `buildSubWorkflowReferenceStep` (instance receives the
    built step); run-alongside records and republishes revisions; the router refuses inline +
    `parallelWithCurrent` (`INLINE_PARALLEL_APPEND_REFUSAL`); an out-of-workspace file is
    refused at queue time; `readCompletedChild` never rejects; `ranWith` falls back to memory
    and `readSubWorkflowRanWith` drops unknown harness ids (`HarnessId`).
  - `79d2043ef`: `useSubWorkflowRanWithIndex` returns a cached string snapshot (no rescan or
    re-render from it on ordinary appends; the panel still re-renders per chunk for older
    whole-store reasons, filed as @dev/bugs/backlog/steps-panel-rerenders-on-every-output-entry.md);
    `ranWith` only for terminal step statuses; "Append and Continue as Sub-workflow…" label
    variants; `getParallelDispatchRefusal` (@src/ui/webview-react/utils/parallelDispatch.ts) shared with
    Run in Parallel (Run Alongside is now disabled with no step running); one picker hook; the
    hosted picker captures the mutation when the menu item is chosen.
  - `a071ab354`: editor **Workflow** mode for file-reference steps: `resetStepKindFields` (8
    sites, not 4) and `loadStepFields`; `setStepType` stores the kind; `SubWorkflowStepFields`
    (file field, Browse…, On Fail, colour); `useWorkflowFilePicker` (generalized);
    `SELECT_SUB_WORKFLOW_STEP_FILE` → `SUB_WORKFLOW_STEP_FILE_SELECTED`;
    @src/ui/webview-react/utils/subWorkflowStepProperties.ts shared with the preview; inline steps load
    read-only (Move to Editor disabled for them); `schemaUiPropertyRoundTrip` "workflow step"
    and "final step (workflow)" surfaces, `workflow` in `NOT_AUTHORABLE` beside
    `prompt`/`script` with a `CONTENT_CONTROL_IDS` guard; Save As round trip; docs, CHANGELOG
    **Added**. Before it, clicking a workflow step row threw in `enterEditMode`.
  - **Found in review, not yet fixed** (round 15 steps 1–3):
    - Stop during the pause's own settlement (bug, read): `stopRun` waits only while
      `hasLiveExecution()`, which goes false when `execute()` returns, before
      `settleExecution` (`WorkflowStartupPipeline.ts`) has awaited the per-integration cleanup
      and filled `lastRunIntegrations`. A Stop (or Continue-then-Stop) in that window runs
      `stopIdlePausedRun` beside the pause settlement: integrations not yet parked miss the
      strict check, and the pause's `finishExecutionHistory` clears `startPending` under the
      stop. Wait on the settlement (`startPending`/`executionSettledPromise`), not liveness.
    - Continue alone during the unwind (bug, read; the step flagged it): `settleWorkflowExecution`
      reads the status when settlement starts; a Continue after `confirmPaused()` makes it
      RUNNING, so a managed worktree run settles as terminal (commit, merge/remove, lease and
      runner lock released), then the resume prepares a fresh worktree for the remaining steps.
    - Continue-then-Stop may finalize the manifest as CANCELLING (suspected): assert it.
    - The parked-integration loop in `settleRetainedIntegrations` repeats the cleanup/merge-
      message code of `settleExecutionIntegrations`.
    - Queue-time resolution builds its own `PromptFileResolver` (workspace root, approved
      roots) instead of the launch's (`WorkflowExecutor.getPromptFileResolutionOptions`:
      execution root, source checkout, workflow-relative references); two setups that can
      drift. `recordedRanWith` reports an earlier step's harness when the latest is unknown.
      Tests: `ParallelGroupRun.test.ts` `waitForOutcome` falls through silently after ~1 s;
      new `as unknown as WorkingFile` casts in `SubWorkflowLauncher.test.ts`; no executor-level
      late dispatch under `maxParallelSteps` failing preflight; `promoteBesideRunningStep`'s
      `as unknown as WorkflowStep`; the webview's now-redundant `ranWith.harness as HarnessId`.
    - Editor Browse in the hosted dashboard stores the modal's absolute path (`file.path`); the
      native picker's router handler re-implements the reference build with a different root
      (`getNamedRoots()[0]`) and skips `resolveSubWorkflowReference`; typed paths keep
      backslashes. Move to Editor silently discards a Workflow-mode new-step draft (only
      script drafts are guarded/kept). A native picker reply lands on whatever file workflow
      step is selected when it arrives (no target key). `WorkflowControls` keeps a
      `"queue-sub-workflow"` literal; `STEP_TYPE_OPTIONS` hardcodes Prompt/Script labels; the
      `CONTENT_CONTROL_IDS` guard is satisfied by the id constants alone. The inline "Queue from
      File" hosted picker reads the address at pick time (step 77 noted it).
    - Low, left: the steps-panel whole-store re-renders (bug filed); Script mode still shows the
      execution-mode picker; no file-exists/parse check when saving a typed path (launch fails
      under `onFail`).
- **Round 15 (reviewed 2026-11-27): round-14 gaps, the inline (D13) editor; landing step 7
  is all but done.** All four `claude-cli`/`opus` steps did what they were asked, each gated
  by the `committed` preset; `npm test` green (8918 extension, 5046 UI, packaging), lint and
  `check:docs` clean. Two parallel reviewers read the core and dashboard diffs, and this pass
  checked the inline editor live in the hosted dashboard (an existing lane loads into the
  Inline form with its prompt, properties drawer and Managed worktree controls; Update
  saves). No review fix was committed this pass: everything found needs a test first and
  went into round 16.
  - `ff9453f57`: a Stop of a paused run waits for the pause's own settlement (`startPending`),
    with the 5 s cap only on the executor's unwind; the executor reports `endedOnPause()`, so a
    Continue that beats the settlement keeps the worktree (the review's window was narrower
    than stated: only a pause confirmed after a final step appended queue work skipped the
    in-place carry-on); Continue-then-Stop asserts STOPPED (already correct);
    `settleIntegrationArtifacts` shared by the parked and live loops; the joiner
    `WORKTREE_COLLISION` flake was the test's `laneChildOf` matching `runRef` alone (two lanes
    started in one millisecond), now also `childWorkflowKey`.
  - `5ab433940`: @src/core/PromptFileResolutionOptions.ts `buildPromptFileResolutionOptions`
    used by the launch and the queue-time check (`WorkflowInstance.getPromptFileResolutionInput`);
    a picked file inside the run's worktree is stored workspace-relative
    (`mapExecutionPathToSourceCheckout`); the router's native picker goes through
    `WorkflowOrchestrator.buildSubWorkflowStepReferenceForClient`; new
    `NORMALIZE_SUB_WORKFLOW_STEP_FILE` → `SUB_WORKFLOW_STEP_FILE_SELECTED` or
    `WORKFLOW_ACTION_FAILED`; `recordedRanWith` reads the latest started prompt step only;
    named test waits and typed builders; executor-level late member under `maxParallelSteps`
    failing `WORKTREE_COLLISION`.
  - `408ddf8da`: hosted Browse normalized by the backend; `getEditorOnlyDraftKind` guards Move
    to Editor and keeps script and workflow drafts; picker request/reply `targetKey`
    (`newPrompt`, `queue:N`, `finalStep`); backslashes normalized on input; menu-value and
    `STEP_EDITOR_MODE_LABELS` constants; a Vitest render test proves the content control ids
    (the integration guard narrowed to what a source scan proves); `useQueueFilePicker`
    captures Queue from File's target when chosen.
  - `0a94c2def`: inline editor. File / Inline from `subWorkflowInline` (no boolean); the
    wrapped prompt/script editors reused; `WorktreeConfigEditor`, `ModeSwitch`,
    `SchemaFormField` extracted from the workflow properties panel (panel ids unchanged);
    **Parent's checkout** option for no `worktree` key; File ↔ Inline keeps both forms in one
    edit; inline steps editable and movable; two inline `schemaUiPropertyRoundTrip` surfaces
    from the schema's `inlineSubWorkflowDefinition` (no opt-outs); preview through the shared
    builder; docs and CHANGELOG.
  - **Found in review** (all but the "Low, left" items fixed in round 16):
    - Inline worktree writes schema-invalid empty strings (bug, **confirmed live**): toggling
      Keep Directory on a lane saved `{ mode: managed, base: "", setup: "", merge: true,
keep: true }`; `managedWorktreeConfig.base` has `minLength: 1`, so the file no longer
      validates (`ctrlyoke validate` refuses it at the workflow level too).
      `worktreeConfigForMode`/`editableWorktreeConfig` in
      @src/ui/webview-react/components/shared/WorktreeConfigEditor.tsx seed and rebuild empty
      `base`/`setup`; the workflow-level panel sends the same objects through
      `UPDATE_WORKFLOW_PROPERTY` (likely pre-existing; verify).
    - Settlement that throws hangs Stop forever (read): `settleWorkflowExecution` has no
      try/finally, so `finishExecutionHistory` (which clears `startPending` and resolves
      `executionSettledPromise`) never runs; the now-uncapped stop wait, every later Stop
      (`pausedRunStop`) and every Continue are stuck.
    - `pauseConfirmed` goes stale (read): reset only at the top of `execute()`. The in-place
      carry-on (`WorkflowExecutor.ts` after `statusAfterQueue`) keeps it true, and a start that
      fails before `execute()` (runner lock, lease, `restoreRetainedIntegrations`) settles with
      the previous execution's value, so a RUNNING run can settle as paused and keep its
      worktree, lease and lock.
    - A Stop that arrives before `activeWorktreeSettlementAbort` exists can no longer cut a
      queued worktree settlement short; it waits out a sibling's merge (delay, not deadlock).
    - Editor: `convertPromptToFile`/`persistPromptFileReference` are reachable in inline prompt
      mode, guarded only by the header (an `UPDATE_PROMPT` without `type` would replace the
      wrapper); an insert into an inline script calls `setStepType(PROMPT)` and leaves
      Workflow mode; the wrapped step's execution-mode picker is hidden; `targetKey` is
      positional (`queue:N`; use the step id); the 15-field script mapping is repeated four
      times (`buildScriptProperties`, `handleUpdate`, `executionPreview.ts`,
      `buildInlineSubWorkflowDefinition`); `isNewStepDraftDirty` ignores `subWorkflowInline`;
      the named-branch refusal test never clicks Update; stale comments above
      `STEP_EDITOR_MODE_LABELS`/`WORKFLOW_CONTROLS_MENU_VALUES` and on
      `normalizeWorkflowFilePath`; `handleModeChange` has no `assertNever`.
    - Low, left: a settled NAMED-worktree run with no resident instance resolves a queued file
      against the default workspace, so an untracked file only in that worktree is refused at
      queue time (stricter than the launch, never looser); symlinked picker paths
      (`/var` vs `/private/var`) are not mapped out of the worktree; the wrapped step's own
      `name`/`enabled`/`color` have no inline control (kept as written; the header edits the
      outer step's); saving an inline prompt does not run D13's boundary check (fails at
      launch under `onFail`).

- **Round 16** (reviewed 2026-11-27; `npm test` green: 8953 extension, 5065 UI):
  - `d830e4ead`: settlement always finishes (`finishExecutionHistory` in a `finally`; each
    integration, target, retained integration and artifact cleanup settles on its own, and a
    failure blocks a worktree's landing as an unproven cleanup); a settlement throw is logged and
    reported, never rethrown. `pauseConfirmed` is cleared on the in-place carry-on and by
    `WorkflowExecutor.beginExecution()`; a resume whose start throws while RUNNING fails through
    `failResumeSetup`. A stop waiting on a paused run's unwind (`stopAwaitingExecutionSettlement`)
    makes a worktree settlement that starts meanwhile begin aborted. The carry-on reset has no
    dedicated test (round 17 step 1).
  - `3f2ce4070`: `withoutBlankOptionalWorktreeFields` (`src/utils/WorktreeConfigShape.ts`)
    drops blank `base`/`setup`/`directory` in `WorktreeConfigEditor`; the workflow panel had the
    same bug in 0.2.0 (CHANGELOG **Fixed**). Inline guards (prompt-file conversion, insert into
    an inline script, execution-mode picker for an inline prompt); picker `targetKey` is
    `step:<stepId>` (falls back to `queue:N` without an id); one script-field mapping
    (`getScriptStepEditorValues`/`getScriptStepUpdateFromEditor`) at all four sites; inline shell
    counts as dirty.
  - `e6b23064e`: a file child previews as one "Runs <path>" entry; an inline child previews as its
    wrapped step through `materializeInlineSubWorkflow`, with the lane badge's own-worktree
    wording; `ctrlyoke run --dry-run` prints the same; the redactor covers an inline child's
    worktree setup. Review fix `dbd97df2f`: an unnamed parent's inline child is named after the
    file, as at launch.
  - `47949ef06`: `SUB_WORKFLOW_STEP` outline kind and detection (queue, members, `finalStep`,
    root), inline definitions classified as prompt/script with `worktree` as the only
    workflow-only key, `workflow` path role (VS Code only; the hosted editor gets none), session
    candidates prompt-only, no step numbers inside an inline definition, D13 boundary checks
    shared through `isParentRunSessionId`/`isParentRunPriorContext`, `type` detail from
    `STEP_TYPES`, a `workflow` key snippet (no inline lane snippet: one snippet per key).
  - `e8bf17d2c`: `StepReferenceShifts` already skipped inline definitions (tests added; it
    reports, never rewrites); the `ctrlyoke-syntax` skill, tech-support agent and docs page say
    what a workflow step contributes to `$previous`/`$step` and that inline references cannot
    cross the boundary.
  - **Whole-spec audit** (after round 16, four read-only passes over D1–D14, the core sections
    and the dashboard/CLI/tests sections). Everything else is met. Gaps, all queued in round 17:
    - **D10 misses a cycle through a worktree parent** (read, not yet reproduced): the root's
      ancestor entry is its authored path (`WorkflowInstance` `ancestorPaths` getter), while a
      child is resolved inside the execution checkout (`buildPromptFileResolutionOptions`), so
      `a.yaml` (managed worktree) → `b.yaml` → `a.yaml` compares `<main>/a.yaml` with
      `<wt>/a.yaml` and recurses, each `a` creating a new worktree.
    - **D11: CLI `--var` never reaches a file child** (`mergeCliVarsIntoWorkflow` runs on the
      root only; `createCliSubWorkflowInstance` carries no vars). D11 says a file child uses its
      own `vars` plus host-level `--var` overrides.
    - **D12a: a workflow step that fails before a child run exists has no output**: no
      `subWorkflowSettled` is written (it needs a child identity), so under `onFail: continue`
      `$previous` skips the step and the failure never reaches later prompts. D12a: "always has
      output and is never skipped by `$previous`".
    - **D12c: only the whole-step omission stub names the `read_output` call**; field-level
      truncation markers inside child steps carry no hint.
    - **D6 reattach ignores an edited `workflow` path**: `resolveRecordedChildRun` matches on
      the `parentRun` link only, so a Continue after the path changed continues the old child
      (spec silent; low).
    - **Tests the Tests section lists but nobody wrote**: lane metadata through `$step:a-b` and
      `$step:summary:a-b`; a schema accept test for a workflow `parallel` member; an end-to-end
      merge conflict that leaves the parent step COMPLETED; a CLI group of two lanes building both
      children; the `ctrlyoke.queueAsSubWorkflowFromContext` command and the Run Workflow
      Alongside append path (verify; may exist).
    - Small: stale `SubWorkflowTypes.ts` comment that `ancestorPaths` is "ignored by this
      launcher round"; completions treat a typeless step with a `workflow` key as undecided; a
      preview of an inline child whose wrapped step is disabled drops it silently; the "parent's
      checkout" preview test loops over `false`, which is the main checkout, and never asserts
      the child's checkout.

- **Round 17** (reviewed 2026-11-27; `npm test` green: 8979 extension, 5067 UI; every step gated
  by the `committed` preset, `claude-cli` with `sonnet`/`haiku`):
  - `c140a7b8e`: D10 compares in the source-checkout frame (`toSourceCheckoutFrame` via
    `mapExecutionPathToSourceCheckout`), and `ancestorPathsForChild` hands each child the chain in
    its own source checkout's frame, so nested worktrees hold too (two real-git tests: inheriting
    and own worktree). D6 reattaches a file child only when `_runtime.resolvedWorkflowPath`
    matches the step's current file (unit tests; no end-to-end stop/edit/Continue test). The
    carry-on `pauseConfirmed` test, and the `ancestorPaths` comment (in `src/types/`).
  - `f04363564`: CLI `--var` reaches every file child (`src/cli/CliVarOverrides.ts`,
    `cliVarOverrides` → a child-only `prepareParsedWorkflow` hook in `WorkflowInstance`); an
    undeclared name is added as for the root. Docs and CHANGELOG updated. The root-only
    "`--var` is unused" warning still fires for a var only a child references (round 18).
  - `bea069949`: a pre-child failure writes `subWorkflowSettled` with no child identity
    (`failedToStart`, `failureMessage`; `childWorkflowKey`/`childRunRef` optional in every
    reader); prior context renders `<failure>`; the dashboard row shows the reason; `run --json`
    `subWorkflowRuns` skips childless entries. Field-level truncation markers in child steps carry
    `readOutput` (single `readOutputCall`), with `tail: N` only for an end cut.
  - `b3b174975`: lane metadata through `$step:a-b`/`:summary`, schema accepts workflow members in
    `parallel`, completions decide a typeless step by its `workflow` key, a disabled inline child
    previews with `previewDisabledChildNote` (the launch runs it and it does nothing), and the
    split parent's-checkout preview test.
  - `579257d84`: real-git merge conflict test (parent COMPLETED, `worktree.mergeOutcome:
"conflict"`, branch kept), a CLI two-lane group test, and the explorer command's handler
    moved to `src/platform/QueueAsSubWorkflowCommand.ts` with tests. Run Workflow Alongside was
    already covered (`WorkflowOrchestrator.test.ts`, `DashboardMessageRouter.test.ts`).
  - Review fix `d09a8ad70`: a launched child whose run threw (its `done` rejected) settled with
    no event, because the catch counted any handle as recorded; it now records a failed
    settlement addressed to that child. A step edited from a file into an inline definition
    reattached the old file child; it now launches fresh, and an inline launch clears the
    recorded path. `WorkflowOrchestrator implements SubWorkflowQueueTarget`.

- **Round 18** (reviewed 2026-11-27; `npm test` green; one `claude-cli`/`sonnet` step gated by
  `committed`):
  - `eb3dab7c7`: the CLI unused-`--var` warning also reads every `type: workflow` file child
    reachable from the root (queue, `parallel` members, `finalStep`, recursively, visited set),
    resolved through `resolveSubWorkflowReference` relative to the naming file; an unusable child
    is skipped. Inline children were already covered by the parent walk. CHANGELOG clause added.
    End-to-end D6 test: stop, edit the step's `workflow` through `updateStepAtRun` (keeps
    `_runtime`), Continue launches the second file as a new child and leaves the first stopped.
    Reviewed; no fixes needed.

**Spec complete (2026-11-27).** Moved to `dev/implemented/`.

### Next

Nothing. The roadmap is empty and the spec is complete; the two questions for Nathan under
Decisions (re-running an interrupted step on a direct child continue, and a catalog editor for
`conditions`/`worktreePresets`) and the optional template allow-empty flag would each be a
separate follow-up change.

### Decisions

- **Phase 0 was split by directory into sequential steps** (round 1), because the steps shared
  `CtrlYokeTypes.ts` helpers and the guard could only pass once every area was done.
- **The schema `$defs` extraction landed in round 1**, ahead of the new step kind, so the round-2
  schema diff stays small.
- **`SubWorkflowStep.workflow` is `string` until D13's round.** The inline arm is added then, in
  schema and type together, so every consumer of `workflow` is compiler-guided at that point
  instead of half-handling an object form nothing can produce yet.
- **Rounds 2–3 leave the step reachable from YAML before any host provides `subWorkflowHost`.**
  Between round 2's schema step and round 3's host factories, a workflow step fails with "Sub-workflow
  steps are not supported in this host" (the documented missing-host behaviour). This is a
  development branch, so the CHANGELOG entry and docs page wait for round 3, when it works.
- **D6 landed in round 4** (it had been deferred from round 3).
- **Adding a union member is mostly not a switch-arm change (round 2 lesson).** The first
  attempt at round 2 step 1 hit 177 extension and 20 webview type errors and gave up uncommitted.
  Only about 40 were missing `case` arms. The rest were reads that compile only because
  `PromptStep` and `ScriptStep` share fields (`_runtime.sessionId`, `executionMode`,
  `endCondition`, …; scripts reuse `PromptRuntimeMetadata`), plus `isPromptStep(s) ? … : s.script`
  branches, a binary shape that the round-1 guard does not catch. The work is now split so the
  overlap is removed first (with the union widened only temporarily to list the sites), and
  the kind lands last. The `USER_INPUT_STEP_PLAN.md` kind will benefit from the same split.
- **The sequential D4c dirty check is round 5** (moved from round 3, then round 4). It only
  matters for a child with its own `worktree`, and D4b (branching from the parent) is round 9,
  so until then a worktree child branches from the main checkout as a top-level run does today.
- **`settleNonHarnessStep` keeps one script quirk on purpose.** An errored script under
  `errorBehavior.onError: continue` fails its queue step and still returns "continue", as before
  round 2. Only `continueResolvesFailure` (sub-workflow `onFail: continue`) skips `failStep`.
- **A cancelled child requests the parent's stop; it never confirms it.** The executor moves the
  parent to CANCELLING and the outcome coordinator confirms STOPPED, the same path a user stop
  takes. D2's "parent stopped" direction (round 3) must keep this single confirmation point.
- **The launcher starts execution before returning the handle** (round 3). A real instance
  allocates its `runRef` when execution starts, so "return once known (after load)" in
  `SubWorkflowLauncher.launch` item 4 means "after execution has begun".
- **`SubWorkflowParentLink` is phase-discriminated** (round 3 review). The finalStep has no
  `stepId`, so a pass is identified by `loopIndex`. Manifests written on this branch with the
  old shape are unreleased, so no migration.
- **Pre-existing manifests and leases need no format bump for `parentRun`/`delegationChain`**
  (round 3): both are optional, and an older ctrlyoke reading a delegated lease sees an
  ordinary conflict and fails closed.
- **`delegationChain` reaches a child twice** (factory `executionOptions` for its own
  executor's requests, `loadPromptFile` options for its lease). Acceptable for now; fold into
  one when D6's continuation path needs the same data.
- **D6 reattach compares the whole `parentRun` link** (round 4): workflowKey, runRef, phase and
  stepId/loopIndex must all match, so a finalStep pass never reattaches to an earlier pass's
  child (D8). Round 5 replaces the `JSON.stringify` comparison with a field-wise helper.
- **A COMPLETED recorded child settles without relaunching even if the parent's timeline
  already holds its `subWorkflowSettled`**; the event is written at most once per child run.
- **`<childRunUnavailable/>` carries no `read_output` hint** (round 4 review): it appears only
  when the child's history is missing or unreadable, so the call would fail.
- **The D12c ancestry walk is bounded at 128 links** (round 4; the spec was silent).
- **The D4c dirty check stays in round 5 for sequential children**; the once-per-group check
  waits for parallel members (rounds 6–7).
- **The D4c check runs in the launcher, after the child parses and before it executes**
  (round 5). Worktree creation happens at execution start (`ensureManagedWorktree`), so the
  check still precedes it without loading the child definition twice. The once-per-group
  parallel check (round 7) calls the same `prepareParentCheckoutForWorktreeChild`.
- **`subWorkflowRuns` addresses a finalStep child by 1-based `pass`** (round 5), matching
  `--step final:N`, rather than exposing `loopIndex`. It is additive within `schemaVersion: 1`.
- **The dashboard's "Started by" is unavailable when the parent lineage is not in
  `recentWorkflows`** (round 5), which covers imported bundles and deleted parents.
- **Real-instance test steps run on `claude-cli`/`opus` from round 6.** The workflow default
  (`codex-cli`) fell short twice on D6 tests and twice on propagation tests, each time
  reporting the gap honestly but committing little or nothing.
- **A continued child re-runs the step its stop interrupted** (round 6 review; the spec was
  silent). Continuing an ordinary stopped run leaves its cancelled step cancelled and moves on
  (`finalizeCancelledPromptAfterStop`, pinned by `promptQueue.test.ts`). Applied to a D6
  continuation, that completes a single-step lane at once with its only step CANCELLED and
  reports the parent step COMPLETED, so the lane's work never happens. Since the parent re-runs
  its own cancelled workflow step to reconnect, the child it continues re-runs its cancelled
  step the same way. This applies only to a child continued by D6, not to continuing a
  top-level run, whose behaviour is unchanged. Nathan: say if you would rather the user-facing
  continue rule change for every run.
- **The CLI progress prefix is the nearest child workflow's name** (round 6), not the full
  ancestor chain, so lines stay short. Same-named siblings will be ambiguous once parallel
  members land; round 7's CLI step revisits it if it is cheap.
- **`subWorkflowRuns` has one entry per child run** (round 6 review): the latest settlement for
  each queue `stepId` or finalStep `pass` and `runRef`, plus in-flight children from `_runtime`
  with `status: null`, as `f14e72cc5` reported them.
- **An inline child has no `resolvedWorkflowPath`** (round 6 review): the field is documented
  as an absolute path and nothing reads it for inline children; the launch source kind already
  says it is inline.
- **An inline child's `trustedExternalRoots` is the parent's _declared_ set plus the parent's
  trust identity** (round 7). The child recomputes the effective set from the same inputs, which
  keeps workflow-scoped approvals keyed by the parent's file; a pre-filtered list could not.
  Round 8 extends this to parents with no source file.
- **A disposed child settles CANCELLED, not FAILED** (round 7): a host shutdown is not a child
  failure, and FAILED would let `onFail: continue` advance the parent past unfinished work.
- **A stop, pause or cancel-pause that reaches a child before its execution cycle starts is
  held and replayed once it starts** (round 7 for IDLE children; round 8 widened it to D6
  continuations, which are STOPPED/PAUSED, not IDLE, while they load). D3 was silent. A paused
  child pauses before its next step, and its parent stays PAUSING meanwhile (D3).
- **`concurrent` is false when a group runs at width 1** (round 7), so a CLI child keeps the TTY
  as prompt members do. Round 8 makes the once-per-group D4c check follow the same rule: it
  applies only when the group actually fans out; at width 1 each member keeps the launcher's
  own check, because earlier members can dirty the tree before later lanes branch.
- **Late joiners (ad-hoc promotion, MCP joins) keep the launcher's per-child D4c check** (round
  7); the group check is a fan-out-time decision. Revisit with the entry points (round 12).
- **A direct continue of a child run uses the top-level continue rule** (round 7 review). The
  `anyStepKind` rewind is decided by who calls (only D6 passes it), so continuing a stopped
  child from its own row or `ctrlyoke run --run` skips its interrupted step, and a later parent
  continuation then sees the child COMPLETED. This is the open question below.
- **Open question for Nathan: should continuing a stopped run re-run its interrupted step for
  every run, or at least for any run that has a `parentRun`?** Today only a D6 continuation
  does (Decision "A continued child re-runs the step its stop interrupted"). Keying it on
  `parentRun` would make a direct child continue consistent with D6 at no cost to top-level
  runs; changing it for every run alters released behaviour (CHANGELOG **Changed**). Nothing
  queued depends on the answer.
- **A group snapshots nothing at fan-out: a member re-parses at launch if its file changed
  since preflight** (round 8), as a sequential step does. A re-parsed member carries no group
  D4c result and runs the launcher's own check, like a late joiner.
- **The lane join rule's precedence** (round 8; the spec was silent): after a lane is stopped
  directly, members still waiting for a slot are dispatched; at the join a directly stopped
  lane beats both a pause and a sibling failure (the parent stops, so Continue reconnects the
  lane rather than advancing without it). Continue reconnects every cancelled workflow member
  with a recorded child, whether a user or a parent stop cancelled it; prompt and script
  members of a top-level run keep the top-level rule.
- **A child disposed by a host shutdown counts as stopped by the child** (`cancelledBy:
"child"`, round 8). Round 9 step 1 must make sure the registry's own retire path can never
  dispose a child a launcher still owns, since that is not a shutdown.
- **D4b moves ahead of the rest of landing step 4, into round 9** (round 8 review). The code
  never gave the start error landing step 2 promised for a worktree child of a worktree
  parent; it branches from the main checkout, so a D4c checkpoint on a managed parent is
  silently missing from the grandchild (the exact loss D4c exists to prevent). A start error
  would be built only to be removed. D4b is bounded (source checkout on the launch request,
  worktrees root from the main checkout), and D4d rule 1 for merge leases goes with it, because
  without a chain a lane's `merge: true` always ends `blocked` against its parent's lease.
- **"D12c per-member scope" is dropped from the roadmap** (round 8). It was a forecast idea,
  not a spec requirement: D12c's rule is descendants of the attached run, and every member's
  child already is one.
- **A PAUSED child is not stopped when its instance is disposed** (round 9): nothing is
  running, and a shutdown keeps a user's pause across a restart, as `shutdown()` does for
  top-level runs. A RUNNING child is stopped and awaited, so no executor outlives its instance.
- **After a restart, Continue re-runs a lane that fail-fast had already cancelled** (round 9):
  the persisted rule (cancelled + `childRunRef`) cannot tell a fail-fast cancel from a user
  stop without the timeline's `cancelledBy`. The group then fails on the original failure.
  Accepted; revisit only if it proves costly.
- **A top-level run in a linked user worktree now places new worktrees beside the main
  checkout** (round 9, D4b): the worktrees root is resolved from the main checkout for every
  run, not only children. Existing records keep their stored paths. CHANGELOG **Changed**.
- **A worktree's ownership record is the source of truth for its source checkout on resume**
  (round 9 review; the spec was silent). A resumed run, whether continued by D6 or directly,
  keeps the record's `sourceCheckoutRoot`, base and target branch; the caller's source checkout
  applies only when the record is created. Round 10 step 2.
- **`MERGE_INTO_SHARED_ROOT` applies at any group width** (round 9 review), including
  `maxParallelSteps: 1`: the spec gives no exemption and an author who widens the group later
  would otherwise meet it only at run time. Documented.
- **Lane surfaces (orchestrator agent, template, dashboard lane row) wait for round 11**, after
  D14's MCP surface lands, so the agent guidance is written against working tools.
- **A lane is recognized by shape, not by who wrote it** (round 10 review). `edit_step` already
  lets an agent edit any pending authored prompt step, so an authored inline prompt child with a
  managed worktree and no `onFail` is no more protected than that step would be. Unwrapping can
  only remove the author's `setup`, never add a script. Marking agent-created lanes would need a
  persisted field for no safety gain. Docs and CHANGELOG say so (`e7301ccda`).
- **Sibling lanes queue on the repository-wide worktree mutation lock** (round 10), whose wait
  for a chained `merge: true` settlement is 120 s (`WORKTREE_MERGE_LEASE_WAIT_MS`); chainless
  and non-merge mutations keep 5 s. The D4d lease wait stays as the guard for merges taken
  outside that lock. Both waits end on a stop (round 11, `a4731feb3`).
- **The join refusal counts pending group members, and runs both ways** (round 10; the spec said
  "a running prompt or script step"): a pending member will run beside the lane too, and the
  preflight rule is symmetric, so a plain prompt cannot join a group holding a merging lane.
  Neither case existed in 0.2.0 (no workflow steps), so nothing released is newly refused.
- **A stop ends a lane's settlement wait, not its settlement** (round 11; D4e was silent). A
  stop while a lane waits on the mutation lock or the merge-lease backoff records merge
  `blocked` and keeps the branch; a free lock is always taken, so a stopped lane that reaches
  settlement still commits its work. A lane stopped _before_ settling starts still queues
  behind its siblings (the docs say "while a lane waits").
- **A blank `laneSetup` uses its default (`npm ci`)** (round 11). `TemplateManager.createWorkflow`
  replaces every blank template variable with its default, and `_templateMeta.variables` has
  no allow-empty flag. The variable's description says to set the created workflow's
  `setup: ""` for no setup (R13 assumed a blank would render `""`). A template-variable
  allow-empty flag would be a small separate change; not planned unless Nathan wants it.
- **`abort-failed` gets the merge warning badge too** (round 11), beside `conflict` and
  `blocked` (D4e names only those two); the agent's integration step treats it the same way.
- **MCP's merge-lane checks take the run's execution root only from ctrlyoke** (round 11 review).
  The edit/join merge-lane checks use `CTRLYOKE_EXECUTION_ROOT` as ctrlyoke set it, else the run
  file; never the agent's working directory (round 12 step 1 fixes skill mode).
- **`WORKTREE_COLLISION` behaves like `SESSION_COLLISION`** (round 12): it fails the whole group
  at group preflight, and only the late member at its own dispatch or join. A `{{var}}` named
  branch is not compared at preflight (the child substitutes it); a clash between two fails the
  later member at start. The key is the normalized branch only.
- **D4d rule 2 needs a chain that ends in the same delegator, not an identical chain** (round
  12; the spec was silent). Worktree-owning leases carry no chain, so rule 2 can never admit two
  holders of one named worktree.
- **A lane shows what its child ran with once it settles** (round 13; "(expected)" only while
  the child runs). `ranWith` is an optional `subWorkflowSettled` field, read tolerantly, so no
  format bump. A file child records its last started queue prompt step's harness/model; the
  dashboard shows none for file children (as the spec says), so it is history-only for them.
  `run --json`, MCP `workflow_status` and the prior-context XML do not expose `ranWith`; each
  would be additive if wanted.
- **A stopped PAUSED worktree run must settle like any stopped run** (round 13; D3 was silent).
  Pausing keeps the worktree reservation for Continue; a stop ends the run, so it settles the
  managed worktree (merge per config) and releases the lease and runner lock.
- **A Continue pressed while a Stop waits for a pause to unwind is ignored** (round 13): the
  Stop was pressed first. The wait is capped at 5 s and the run visibly ends STOPPED; round 14
  adds a feedback message. A paused worktree run restored after a host restart and then stopped
  still has nothing in memory to settle (pre-existing, left).
- **The queue-as-sub-workflow entries act only on the run the dashboard is showing** (round 13):
  a finished run continues through a revision-checked path, and the client holds revisions only
  for the view it displays. Queue Next is disabled for a run another process executes (no
  in-memory queue here); Run Alongside stays enabled (that path works across processes). Menu
  labels are Title Case to match their menus. Inline mode with `parallelWithCurrent` is refused;
  a CANCELLING run is not live and is refused by the continuation path; queuing into an empty
  queue does not record the child file as the parent definition (no false cycle).
- **Landing step 7 is split over rounds 14–17** (round 13 review; round 14 added a round):
  file-reference editing landed first (round 14), then the inline mode (round 15), then
  `worktreePresets` editing, preview polish and completions (round 16), then the leftovers and
  the audit (round 17).

- **The editor stores `workflow` as step content, like `prompt` and `script`** (round 14): it
  travels in the save message's `text`, so it sits in `schemaUiPropertyRoundTrip`'s
  `NOT_AUTHORABLE` with a content-control guard; the explicit Workflow-mode round trip covers
  it. The inline form's nested keys get their own surface with the inline editor (round 15).
- **A late prompt or script member failing member preflight settles FAILED but never fail-fasts
  its siblings** (round 14): they have no `onFail`; a workflow member follows its `onFail`, and
  without one (`stopWorkflow`) fails the group at the join, as group preflight would.
- **Run Workflow Alongside Current Step is disabled while no step runs** (round 14), like Run in
  Parallel; the queue entries read "Append and Continue…" on any viewed run, as the inline
  siblings do.
- **The editor does not parse a typed workflow path on save** (round 14); a picked file is
  checked by the same resolution as the queue entries (round 15 step 3), and a bad path fails
  the step at launch under its `onFail`. Move to Editor is disabled for an inline workflow step
  until the inline editor lands.
- **The steps panel's per-chunk re-render is a separate bug, not this spec's**
  (`steps-panel-rerenders-on-every-output-entry.md`): it predates the sub-workflow work.
- **No `worktreePresets` editor in the dashboard** (round 15 review). The spec put it "next to
  `conditions`", but `conditions` has no editor: `schemaUiPropertyRoundTrip` lists both as
  author-only catalogs that the dashboard preserves and does not edit. A preset holds a `setup`
  script an agent can run, exactly like a condition script, so it stays author-written YAML.
  Nathan: say if you want a catalog editor for both; it would be one change covering the two.
- **The inline form edits the outer step's name, colour and enabled** (round 15); the wrapped
  step's own copies are kept as written. Agent-queued lanes never write them.
- **Hosted and native picks both go through the backend** (round 15): the editor stores what
  `buildSubWorkflowStepReferenceForClient` returns, relative to the workspace even when picked
  inside the run's worktree. A typed path is still saved unchecked.
- **A settlement failure is logged and reported, never rethrown** (round 16): the run's outcome
  is already recorded, and rethrowing would fail it in the pipeline's catch while a stop settles
  the same worktree. The execution's own error still propagates.
- **Only a stop waiting on a paused run's unwind pre-aborts a settlement wait** (round 16). A stop
  that has returned before settlement starts still queues the lane behind its siblings, as the
  round-11 Decision says.
- **Completions classify steps themselves, not with `isPromptStep`** (round 16): the shared
  helper calls a typeless step with a `script` a prompt step, which a half-typed document often
  is. No inline lane snippet (snippets are one per key), and the hosted editor gets no `workflow`
  path list (it has Browse).
- **D10 compares workflow identity across checkouts** (round 17; the spec was silent on
  worktrees). A file in a linked worktree and the same repo-relative file in its source
  checkout are the same workflow for cycle detection, so the comparison maps every path into one
  frame (the main checkout) before `pathsEqual`.
- **D6 reattaches a file child only if the step still resolves to the recorded file** (round 17;
  the spec was silent). If the `workflow` path was edited since the stop, Continue launches the
  new file fresh, as it would for a step that never ran. An inline child keeps reattaching.
- **CLI `--var` reaches every file child** (round 17, D11): it overrides the child's own `vars`
  as it overrides the root's. VS Code has no host-level vars. An inline child already sees them
  through the parent's effective vars.
- **A workflow step that fails before its child exists still has output** (round 17, D12a): its
  `subWorkflowSettled` is written without a child identity, with outcome `failed` and the
  failure message, and renders as metadata with that message and no children. Sub-workflow steps
  are unreleased, so the event change needs no format bump; read it tolerantly anyway. A child
  that launched but whose run threw settles with its identity and outcome `failed` (round 17
  review).
- **A step edited between file and inline never reattaches across the change** (round 17
  review): a recorded file under an inline step launches fresh, and an inline launch clears the
  recorded file. A file child with no recorded path cannot be confirmed and launches fresh.
- **`run --json` `subWorkflowRuns` lists only children that exist** (round 17); a step that
  failed before its child existed reports the failure in its own result.
- **The `tail: N` hint on a child truncation marker appears only for an end cut** (round 17,
  D12c): when the start was cut, reading the whole step is the rest.
