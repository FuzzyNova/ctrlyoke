# Multi-Instance Runner Ownership Hardening Plan

> **Status:** Proposed
>
> **Priority:** P1 — recurring workflow-correctness issue
>
> **Relationship:** Follow-up hardening for
> `dev/implemented/MULTI_INSTANCE_WORKSPACE_COORDINATION_PLAN.md`

## Problem Statement

The multi-instance coordination implementation correctly preserves live runner
locks and supports read-only observation of workflows owned by a CLI or sibling
VS Code instance. However, the current lock inspection vocabulary does not
distinguish a lock owned by this Extension Host from one owned by a sibling
Extension Host.

`WorkflowLockInspector.inspectWorkflowLock()` currently reduces every live
VS Code lock to `active-vscode`. Several `WorkflowOrchestrator` entry points then
interpret `active-vscode` as “owned by another VS Code instance.” That inference
is invalid: it only means that a live VS Code runner owns the lock.

This ambiguity has produced a recurring class of bugs where one VS Code instance
observes its own live or retained lock and takes an external-owner path. Effects
have included:

- a completed workflow being synthesized as externally running while an inject
  PTY retained its runner lock;
- a local workflow being considered for replacement by a read-only external
  watch session;
- auto-load and working-file routing treating a local run as externally managed;
- continuation guards reporting that a run is executing “in another process”
  without proving that the owner is another process;
- sibling-stop behavior becoming reachable for a lock that may belong to the
  requester itself.

The terminal-state check added after the retained-lock incident is an important
invariant and must remain: a live lock says who retains execution ownership, not
that the persisted run is still executing. It does not by itself solve the
owner-locality ambiguity.

## Current Semantic Gaps

### `active-vscode` combines liveness, runner type, and locality

The current `LockStatus` values answer two separate questions at once:

1. Is the lock absent, stale, or active?
2. If active, which runner type wrote it?

They do not answer a third question that external routing requires:

3. Is the active owner this host or another host?

Code that sees `LOCK_STATUS.ACTIVE_VSCODE` therefore has no evidence from which
to infer external ownership.

### The documented `instanceId` meaning does not match the writer

`WorkflowRunnerLock.instanceId` is documented as a UUID generated once at VS
Code extension activation or CLI startup. `WorkflowInstance.acquireRunnerLock()`
currently writes `WorkflowInstance.id`, which is generated once per workflow
instance instead.

That workflow-execution identity is useful, but it cannot serve as a stable
identity for every lock written by one Extension Host. The schema needs separate
names for host identity and workflow execution identity.

### External routing is decentralized

Ownership-like decisions currently occur across startup normalization and
discovery, recent-workflow loading, automatic loading, explicit working-file
loading, continuation validation, stop requests, output/history operations, and
worktree safety checks. Some only need lock liveness; others need actual external
ownership. A coarse shared status makes it easy for a new call site to choose the
wrong interpretation.

### Existing sibling fixtures cannot prove sibling ownership

Several unit fixtures create a purported sibling VS Code lock with
`pid: process.pid`. Because no caller host identity participates in inspection,
the test can only prove “active VS Code lock,” not “sibling-owned lock.” This
allows the production ambiguity to be reproduced in tests as if it were desired
behavior.

## Goals

1. Give every VS Code activation and CLI startup an explicit host identity.
2. Distinguish lock liveness, runner type, and owner locality in the type system.
3. Make it impossible to start an external watch from a merely `active-vscode`
   observation.
4. Keep persisted execution state authoritative for whether a run is active.
5. Revalidate the exact lock acquisition before and during external observation.
6. Test both halves of the protocol: self-owned in the owner and external-owned
   in a sibling sharing the same run-storage directory.
7. Make future ownership-sensitive call sites easy to audit.

## Non-Goals

- Preventing multiple VS Code windows from opening the same workspace.
- Workspace-wide leader election or distributed consensus.
- Restoring in-memory workflow instances after an Extension Host restart.
- Merging mutable dashboard state between hosts.
- Replacing per-lineage runner locks or `ExecutionRootLeaseManager`.
- Treating a lock as proof that a workflow is running.
- Exposing host UUIDs, PIDs, or owner tokens to dashboard clients.

