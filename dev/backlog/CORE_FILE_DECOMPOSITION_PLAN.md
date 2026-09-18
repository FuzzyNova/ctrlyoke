# Core File Decomposition — `WorkflowOrchestrator` and `WorkflowInstance`

> **Status:** Proposed — not implemented. Written 2026-09-17 against current code,
> re-verified 2026-09-17 before staging (see the verification note below).
>
> **Line numbers in this document are indicative, not authoritative.** They were
> taken when it was written; `WorkflowOrchestrator.ts` has since grown from 7,563
> to 7,591 lines, so citations in §1/§4 drift by roughly 30 lines (e.g.
> `buildWorkflowInstance` is at 6261, not 6229; `validateExplicitContinuationTarget`
> at 5119, not 5081). **Always locate a method by symbol name, never by line
> number.** Method *lengths* and the state-ownership claims below were re-measured
> and are accurate.
>
> **Verdict in one line:** yes, split them — but by lifting out the _state each
> cluster privately owns_, not by chopping the files into 2,000-line slices, and
> not by touching the delegation façade that 20+ callers depend on.
>
> **Relationship to neighbours.**
> [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](VSCODE_DEPENDENCY_DECOUPLING_PLAN.md)
> already plans to replace `WorkflowOrchestrator(context, provider)` with an
> options/dependencies object and strip the direct `vscode` imports from both
> files. That plan and this one touch the same constructors, so §8 sequences
> them. [`TESTING_GAPS.md`](TESTING_GAPS.md) records today's coverage for both
> files (96.7% and 92.7%) — that coverage is the safety net this plan spends.

---

## 1. The measurements

Taken 2026-09-17 on `big-feature`.

| File                                         | Lines     | Methods | Field decls | Largest method                       |
| -------------------------------------------- | --------- | ------- | ----------- | ------------------------------------ |
| `src/core/WorkflowOrchestrator.ts`           | **7,563** | 195     | 72          | `startExternalRunWatchSession` — 218 |
| `src/core/WorkflowInstance.ts`               | **6,603** | 136     | 87          | `executeLoadedPromptFile` — **698**  |
| `src/core/WorkflowExecutor.ts`               | 5,220     | —       | —           | (out of scope; see §7)               |
| `src/test/unit/WorkflowOrchestrator.test.ts` | 6,162     | —       | —           | —                                    |
| `src/test/unit/WorkflowInstance.test.ts`     | 4,400     | —       | —           | —                                    |

Worst offenders by method length:

| File                   | Method                               | Lines | Span      |
| ---------------------- | ------------------------------------ | ----- | --------- |
| `WorkflowInstance.ts`  | `executeLoadedPromptFile`            | 698   | 1871–2568 |
| `WorkflowInstance.ts`  | `startWorkflowExecution`             | 435   | 5534–5968 |
| `WorkflowInstance.ts`  | `buildWorkflowExecutionContext`      | 385   | 4353–4737 |
| `WorkflowInstance.ts`  | constructor                          | 188   | 552–739   |
| `WorkflowOrchestrator` | `startExternalRunWatchSession`       | 218   | 6903–7120 |
| `WorkflowOrchestrator` | `buildWorkflowInstance`              | 174   | 6229–6402 |
| `WorkflowOrchestrator` | `validateExplicitContinuationTarget` | 159   | 5081–5239 |
| `WorkflowOrchestrator` | `setStartPositionAtRun`              | 155   | 4523–4677 |

`executeLoadedPromptFile` alone is 10.6% of its file and would be the 13th
largest file in `src/core/orchestration/` if it stood by itself.

---

## 2. The honest case _against_ splitting, and where it fails

The strongest argument for leaving these alone is real, so state it properly:

**Both files are composition hubs, and composition hubs are legitimately
large.** `WorkflowOrchestrator` is the registry plus the public façade the
webview router, hosted server, MCP server and CLI all call. A large share of its
195 methods are two-line delegations (`async pause() { return
this.getActiveInstance().pause(); }`). Shattering a façade across five files
buys nothing: the reader still has to visit five files to answer "what can I
ask the orchestrator to do?", and the import graph gets worse, not better.
`WorkflowInstance` has the same shape one level down — `core.instructions.md`
defines it as the thing that "composes queue, executor, history, watchers, and
execution integrations," and composition roots are wide by construction.