## Ownership Invariants

All implementation work in this plan must preserve the following invariants.

### External execution requires three independent facts

A run is externally executing only when:

1. its persisted `_runtime.executionState` is in `ACTIVE_EXECUTION_STATES`;
2. an active lock names the same `workflowKey` and exact `RunRef`; and
3. ownership classification says the active lock belongs to another host.

No one of these facts may stand in for either of the others.

### Host identity determines locality

- A matching host ID is self-owned.
- A different host ID is external-owned when the lock otherwise validates.
- PID equality is a defense-in-depth self-process check and diagnostic
  invariant, not the primary durable identity.
- A contradictory identity, such as different host IDs with the same PID, must
  never be silently labeled as a sibling process. It is an indeterminate local
  invariant failure and must follow a safe, non-mutating path.

### Owner token determines the acquisition

`ownerToken` continues to identify one exact acquisition. Heartbeat, release,
stop-request, and watch-session revalidation must match it. Host identity must
not weaken the existing owner-token protections against an old owner touching a
successor's lock.

### Unknown ownership is not external proof

Malformed, contradictory, or incomplete identity data must not authorize:

- an external-owner banner;
- a sibling VS Code stop request;
- retirement of a local `WorkflowInstance`;
- mutation or deletion of the observed lock;
- an error message claiming “another process.”

Unknown active ownership should preserve data, log a structured diagnostic, and
surface a neutral ownership-conflict state if user interaction requires one.

### Self-owned but untracked is an invariant failure

If a lock belongs to this host but no resident or deliberately retained local
execution record accounts for it, the orchestrator must not convert it into an
external watch. It should reconcile against local registries where possible and
otherwise log/report a same-host ownership inconsistency.

## Proposed Architecture

### 1. Separate host identity from workflow execution identity

Add a shared Node-side identity type:

```ts
interface RunnerHostIdentity {
  runner: RunnerId;
  hostInstanceId: string;
  pid: number;
}
```

Generate `hostInstanceId` exactly once:

- during VS Code extension activation for the Extension Host;
- during CLI startup for the CLI process;
- once per independently constructed host in tests.

Pass the identity explicitly through construction rather than relying on a
mutable process-global singleton. Explicit injection makes ownership decisions
testable and prevents two orchestrator fixtures in one test process from
silently sharing an identity.

Revise `WorkflowRunnerLock` to use unambiguous fields:

```ts
interface WorkflowRunnerLock {
  schemaVersion: 2;
  workflowKey: WorkflowKey;
  runRef: RunRef;
  runner: RunnerId;
  pid: number;
  hostInstanceId: string;
  executionInstanceId: string;
  ownerToken: string;
  startedAt: number;
  lastHeartbeat: number;
}
```

`executionInstanceId` is the current `WorkflowInstance.id`. The CLI must provide
the corresponding per-execution identifier from its execution context. Do not
reuse `hostInstanceId` as a workflow/dashboard ID.

Because the project is pre-release, migrate the schema cleanly rather than
keeping two indefinitely supported meanings for `instanceId`. Still handle an
old or incomplete on-disk lock safely during a development upgrade: validate it
as legacy/indeterminate, use PID equality to prevent self-as-external, preserve
it while live, and never allow it to authorize destructive ownership actions.

### 2. Replace runner-specific lock statuses with structured inspection

Remove ownership-sensitive use of `LOCK_STATUS.ACTIVE_VSCODE` and
`LOCK_STATUS.ACTIVE_CLI`. Prefer an orthogonal result:

```ts
type WorkflowLockInspection =
  | { liveness: "absent" }
  | { liveness: "stale"; lock: WorkflowRunnerLock }
  | {
      liveness: "active";
      locality: "self" | "external" | "indeterminate";
      lock: WorkflowRunnerLock;
    };
```

The lock itself carries the runner type, so a status string does not need to
duplicate it. `WorkflowLockInspector` should be the only module that combines:

- lock parsing and schema validation;
- PID/heartbeat liveness;
- observer host identity;
- owner-locality classification.

Consumers that only care whether any owner is active, such as worktree safety,
must inspect `liveness` without interpreting locality. Consumers that claim
external ownership must narrow to `{ liveness: "active", locality: "external" }`.

Provide named type guards or resolver functions rather than duplicating string
comparisons:

```ts
isActiveLock(inspection);
isSelfOwnedLock(inspection);
isExternalOwnedLock(inspection);
```

Avoid boolean parameters such as `includeSelf` or `treatVscodeAsExternal`; they
reintroduce ambiguous call-site policy.

### 3. Add one external-execution eligibility resolver

Introduce a core orchestration service that resolves the complete external-run
decision. A possible shape is:

```ts
type ExternalExecutionResolution =
  | { kind: "not-external"; reason: NotExternalReason }
  | {
      kind: "external-active-run";
      workingFile: WorkingFile;
      inspection: ActiveExternalLockInspection;
    };
```

The resolver must:

1. parse the addressed `workflowKey` and `RunRef` from the exact working file;
2. read and validate the working file;
3. reject terminal or missing persisted execution state;
4. inspect the lock relative to the caller host identity;
5. require an active external owner;
6. require the lock's `workflowKey` and `runRef` to match the addressed file;
7. return the inspected lock, including `ownerToken`, as proof for the caller.

Use stable internal reason codes such as:

- `terminal-run`;
- `no-active-lock`;
- `self-owned`;
- `indeterminate-owner`;
- `run-ref-mismatch`;
- `unreadable-working-file`.

This resolver becomes the single source of truth for all external-watch routing.
It should invalidate/re-read as needed to avoid relying on a cached run summary.

### 4. Require external proof to create a watch session

Rename legacy CLI-centric orchestration surfaces:

- `cliSessions` → `externalRunSessions`;
- `startCliWatchSession()` → `startExternalRunWatchSession()`;
- `handleCliSessionFinished()` and related helpers → runner-neutral names where
  they handle both CLI and sibling VS Code owners.

`startExternalRunWatchSession()` must accept an
`ActiveExternalLockInspection`, not a caller-provided `managedBy: RunnerId`.
Derive runner labels and stop behavior from `inspection.lock.runner`.

The method must re-read the lock immediately before registration and require the
same `ownerToken`, `workflowKey`, and `runRef`. This closes the time-of-check to
time-of-use window in which an owner could finish and a successor could acquire
the lineage between resolution and session creation.

`ExternalRunWatchSession` should retain this identity proof and end or request a
fresh resolution when any of the following occurs:

- the working file becomes terminal;
- the lock disappears or becomes stale;
- the lock's `ownerToken` changes;
- the lock changes runner, host identity, workflow key, or run ref;
- ownership reclassifies as self or indeterminate for the observing host.

It must not continue observing a replacement acquisition merely because the
replacement lock is also active.

### 5. Make summary ownership explicit

`WorkflowSummary.managedBy` currently overloads runner type and external
locality: undefined means local VS Code, while `vscode` means external VS Code.
Replace it with an explicitly external projection, for example:

```ts
interface ExternalExecutionOwnerSummary {
  locality: "external";
  runner: RunnerId;
}

interface WorkflowSummary {
  externalOwner?: ExternalExecutionOwnerSummary;
}
```

Do not serialize `hostInstanceId`, PID, or `ownerToken` to the webview. Those are
coordination internals. The UI only needs to know that the run is external and
which runner label/control policy applies.

Update `getExternalRunnerLabel`, read-only selectors, header/banner rendering,
running-workflow items, stop routing, and browser/webview replay to derive their
behavior from `externalOwner`. A local VS Code summary must be structurally
incapable of looking externally VS Code-managed solely because its runner is
`vscode`.

## Call-Site Migration Audit

Migrate every `WorkflowLockManager.checkLock()`, `readLock()`,
`inspectWorkflowLock()`, `LOCK_STATUS.ACTIVE_VSCODE`, and
`LOCK_STATUS.ACTIVE_CLI` use. Classify each call site by the question it is
actually asking.

### External-routing consumers

These must use the complete external-execution resolver:

- `WorkflowOrchestrator.ensureCliWatchSession()`;
- activation discovery in `setupCliWatching()` /
  `findActiveVscodeRunFiles()`;
- recent-session automatic loading in `triggerAutoLoad()`;
- explicit `loadWorkingFile()` and addressed workflow-view loading;
- runner-lock file discovery that creates an external session;
- any dashboard/browser replay path that announces `managedBy` or an external
  owner;
- `requestVscodeStop()` before writing an owner-token-scoped stop request.

External routing must never be selected directly from `lock.runner`.

### Execution-conflict consumers

These need structured locality so their behavior and messages are accurate:

- explicit continuation validation;
- run continuation services;
- any “another process is executing” guard;
- workflow start/acquire conflict reporting.

Use distinct outcomes for:

- a local resident execution;
- a self-owned but untracked invariant failure;
- a proven external execution;
- an active lock with indeterminate locality;
- a stale/orphaned run that may be recovered.

Do not make an active run adoptable merely because its owner is self but the
expected in-memory instance was not found.

### Liveness-only consumers

These should use `inspection.liveness` and must not infer UI ownership:

- startup stale-run normalization;
- `OutputHistoryManager` recovery checks;
- `WorktreeManager` pruning and in-use safety checks;
- heartbeat/staleness monitoring;
- CLI mutual-exclusion checks where any active lineage owner is sufficient.

### Owner-token consumers

These must validate the exact acquisition in addition to locality:

- heartbeat updates;
- lock release;
- sibling stop requests and pickup;
- external watch polling;
- any retained inject-PTY lock lifecycle.

## Implementation Phases

### Phase 1 — Identity and inspection foundation

1. Add `RunnerHostIdentity` and inject it at VS Code activation and CLI startup.
2. Split `WorkflowRunnerLock.instanceId` into `hostInstanceId` and
   `executionInstanceId`; add schema validation/versioning.
3. Update every lock acquisition writer, heartbeat fixture, lease diagnostic,
   and test factory.
4. Implement structured lock inspection relative to an observer identity.
5. Add pure unit tests for liveness and locality before migrating orchestrator
   behavior.

Keep owner-token acquire/update/release semantics unchanged in this phase.

### Phase 2 — Central external-execution resolution

1. Add the resolver that combines persisted state, exact run address, active
   lock, and external locality.
2. Add stable reason codes and structured logs for declined external routing.
3. Make the result carry the exact owner token and lock identity.
4. Test terminal retained locks, run-ref mismatches, owner replacement, and
   self-owned locks before wiring callers to it.

### Phase 3 — Orchestrator and watch-session migration

1. Rename CLI-specific session registries/helpers to external-run terminology.
2. Migrate startup discovery, auto-load, explicit load, recent-workflow, and
   runner-file event paths to the resolver.
3. Require typed external proof when creating a watch session.
4. Revalidate proof before registration and throughout the watch lifecycle.
5. Migrate continuation/conflict paths to structured locality.
6. Make sibling stop requests reject self, indeterminate, replaced, or terminal
   owners.
7. Remove direct runner-status-to-external conversions.

Preserve the existing PAUSED CLI-takeover behavior, but prove the CLI owner is
external before retiring an idle local tracking instance. A self-owned paused
lock must not take that path.

### Phase 4 — Summary and UI contract cleanup

1. Replace `WorkflowSummary.managedBy` with the explicit `externalOwner`
   projection.
2. Update dashboard message types, stores, selectors, banners, running-workflow
   items, and editor read-only behavior.
3. Keep CLI and sibling VS Code labels/actions runner-specific without exposing
   coordination secrets.
4. Add webview tests proving that only `externalOwner` activates read-only
   external mode.

### Phase 5 — Architectural enforcement and cleanup

1. Remove obsolete `active-vscode` / `active-cli` constants and legacy helper
   names.
2. Restrict raw lock parsing to `WorkflowLockInspector` and owner-token mutation
   primitives. Higher layers consume inspections/resolutions.
3. Search the repository for direct interpretations of `runner.json`,
   `lock.runner`, and old lock statuses; document every intentionally retained
   low-level use.