That argument covers maybe 1,500 of the orchestrator's 7,563 lines. It does not
cover the rest, and three measurable facts say so:

1. **Neither class delegates the state it owns — it owns ten registries
   outright.** `WorkflowOrchestrator` privately holds `instances`,
   `retiredInstances`, `viewerRegistry`, `viewAddressRegistry`,
   `viewMessageSinks`, `lineageBindingClients`, `lineageExecutionOwners`,
   `externalRunSessions`, `coordinationWatchSessions` and
   `polledRunnerJsonMtimes` (lines 339–443). A façade holds a pointer to one
   thing. Ten independent lifetimes in one object is four or five
   responsibilities wearing a façade's coat.

2. **The class is not constructible in tests, and production code has been bent
   to accommodate that.** `WorkflowOrchestrator.test.ts` uses
   `Object.create(WorkflowOrchestrator.prototype)` **60 times** (57 when written;
   re-counted 2026-09-17), then hand-sets
   private fields. Note the call is Prettier-wrapped across two lines, so a
   single-line `grep "Object.create(WorkflowOrchestrator.prototype)"` reports
   **zero** — that is a grep artifact, not evidence the doubles are gone. Match
   on `Object.create` alone. Three production accessors exist _only_ to serve those
   doubles — `getViewAddressRegistry()` (now line 3121),
   `getViewMessageSinks()` (3132) and `getLineageBindingClients()` (3142), each
   carrying the comment _"Defensive for lightweight unit-test instances created
   without constructors."_ That is test-shaped code in the production file, and
   it is a direct symptom of the class being too big to build. By contrast
   `WorkflowInstance.test.ts` uses `Object.create` **zero** times — it calls
   `new WorkflowInstance(...)` — which is the standard the orchestrator should
   be held to.

3. **The file has outrun its own header.** The class doc-comment (lines 157–173)
   still says _"Four harness integrations"_ (there are six — fields 458–463) and
   _"Phase 1: Always holds exactly one WorkflowInstance"_ (it holds a `Map` plus
   a retirement map). Nobody rereads a 7,500-line header. Documentation rot at
   the top of a file is a reliable tell that the file is past the size where
   anyone holds it in their head.

**Conclusion:** split, but the goal is not a line count. The goal is that
**every piece of mutable state has an owner small enough to read in one
sitting**, and the façade stays exactly where callers expect it.

---

## 3. Design rules for every extraction below

1. **Extract state, not line ranges.** A candidate qualifies only if it owns
   fields nothing else touches. If the fields stay behind, the extraction is a
   file split, not a decomposition, and it makes things worse.
2. **The public façade does not move.** Every currently-public method on
   `WorkflowOrchestrator` and `WorkflowInstance` keeps its name, signature and
   home, and becomes a delegation. 20+ files outside `src/core/` call these; see
   §6.
3. **New collaborators live in `src/core/orchestration/`** (orchestrator-level)
   — that directory is already the established home for exactly this (35 files,
   `WorktreeManager`, `RunContinuationService`, `OutputHistoryManager`, …).
4. **Every collaborator is constructible with plain arguments** and takes its
   host-facing needs as narrow injected ports, never a back-reference to the
   parent class. A collaborator that takes `orchestrator: WorkflowOrchestrator`
   has moved the coupling, not removed it.
5. **Nominal relationships** per `copilot-instructions.md`: each new collaborator
   gets a declared interface for the port it consumes, and test doubles get
   `implements` clauses. No `as unknown as { … }` bridges.
6. **One extraction per commit**, each green on `npm test` on its own.

---

## 4. `WorkflowOrchestrator` — four extractions

### 4.1 `ExternalRunWatchCoordinator` — CLI watch mode (~1,000 lines)