4. Update `core.instructions.md`, orchestration instructions, and the implemented
   multi-instance plan with the final invariants and ownership vocabulary.
5. Add a concise diagnostic log at the centralized decision point containing
   workflow key, run ref, runner, redacted host identifiers, PID relationship,
   locality, persisted state, and decision reason. Never log owner tokens.

## Test Plan

### Lock-classifier truth table

Add table-driven tests for at least:

| Lock observation                                              | Expected result                    |
| ------------------------------------------------------------- | ---------------------------------- |
| no file                                                       | absent                             |
| unreadable/invalid file                                       | safe invalid/indeterminate outcome |
| dead PID                                                      | stale                              |
| expired heartbeat                                             | stale                              |
| same VS Code host ID and PID                                  | active self                        |
| same CLI host ID and PID                                      | active self                        |
| different live VS Code host ID and PID                        | active external                    |
| CLI lock observed by VS Code                                  | active external                    |
| VS Code lock observed by CLI                                  | active external                    |
| same host ID with a contradictory PID                         | indeterminate + diagnostic         |
| different host IDs with the same PID                          | indeterminate + diagnostic         |
| legacy lock with `pid === observer.pid`                       | never external                     |
| legacy live lock with a different PID                         | conservative documented outcome    |
| active lock replaced with a new owner token during inspection | old proof rejected                 |

Inject clock and process-liveness dependencies in unit tests. Do not use the
test runner's `process.pid` as proof of a sibling owner.

### External-execution resolver matrix

Cover the Cartesian product that previously leaked across call sites:

- persisted state: active versus terminal;
- lock liveness: absent, stale, active;
- locality: self, external, indeterminate;
- address: matching versus different `RunRef`;
- acquisition: stable versus owner-token replacement.

Only active state + active external lock + exact address + stable acquisition
may return `external-active-run`.

### Two-host shared-filesystem regression test

Build a component/integration harness with two independently identified
orchestrators pointing at the same temporary workspace and project-state root.
Use injected process-liveness for deterministic component tests and at least one
real child process for a true live-sibling PID test.

Exercise this sequence:

1. Host A starts a VS Code-managed workflow and acquires its lock.
2. Host A runs every discovery/load entry point and never creates an external
   session or external-owner summary for its own run.
3. Host B discovers the same run as external, read-only, and VS Code-managed.
4. Host B cannot mutate the run directly; its stop request targets Host A's exact
   owner token.
5. Host A pauses/resumes while Host B continues to observe it externally.
6. Host A completes the run while retaining the lock for an injectable named
   worktree PTY.
7. Both hosts observe the terminal persisted state and remove/decline external
   running summaries despite the still-live lock.
8. The retained lock is eventually released without either host mutating a
   successor acquisition.

Run the sequence with discovery initiated through activation, dashboard recent
workflows, explicit working-file load, and file-watcher/poll discovery.

### Self-owned untracked regression

Create a self-owned active lock without a registered local execution and assert:

- no external watch is created;
- no sibling-owner banner or stop request is produced;
- the lock is preserved;
- a structured same-host invariant diagnostic is emitted;
- the run is not made editable/adoptable while its state and lock remain active.

### UI contract tests

Assert that:

- `externalOwner: { runner: "cli" }` produces CLI watch mode;
- `externalOwner: { runner: "vscode" }` produces sibling VS Code watch mode;
- a local VS Code workflow without `externalOwner` remains locally managed;
- terminal summaries do not remain in the running collection even if an old
  external-owner projection was previously received;
- stop controls use the correct runner-specific path.

### Architectural audit test

Prefer enforcing the boundary by API/type visibility: higher-level code should
not receive an ambiguous runner-specific active status. Supplement this with a
small repository architecture test or lint restriction if raw imports remain
possible. The check should fail when orchestration/UI code:

- imports obsolete runner-specific lock statuses;
- constructs an external watch without an external-resolution result;
- maps `RUNNER_IDS.VSCODE` directly to external ownership;
- parses `runner.json` outside the approved lock infrastructure.

Keep the allowlist narrow and documented; do not rely on a broad text search as
the primary correctness mechanism.

## Observability

At the centralized resolver, emit one structured decision log containing:

- workflow key and exact run ref;
- persisted execution state;
- lock liveness and runner;
- whether host IDs and PIDs match the observer, using shortened/redacted host
  IDs;
- final locality and reason code;
- whether an external watch was created, retained, refreshed, or rejected.

Never include `ownerToken` in logs. Log contradictory identity data at warning
level because it indicates schema corruption, incorrect dependency injection,
or a process-identity lifecycle bug. Ordinary self/external decisions should be
debug or trace level.

This creates a single diagnostic trail for future reports instead of requiring
inference from separate lock-status and dashboard logs.

## Failure and Race Handling

- **Owner finishes during resolution:** revalidation sees a missing/replaced
  token; do not start the session.
- **Owner is replaced during an active watch:** finish the old session and run a
  fresh resolution; never transfer the old proof automatically.
- **Working file becomes terminal before lock release:** terminal state wins and
  the running watch ends.
- **Lock becomes stale while persisted state remains active:** end external
  observation and route through existing interrupted-run recovery.
- **Host restarts and PID is recycled:** the new host UUID prevents the old lock
  from being classified as self merely because the PID matches.
- **Same process reports two host UUIDs:** classify as indeterminate, preserve
  the lock, and report an invariant violation.
- **Legacy lock lacks host identity:** never classify it as an external sibling
  when its PID matches the observer; otherwise follow the explicitly documented
  conservative migration rule.
- **Run file and lock disagree on `RunRef`:** do not watch the addressed file;
  resolve only the exact run named by a validated lock.

## Verification Commands

Run verification in the project-prescribed order:

```powershell
npm run typecheck
npm run lint
npm run format:check
npm run compile:extension
npm run compile-tests
npm run compile:extension
node ./out/test/runTest.js
npm run test:ui
git diff --check
```

Use focused Mocha grep runs while iterating, but complete the relevant extension
and webview suites before marking the plan implemented. Do not run
`test:harness` unless explicitly requested.

## Documentation Updates

When implementation is complete:

- add the ownership invariants to `.github/instructions/core.instructions.md`;
- document structured lock inspection in the relevant utils instructions;
- document external-session eligibility and exact-owner revalidation in
  orchestration instructions;
- update `MULTI_INSTANCE_WORKSPACE_COORDINATION_PLAN.md` to link to this
  hardening work and correct the historical `instanceId` description;
- move this plan from `dev/backlog/` to `dev/implemented/` and update its status.

## Acceptance Criteria

- Every runner lock contains distinct host and execution instance identities.
- One VS Code activation uses one stable host identity for all workflows it
  starts.
- No ownership-sensitive API exposes `active-vscode` as if it meant sibling
  ownership.
- External watches can only be constructed from an active external ownership
  resolution for the same workflow key, run ref, and owner token.
- Persisted terminal state always prevents or ends an external running session,
  even while a retained lock remains live.
- A self-owned lock never creates an external summary, read-only sibling banner,
  sibling stop request, or “another process” error.
- A sibling-owned lock remains visible and read-only, with stop requests scoped
  to its exact owner token.
- Contradictory or unknown identity is preserved and diagnosed without being
  treated as proven self or proven external ownership.
- Replacing a lock acquisition terminates the old watch proof; the old watcher
  cannot follow or mutate the successor.
- Startup, auto-load, explicit load, recent-workflow, watcher discovery,
  continuation, stop, recovery, history, and worktree lock call sites are
  classified and migrated.
- Unit tests cover the complete liveness/locality truth table and resolver
  matrix.
- A two-host shared-filesystem regression test proves owner-versus-sibling
  behavior, including terminal state with a retained lock.
- UI tests prove external mode is driven only by the explicit external-owner
  projection.
- Type checking, linting, formatting, extension tests, webview tests, and diff
  validation pass.

## Completion Checklist