**Source:** lines 6564–7563, the whole `// CLI Watch Mode` region —
`setupExternalRunWatching`, `discoverWorktreesOnActivation`,
`setupRunnerJsonCreateWatcher`, `pollRunnerJsonDiscovery`,
`handleRunnerJsonEvent`, `startExternalRunWatchSession(IfExternal)`,
`broadcastExternalRunStepStatuses`, `sendExternalRunFullStateToDashboard`,
`replayExternalHistoryFileTo`, `replayExternalWatchHistoryFile`,
`handleExternalRunWatchOutput`, `handleExternalRunFinished`,
`restartExternalRunWatchSession`, plus `ensureExternalRunWatchSession`,
`resolveExternalExecutionForPath`, `shouldDeclineUntrackedOwnership` and
`stopExternalRunSession`.

**State it takes with it:** `externalRunSessions`, `runnerJsonCreateWatcher`,
`runnerJsonDiscoveryPollInterval`, `polledRunnerJsonMtimes`,
`lastLoggedExternalExecutionDecision`, `activationWorktreeOwnership`.

**Why this one is first:** it is the largest single cluster _and_ the least
coupled. Across those 1,000 lines the region reaches only eight members it does
not own — `dashboardBroadcastHub`, `lineageRepository`, `instances`,
`retireWorkflow`, `currentWorkspaceFolder`, `saveState`,
`getOutputHistoryManager`, `runnerHostIdentity`. It already delegates the hard
part to `orchestration/ExternalRunWatchSession.ts` and
`orchestration/ExternalExecutionResolver.ts`; this is the supervisor around
them, and it has no business being inline.

**Port:** `ExternalRunWatchHost` — `{ broadcast, lineageRepository,
findInstanceForWorkingFile, retireWorkflow, workspaceRoot, saveState,
outputHistoryManager, runnerHostIdentity }`.

**Risk: low.** Behaviour is observable through the dashboard broadcast hub, and
the existing tests drive it through `handleRunnerJsonEvent` / the session's
finish callbacks — both of which survive as public methods on the collaborator.

---

### 4.2 `WorkflowInstanceRegistry` — instances, retirement, viewers (~700 lines)

**Source:** `createWorkflow` (717–821), `promoteInstanceToLive`,
`retireWorkflow`, `getWorkflow`/`getAllWorkflows`/`getRunningWorkflows`/
`getActiveWorkflow(Id)`, `findInstance`, `getActiveInstance`,
`getInstanceForClient`, `getBoundInstance`, `findInstanceForLineage`,
`registerNewInstance`, `registerClient`, `unregisterClient`,
`getViewedWorkflowId`/`setViewedWorkflowId`, `isWorkflowViewedByAnyClient`,
`buildWorkflowInstance` (6229–6402), `adoptInstanceLineageAddress`.

**State it takes with it:** `instances`, `retiredInstances`, `viewerRegistry`,
`viewAddressRegistry`, `viewMessageSinks`, `lineageBindingClients`,
`lineageExecutionOwners`, `externallyCreatedInstanceIds`,
`announcedExternalWorkflowIds`.

**Why it's second:** §4.3 and §4.4 both need a registry they can talk to through
an interface. Extracting it first turns those from "tangled" into "mechanical."
It is also what kills the three defensive accessors from §2.2 — a registry
constructed with its own maps cannot be half-built, so
`getViewAddressRegistry()` and friends collapse back into plain field access and
the 60 `Object.create` doubles can construct a real registry instead.

**Note on `buildWorkflowInstance` (174 lines):** this is the wiring that
supplies `WorkflowInstance`'s 17 constructor arguments. It should move as-is
here now, and is the natural place for
`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`'s options-object conversion to land
later (§8).

**Risk: medium.** The largest blast radius of the four, because it is where the
`Object.create`-based tests do most of their field-poking. Budget the test
rewrite (§6) as the bulk of this phase's work, not the production change.

---

### 4.3 `RunViewPublisher` — addressed run views (~700 lines)

**Source:** `loadRunViewForClient`, `publishRunViewToClients`,
`readAddressedRunView`, `deliverRunView` (3426–3544),
`loadRunSummariesForClient`, `publishRunRevisionsToViewers`,
`publishViewIdentityToViewers`, `buildViewIdentityForAddress`,
`bindClientToAddressedLineage`, `invalidateRunViews`,
`invalidateRunViewProperties`, `invalidateRunViewStepColor`,
`pushRunSummariesRefreshIfNotAlreadyViewing`, `resolveAddressFilePath`,
`resolveAddressDirectory`, `getViewAddress`, `getViewFilePath`,
`getViewIdentity`.

**Depends on §4.2.** Measured, this region reaches `instances`,
`retiredInstances`, `findInstance`, `findInstanceForLineage`,
`loadFreshInstanceAndReplay`, `setViewedWorkflowId` and the three view
registries — i.e. it is _entirely_ a consumer of the registry. Attempting it
before §4.2 means passing a `WorkflowOrchestrator` back-reference, which rule
§3.4 forbids.

**Risk: medium.** This is the read path the dashboard lives on; a regression is
immediately visible but not silent. Verify with the run-view assertions already
in `WorkflowOrchestrator.test.ts` plus a hosted-dashboard smoke run
(`npm run dev:host:start`).

---

### 4.4 `RunLifecycleService` — seed / continue / discard / delete (~900 lines)

**Source:** `setStartPositionAtRun` (155), `seedAndExecuteAtRun`,
`executeDraftAtAddress`, `startNewRunInsteadAtRun`, `appendAndContinueAtRun`,
`continueAtRun`, `validateExplicitContinuationTarget` (159),
`discardContinuationAtRun`, `commitPendingRewindRevision`, `deleteRunAtAddress`,
`deleteAllRunsForLineage`, `switchClientToRunAddress`,
`switchClientToPreparedExecution`, `closeLineageTerminalsForFreshRun`,
`findExecutionRunRef`, `findResidentInstanceForRun`, `assertViewedRunAddress`,
`describeViewAddress`.

These are the orchestrator's genuinely _algorithmic_ methods — the ones that
decide which `RunRef` an action applies to and whether it is legal. They already
lean on `orchestration/RunContinuationService.ts`; this consolidates the
decision layer beside it.

**Risk: medium-high** — highest semantic risk of the four (run identity bugs are
the expensive kind), which is why it goes last on the orchestrator side, after
the registry and view layers are stable and independently tested.

**Explicitly deferred:** `prepareDefinitionMutation` /
`applyRunAddressedMutation` and the step-mutation delegations
(`updatePromptInQueue`, `updateStepColorInQueue`,
`insertWorkflowStepAfterIndex`, `deletePromptFromQueue`,
`reorderPendingPrompts`, `syncStepsForUndoRedo`, …) stay put. They are the
façade of §3.2 doing its job: each resolves an instance and forwards. Moving
them creates a second façade in front of the first.

**Orchestrator after all four:** roughly **3,400–3,800 lines**, of which ~1,200
is one-to-three-line delegation. Not under 2,000 — see §9 on why that is the
right answer rather than a failure.

---

## 5. `WorkflowInstance` — four extractions

### 5.1 `ExecutionStartupPipeline` — the 698-line method (~1,650 lines)

**This is the single highest-value change in the plan.**

**Source:** `executeLoadedPromptFile` (1871–2568),
`buildWorkflowExecutionContext` (4353–4737), `startWorkflowExecution`
(5534–5968), `warnBeforeWorkflowStart`, `computeTargetRunIndices`,
`prepareFinalStepContinuation`, `describeExecutionFailure`,
`describeLeaseConflict`.

`executeLoadedPromptFile` is not one thing that happens to be long. Read
top-to-bottom it is seven sequential phases followed by a ~190-line `catch`:

| Phase                          | What it decides                                                        |
| ------------------------------ | ---------------------------------------------------------------------- |
| 1. Continuation classification | `isAppendContinuation` / `isIdleContinuation` / fresh start            |
| 2. Secrets preflight           | `approveSecretGrants` → `preflightWorkflowSecrets`                     |
| 3. Worktree resolution         | `resolveWorktreeForWorkspace` → `worktreeResolution` + notice          |
| 4. Compatibility preflight     | `analyzeWorkflowCompatibility`; hard-fails before `EXECUTION_STARTED`  |
| 5. Harness readiness           | waits out `Initializing`/`Waiting` (35 s window), bails on unavailable |
| 6. Run promotion + history     | promote `RunRef`, init history file, `ensureRunnerLock`                |
| 7. Worktree + integration      | `prepareExecutionWorktree` → `createIntegrationForMode` → dispatch     |
| catch                          | failure finalization — the subtlest code in the file (see below)       |