- [x] Host identity is created once per VS Code activation and CLI startup.
- [x] Lock schema separates host identity from workflow execution identity.
- [ ] Structured lock inspection replaces runner-specific active statuses.
- [x] External-execution resolver is the single source of external eligibility.
- [x] External watch sessions require and revalidate exact external proof.
- [x] Orchestrator CLI-specific session names are made runner-neutral.
- [ ] Workflow summaries expose explicit external locality without lock secrets.
- [x] All lock call sites are inventoried and migrated by required semantics. The remaining low-level `runner.json` and `LOCK_STATUS` uses are deliberately retained for the architectural-enforcement audit listed below.
- [x] A two-host shared-filesystem regression test proves owner-versus-sibling behavior, including terminal state with a retained lock.
- [ ] Classifier, resolver, self-owner, two-host, and UI regressions are covered.
- [ ] Architecture enforcement prevents new direct runner-to-external mappings.
- [ ] Coordination and project-memory documentation is updated.
- [ ] Plan is moved to `dev/implemented/` after all acceptance criteria pass.

Phase 1 implementation note: the lock shape follows the plan exactly. Raw lock
reads remain permissive for legacy objects that lack `schemaVersion`,
`hostInstanceId`, or `executionInstanceId`; those objects are returned for the
existing liveness-only paths and are not upgraded or treated as new ownership
proof. Production VS Code and CLI construction injects the single activation or
startup identity explicitly; legacy direct `WorkflowInstance` utility/test
construction retains a per-instance fallback until those call sites are
migrated. Structured inspection and external-routing changes remain deferred
to the later phases as required by this first implementation step. For the
conservative legacy case left open above, a live lock without `hostInstanceId`
whose PID differs from the observer is classified as active/indeterminate (and
logged), never external; a matching PID is classified as self. The structured
inspection API is now available, and higher-level call sites use its
liveness/locality fields. The compatibility `inspectWorkflowLock()` /
`WorkflowLockManager.checkLock()` pair remains only for the
architectural-enforcement cleanup phase.

Phase 2 implementation note: `src/core/orchestration/ExternalExecutionResolver.ts`
is the standalone external-execution eligibility boundary. It exports
`ExternalExecutionResolver`, `resolveExternalExecution`,
`ExternalExecutionResolution`, `NotExternalReason`,
`ActiveExternalLockInspection`, and `ExternalExecutionResolverOptions`.
The resolver reads and validates the addressed working file, requires an active
persisted execution state and an exact, stable external lock acquisition, and
returns the inspected lock (including its owner token) as the caller's proof.

Phase 3 watch-session note: `WorkflowOrchestrator` now routes external watch
registration through that resolver proof, revalidates the exact acquisition
before registration, and stores runner-neutral external session state. A live
watch ends on terminal working-file state, lock loss, or any ownership/identity
change; a replacement lock is resolved afresh rather than being followed by the
old session. The paused local takeover path remains limited to proven external
ownership.

Phase 3 call-site audit note: the deliberate low-level uses left for Phase 5
architectural enforcement are:

- `WorkflowLockInspector.inspectWorkflowLock()` and
  `WorkflowLockManager.checkLock()`, retained as a compatibility status adapter;
- `WorkflowLockManager`'s acquire, heartbeat, release, and stale-normalization
  primitives, which must read `runner.json` to mutate or extract its exact run;
- `WorkflowOrchestrator` runner-file discovery/replacement handling and
  `ExternalRunWatchSession` polling, which read the raw lock only to locate or
  revalidate an exact acquisition before delegating to structured inspection;
- the `LOCK_STATUS` constants and their adapter-only return type.

No higher-level caller maps `lock.runner` or `LOCK_STATUS.ACTIVE_VSCODE` /
`ACTIVE_CLI` to external ownership. Liveness-only callers use
`WorkflowLockInspection.liveness`; execution-conflict callers distinguish local,
self-owned-but-untracked, external, indeterminate, and recoverable states; and
stop/watch lifecycles retain the exact `ownerToken` acquisition.

Regression implementation note: the two-host and self-owned-untracked tests now
exercise activation, recent-session, explicit-load, watcher/poll, stop-request,
pause/resume, terminal retained-lock, and successor-acquisition paths. The
self-owned-untracked load paths also decline fresh adoption and emit a structured
same-host invariant diagnostic; this closes the production gap where an active
same-host lock without a resident execution could otherwise fall through to an
editable local instance.