The `catch` block carries four separately-commented invariants that each cost
real debugging to establish: report the failed step index _before_ flipping to
`ERROR` (because `finalizeFailedInFlightPrompt` has already advanced
`currentIndex`); settle a provisioned worktree that never reached
`startWorkflowExecution`'s `finally`; release the lineage lock; and finalize a
run promoted by _this_ call even when the throw beat `historyFilePath` being
assigned — otherwise the lineage shows a permanently-RUNNING run that retention
never prunes. Those four rules are load-bearing and currently discoverable only
by reading 190 lines of a 698-line method.

**Shape:** a `WorkflowStartupPipeline` class holding the run-scoped locals that
are today `let`s threaded through the whole method (`historyFilePath`,
`promotedRunRef`, `worktreeNotice`, `missingSecretNames`,
`compatibilityDiagnostics`) as fields, with one method per phase and a single
`finalizeFailure(error)` that owns the four invariants above — each as its own
named, individually testable method.

**Payoff:** the four failure invariants become four unit tests instead of four
comments. Today there is no way to test "a throw from `initializeRunAt` still
finalizes the promoted run" without driving the entire 698-line path.

**Risk: high** — the highest in this plan, and the reason it ships **last** on
the instance side, after §5.2–§5.4 have already shrunk the surface around it.
Mandatory: no behaviour change in the same commit, and diff the phase order
against the original line-by-line before merging.

---

### 5.2 `SessionActivityRecorder` — resumed-session persistence (~470 lines)

**Source:** lines 3784–4251 — `getActivityIntegrationId`,
`getActivitySessionKey`, `getActivityTargetKey`, `recordCompletedActivityTarget`,
`beginActivityTargetCapture`, `getExecutionTargetRunKey`,
`handleSessionActivityResumed`, `enqueueFollowUpPersist`,
`persistResumedSessionActivity` (135 lines), `publishOutputActivity`.

**State it takes with it:** `activityIntegrationIds`,
`nextActivityIntegrationId`, `completedActivityTargets`,
`latestCompletedActivityBySession`, `pendingSessionActivityEvents`,
`pendingSessionActivityIntegrations`, `followUpPersistQueue`, and the
`lastCompletedActivityTarget` / `legacyCompletedActivityTarget` pair.

**Why it's first on this side:** best coupling ratio in either file — it owns
12 fields and borrows only five members (`id`, `dashboardSink`, `promptQueue`,
`outputHistoryManager`, `resolveHistoryFilePath`, `getDefinitionRevisionContext`).
Eight private maps whose entire purpose is de-duplicating resumed-session
activity have no reason to sit in the same scope as the execution state machine.

**Risk: low.**

---

### 5.3 `RunnerLockCoordinator` — lock + stop-request polling (~100 lines)

**Source:** `ensureRunnerLock` (5435), `startStopRequestPolling`,
`stopStopRequestPolling`, `pollStopRequest`, `releaseRunnerLock`.
**State:** `currentLockOwnerToken`, `stopRequestPollInterval`,
`stopRequestPollInFlight`, `heartbeatInterval`.

Small, but it is a self-contained protocol (acquire → heartbeat → poll for a
cross-process stop sentinel → release) whose failure mode is the documented
"stale `runner.json` with a dead PID causes false _already running_ errors."
A named owner makes that protocol legible and directly testable. Cheap; do it
early as a warm-up for §5.1.

**Risk: low.**

---

### 5.4 `ExecutionWorkspaceProvisioner` — worktree lifecycle (~420 lines)

**Source:** `configureExecutionWorkspace`, `createWorktreeSetupRunner` (91),
`getNextWorktreeSetupAttemptIndex`, `prepareExecutionWorktree` (80),
`abandonActiveWorktree` (50), `releaseNamedWorktreeRetentionAfterPtyExit`,
`cleanupRetainedIntegrationArtifacts`, `cleanupIntegrationArtifactsForSettlement`,
`reportUnresolvedWorktreeVariables`.
**State:** `activeWorktree`, `activeWorktreeSettlement`, `worktreeResolution`,
`executionWorkspace`, `executionWorkspaceIdentity`,
`retainedIntegrationArtifactContexts`, `executionLease`.

**Caveat — this is the loosest of the four.** Measured, the cluster reaches ~31
distinct members, including `releaseRunnerLock`, `stopStopRequestPolling` and
`workflowRuntime`. Do §5.3 first so the lock calls become a collaborator call
rather than a private one; if the remaining reach is still above ~15 after that,
**stop and reassess** rather than forcing it. A collaborator that needs 30
callbacks is worse than the method it replaced.

**Risk: medium-high.** Managed-worktree bugs strand user work in an unmerged
checkout.

**Also worth doing, cheaply, alongside:** `initializeEphemeralPrompt` /
`executeEphemeralPrompt` / `executeEphemeralParallelPrompt` /
`syncParallelGroupTerminalSessions` / `buildEphemeralPromptSeed` (~340 lines,
region 3427–3750) is a clean, well-bounded `EphemeralPromptRunner`. It is not on
the critical path for anything else, so treat it as an optional filler phase.

**Instance after §5.1–§5.4:** roughly **2,800–3,200 lines**, with no method over
~150.

---

## 6. Tests

The test files are 6,162 and 4,400 lines and must be split in step with the
production files — a 6,000-line test file is the same problem with worse
tooling. Rules:

- **Each extraction ships with its own `src/test/unit/<Collaborator>.test.ts`**,
  carrying over the assertions that were exercising that behaviour through the
  parent.
- **Retire `Object.create(WorkflowOrchestrator.prototype)` as you go.** All 60
  uses exist because the class cannot be constructed; every extraction converts
  some of them into `new <Collaborator>(...)` with real arguments. Track the
  count down — it is the cleanest single progress metric this plan has. When it
  reaches zero, delete the three defensive accessors at lines 3082/3094/3104 and
  their comments.
- **Do not let the parent test file keep tests that no longer touch the
  parent.** Move them; a delegation deserves at most one "it forwards" test.
- Per `copilot-instructions.md`, test doubles get an `implements` clause for
  each port they stand in for — including the new collaborator ports.

Coverage is currently 96.7% (orchestrator) and 92.7% (instance). **Treat any
drop as a blocking regression for the phase**, not a follow-up: that coverage
is the entire reason this refactor is affordable.

---

## 7. Explicitly out of scope

- **`WorkflowExecutor.ts` (5,220 lines)** and **`PromptQueue.ts` (3,282)** are
  over the threshold too, but they have single, sharply-defined owners that
  `core.instructions.md` names (`WorkflowStateMachine` owns status; `PromptQueue`
  owns topology). They are large-but-cohesive in a way the two files here are
  not. Revisit only after this plan lands, as a separate document.
- **`orchestration/WorktreeManager.ts` (3,377 lines)** — same reasoning; it is
  already an extracted collaborator with one job.
- **Renaming or resignaturing any public method** on either class. §3.2.
- **Behaviour change of any kind.** If a bug is found mid-extraction, note it
  and fix it in a separate commit before or after — never inside a move.

---

## 8. Sequencing, including against the decoupling plan

`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md` Phase 1 converts
`WorkflowOrchestrator(context, provider)` to an options object and removes the
inline `new VsCodeAdapter(...)` calls. It touches the constructor and
`buildWorkflowInstance` — exactly what §4.2 moves.

**Run the decoupling plan's Phase 1 first.** Reasons: it is smaller; it makes
both classes constructible without a VS Code host, which is precisely what the
new collaborators' tests need; and doing it second would mean re-applying it
across five files instead of one.

> **✅ Order 0 is already done (verified 2026-09-17).**
> `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md` records Phase 1 as complete, and the
> code agrees: `WorkflowOrchestrator`'s constructor is
> `constructor(dependencies: WorkflowOrchestratorDependencies)` (line 550), and
> **neither `WorkflowOrchestrator.ts` nor `WorkflowInstance.ts` imports `vscode`
> at all.** Phase 1 below is therefore the real starting point — do not re-do the
> decoupling work.

| Order | Phase                                | Lines moved | Risk        | Unblocks   |
| ----- | ------------------------------------ | ----------- | ----------- | ---------- |
| 0     | Decoupling plan, Phase 1 — ✅ DONE   | —           | —           | all        |
| 1     | §4.1 `ExternalRunWatchCoordinator`   | ~1,000      | low         | —          |
| 2     | §5.2 `SessionActivityRecorder`       | ~470        | low         | —          |
| 3     | §5.3 `RunnerLockCoordinator`         | ~100        | low         | §5.4       |
| 4     | §4.2 `WorkflowInstanceRegistry`      | ~700        | medium      | §4.3, §4.4 |
| 5     | §4.3 `RunViewPublisher`              | ~700        | medium      | —          |
| 6     | §5.4 `ExecutionWorkspaceProvisioner` | ~420        | medium-high | —          |
| 7     | §4.4 `RunLifecycleService`           | ~900        | medium-high | —          |
| 8     | §5.1 `ExecutionStartupPipeline`      | ~1,650      | high        | —          |

Phases 1–3 are independent and low-risk; if the appetite for this work turns out
to be small, **doing only those three is a real win** (~1,570 lines out, three
new tested collaborators, zero architectural risk) and leaves a clean stopping
point. Phase 8 is the one that matters most and the one to attempt only with the
rest already in place.

Per phase: `npm run typecheck && npm run lint && npm test` (read the
`TEST SUMMARY:` block — do not re-run to check), plus a `npm run dev:host:start`
smoke for phases 5 and 7, which touch the live dashboard read path.

---

## 9. The success criterion is not 2,000 lines

Neither file lands under 2,000 without shredding the façade, and that would be
the wrong trade. The targets that matter:

- **No method over ~150 lines.** Today four exceed it, one by 4.6×.
- **Every mutable field has an owner under ~1,000 lines.** Today ten registries
  and twenty-odd runtime maps share two objects.
- **Zero `Object.create(prototype)` test doubles**, and zero production
  accessors that exist to serve them.
- **Anything a reader needs to hold in their head at once fits in one file.**
  A 3,500-line façade of delegations satisfies this; a 700-line method does not.

If a phase does not move at least one of those four, it is a file split and
should not be done.

---

## 10. Execution log

Each phase updates this table as it lands, so the next session can tell what is
already done without re-deriving it from `git log`. Keep the "Notes" column to
one line — deviations, deferrals, or a reassessment outcome.

| Phase                                | Status      | Commit | Notes |
| ------------------------------------ | ----------- | ------ | ----- |
| Decoupling plan, Phase 1             | ✅ Done     | (prior) | Verified 2026-09-17: options-object ctor, no `vscode` imports in either file. |
| §4.1 `ExternalRunWatchCoordinator`   | ✅ Done     | 7cbcc7d6 | Added `fileWatcherFactory` to the narrow host port because the coordinator owns watcher setup; updated affected object-create harnesses. |
| §5.2 `SessionActivityRecorder`       | ✅ Done     | ce340986 | Extracted resumed-session activity state and persistence with a narrow port; carried the parent assertions into its own suite. |
| §5.3 `RunnerLockCoordinator`         | ✅ Done     | 4f5b2825 | Extracted lock acquire/heartbeat/stop polling/release state and added stale-runner-lock recovery coverage. |
| §4.2 `WorkflowInstanceRegistry`      | Not started | —      | |
| §4.3 `RunViewPublisher`              | Not started | —      | |
| Test-double retirement               | Not started | —      | Retire `Object.create` doubles; delete the three defensive accessors. |
| §5.4 `ExecutionWorkspaceProvisioner` | Not started | —      | Has a stop-and-reassess gate; record the outcome here either way. |
| §4.4 `RunLifecycleService`           | Not started | —      | |
| §5.1 `ExecutionStartupPipeline`      | Not started | —      | Split across two sessions: phase extraction, then context/startup + failure invariants. |

**Optional, not scheduled:** the `EphemeralPromptRunner` filler noted in §5.4
(~340 lines, region 3427–3750) remains available but is not on the critical path
for any other phase.
