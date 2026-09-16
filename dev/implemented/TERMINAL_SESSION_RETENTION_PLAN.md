# Terminal Session Retention Plan

## Problem

Interactive terminals are evicted by a rule that no longer describes the system: **at most
one AI terminal per harness**. The rule is a proxy for something else, and now that parallel
steps exist the proxy is wrong often enough to destroy terminals the user is actively
watching.

The symptom that prompted this plan — an ad-hoc parallel promotion evicting the promoted
step's live terminal — is already fixed
(`WorkflowInstance.syncParallelGroupTerminalSessions`, `:3694`, which back-fills
`parallelGroupId` onto a PTY session whose step joined a group after its terminal was already
live). This plan is about the rule itself, which is still wrong in the cases below.

---

## Where the rule lives today

Two independent enforcement points, which is part of the problem — neither knows what the
other decided.

### 1. Backend: one live PTY per integration

`CliTransportCoordinator` holds a single `currentPtySession`
(`src/core/harness/shared/CliTransportCoordinator.ts:113`). `CliIntegration` enforces it on
every interactive dispatch: if inject mode is skipped and a live PTY exists, that PTY is
killed before the new one spawns (`CliIntegration.ts:1176-1181` →
`retireInteractivePtyForRestartFallback`, `:1337`).

Because sequential execution caches integrations by harness id
(`WorkflowInstance.executionIntegrations`, `:404`; `liveInjectIntegrations`, `:455`), "one PTY
per integration" became "one PTY per harness".

### 2. Webview: evict prior sessions with the same `harnessId`

`hooks/terminalMessageHandlers.ts:245-275` removes every existing `AI_CLI` session sharing the
incoming session's `harnessId`, unless both carry the same `parallelGroupId`.

This is pure cleanup after the backend rule — it exists so a restart does not leave a zombie
tab, and it has no independent knowledge of whether the old PTY actually died. That is why it
guesses, and why the guess breaks.

---

## Why the proxy fails

`getInjectIncompatibilityReason` (`CliIntegration.ts:602-664`) is the real predicate for "can
this conversation continue". It already refuses inject for:

- `parallelGroupId !== undefined` — "parallel-group identity requires a fresh process"
- `resumeSession: false` — "fresh session required"
- `model`, `toolPermissions`, `hooks`, `mcpServers`, `additionalArgs` changes
- an explicit `sessionId` naming a different session

Each of those produces a genuinely new, independent harness conversation. Three are cases
where the user plainly wants both terminals:

| Case                             | Today                                         | Wanted                                                |
| -------------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| Same harness, different model    | old PTY killed, one tab                       | two live conversations; a later step continues either |
| `resumeSession: false`           | old PTY killed, one tab                       | a fresh sibling terminal beside the old one           |
| Parallel siblings on one harness | backend spawns N; webview evicted all but one | N tabs                                                |

Only one case genuinely requires teardown, and it is a correctness requirement rather than a
display one.

---

## The rule this plan adopts

**Tear down only to avoid two processes owning one harness session. Otherwise spawn a
sibling.**

1. **Same-session conflict → kill first.** If a live PTY owns the AI session id the new spawn
   is about to `--resume`, terminate it _before_ spawning. Several harnesses reject or corrupt
   a session already open elsewhere. Ordering is load-bearing: kill, await exit, then spawn.
2. **`resumeSession: false` → never kill.** A fresh session cannot conflict with anything.
3. **Any other new or non-running session → spawn a sibling.** Nothing bounds how many
   sibling terminals a workflow may accumulate; see **No terminal cap** below for why.

### Rule 1 is only half-implemented today

- **Headless resume of a retained interactive PTY:** covered.
  `retireInteractivePtyBeforeHeadlessResume` (`CliIntegration.ts:1360-1388`) compares
  `resolvedSessionId` against `ctx.sessionId`/`ctx.spawnedWithSessionId` and terminates only
  on a match. This is the shape rule 1 wants and the model to copy.
- **Interactive restart:** not covered _as a conflict check_. `CliIntegration.ts:1176-1181`
  terminates unconditionally whenever a live PTY exists, never asking whether the sessions
  collide. It is over-broad rather than missing — it satisfies rule 1 by killing everything,
  which is exactly what this plan removes.

The original plan was to narrow that unconditional teardown to the same session-id comparison
and share one predicate between both paths. **That turned out to be unsafe on the interactive
path, and was reverted during review** — see **The interactive restart path stays
unconditional** below. The predicate was still extracted (`doesInteractivePtyOwnSession`), but
it governs the headless path alone.

---

## Design

### Do not give the coordinator multiple PTYs

One integration owns one `currentPtySession`. Keeping the old PTY alive while the same
integration spawns a new one would mean giving `CliTransportCoordinator` a _set_ of sessions,
touching `writeToSession`, `hasLivePtySession`, `getLastPtySessionId`,
`terminateCurrentPtySession`, `updateCurrentPtySessionMetadata`, steer routing, and
`onPtyExit` — a large, risky refactor of the most timing-sensitive file in the harness layer.

**Key the integration cache finer instead**, so the 1:1 invariant survives untouched and each
live conversation gets its own integration and coordinator. This is not a new pattern — it is
what parallel already does: `targetExecutionIntegrations` (`:409`) is keyed
`queue:<stepIndex>`, and `createIntegrationForMode` (`:4880`) returns a distinct integration
per target. Parallel same-harness terminals work today precisely because of this.

Key for the sequential caches: `` `${harnessId}::${spawnIdentityHash(props)}` ``. Equal hashes
guarantee inject compatibility, and unequal ones were always going to spawn separately. The
field list, canonicalization, and digest are decided under **Spawn identity** below, in a
module both the cache key and the inject predicate read, so the two cannot drift.

`resumeSession: false` steps never _reuse_ a cached integration — by definition they
must not continue anything — but the fresh integration they allocate does become that
key's entry, displacing whatever held it. The session such a step opens is the one a
later compatible prompt auto-resumes (`SessionResolver.autoResumeFromPrevious` scans
back for the most recent same-harness `_runtime.sessionId`), so the key has to name it.
The displaced integration keeps its terminal and moves to the unkeyed set that disposes
with the run; nothing can select it for another prompt.

**Leaving those steps entirely outside the cache shipped first, and was wrong.** The
displaced entry stayed selectable, so a later resuming prompt picked the _older_
conversation, arrived with a `resolvedSessionId` that integration did not own, and fell
through to the unconditional restart branch — killing a retained terminal to re-spawn a
session already live in a terminal beside it. Three terminals for three steps, and the
one destroyed was the one nothing was asking for.

**The selection site does not currently receive what the key needs.**
`getIntegrationForPrompt` is called with `(prompt, resolvedProperties.harness, target)`
(`WorkflowExecutor.ts:2109`) — the harness only. It must take the whole `ResolvedProperties`
(or a hash computed at the call site) so `createIntegrationForMode` can compose the key. That
signature change is the first piece of work, and it is what makes the rest mechanical.

The other call site, `ensureIsolatedIntegration` (`:827`), already has
`member.resolvedProperties` in hand, so the wider signature costs it nothing — and it always
passes a `target`, so it takes the target-keyed branch and never composes a spawn-identity
key at all.

**Re-keying the caches is necessary but not sufficient — the sequential selection site
short-circuits them.** `getIntegrationForPrompt` (`WorkflowInstance.ts:4423`) does not consult
`executionIntegrations` per prompt at all. Outside the target-keyed branch it returns the
closure-captured `activeIntegration` (bound once at `:5558`) and calls
`createIntegrationForMode` only when `resolvedHarness !== currentIntegration.getIntegrationMode()`
— a _harness_ comparison. A same-harness step with a different model therefore reuses the
active integration no matter how `executionIntegrations` is keyed, and the whole design
silently no-ops. That comparison must become a spawn-identity comparison: resolve the step's
`${harness}::${spawnIdentityHash(props)}` key and route through `createIntegrationForMode`
whenever it differs from the active integration's key. Track the active integration's own key
alongside it so this stays a string compare rather than a recomputation.

**Ordering at that call site is load-bearing and already correct — do not move it.** By
`:2109`, `resolvedProperties` has already been through `{{var}}` substitution, MCP
normalization (`resolvedProperties = mcpNormalization.properties`, `:2077`), and the
secrets/hooks rewrite (`:2089-2103`). Those are exactly the post-normalization values
`getInjectIncompatibilityReason` later compares against `ctx.spawnedWith`, which is itself
`session.resolvedProperties` (`CliExecutionRunner.ts:681`). Hashing before any of those steps
would key on values the inject check never sees, silently reintroducing the drift this design
exists to prevent. `:2089-2103` matters twice over now that `secrets` is hashed: that block is
where `secrets` becomes the effective grant list (`:2091`) and where granted values are
expanded into `hooks[].env`.

Affected: `executionIntegrations` (`:404`), `liveInjectIntegrations` (`:455`),
`retainedIntegrationArtifactContexts` (`:465`), and the restore loop in
`startWorkflowExecution` (`:5519-5556`). All three are already `Map<string, …>`, so the key
change is mechanical; the disposal loops iterate values and need no change.

### Spawn identity: what is hashed, and how

**Decided.** One module, `src/types/ExecutionSpawnIdentity.ts`, beside the `ResolvedProperties`
contract it reads, exporting a canonical field record and a digest of it:

```ts
/** Canonical serialization of each spawn-time field, keyed by field name. */
export function spawnIdentityFields(
  props: ResolvedProperties
): Record<SpawnIdentityField, string>;
/** Stable cache-key fragment: the digest of that record. */
export function spawnIdentityHash(props: ResolvedProperties): string;
```

Both callers go through it. `createIntegrationForMode` hashes the whole record;
`getInjectIncompatibilityReason` compares `spawnIdentityFields(curr)[f]` against
`spawnIdentityFields(prev)[f]` field by field, so it keeps its readable `"hooks changed"`
reasons while losing its private `JSON.stringify` comparisons. Equal hash then means every
field the predicate checks is equal **by construction**, which is the property the whole design
rests on — not a convention two files have to remember.

#### Which fields

| Field             | Hashed  | Why                                                                                                                                                                                                                                          |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness`         | yes     | Domain separator inside the payload, even though it is also the key prefix — a bare hash then stays unambiguous if anything ever uses it alone.                                                                                              |
| `model`           | yes     | Spawn arg; already in the predicate.                                                                                                                                                                                                         |
| `toolPermissions` | yes     | Spawn args; already in the predicate.                                                                                                                                                                                                        |
| `hooks`           | yes     | Written into the harness config at spawn; already in the predicate.                                                                                                                                                                          |
| `mcpServers`      | yes     | Spawn config, post-normalization; already in the predicate.                                                                                                                                                                                  |
| `additionalArgs`  | yes     | Literal spawn args; already in the predicate.                                                                                                                                                                                                |
| `secrets`         | **new** | Resolved into the PTY's environment at spawn (`CliTransportCoordinator.ts:251-259`). A process spawned without a grant cannot acquire it by injection — a gap in today's predicate that the hash closes.                                     |
| `ctrlyokeMcpMode` | **new** | Decides whether the ctrlyoke MCP server is attached at all (`CliProviderUtils.hasCtrlYokeServer`, `:60`). Uniform within a run in practice, since it comes from a global setting; included so it can never silently drift from `mcpServers`. |

Deliberately excluded:

- **`resumeSession`** — those steps bypass the cache entirely, so hashing it is dead weight.
- **`sessionId`** — including it would be _actively wrong_. Step A spawns without one and lands
  in session `S1`; step B names `S1` explicitly. Differing hashes would hand B a fresh
  integration that resumes `S1` while A's process still owns it — exactly the
  two-processes-one-session conflict rule 1 exists to prevent. Explicit session references stay
  the conflict predicate's job, and this is what keeps the narrowed teardown load-bearing
  rather than vestigial.
- **`executionMode`** — a headless step must keep resolving to the retained interactive
  integration so `retireInteractivePtyBeforeHeadlessResume` (`CliIntegration.ts:1360-1388`) can
  decide about that PTY. Splitting by mode would hide the live PTY from the check that guards it.
- **`agent`, `skills`, `priorContext`, `endCondition`, `preCondition`, `errorBehavior`** —
  per-turn inputs consumed by `CliPromptPreparer` and the executor, not baked into the process.

The asymmetry governing every one of those calls: a field wrongly **included** costs one extra
terminal; a field wrongly **omitted** silently reuses a process spawned with different args.
When a new spawn-time property is added, add it here — when in doubt, include it.

#### Canonicalization

The digest input is built by a recursive canonical serializer, not `JSON.stringify` of the raw
value:

1. **Object keys sorted, recursively.** This is the key-order sensitivity the previous pass
   flagged: two authorings of the same MCP server entry must not fork a terminal.
2. **Array order preserved.** `args`, `hooks`, and the tool lists are authored sequences and
   some are order-significant to the harness. Sorting them would conflate configurations that
   are not identical — the expensive direction of the asymmetry above.
3. **`undefined` folded to `null`**, and `additionalArgs` to `?? ""` (matching today's
   predicate). Nothing further: `[]` is **not** folded into `null`, because the resolver
   distinguishes "explicitly none" from "empty" (`resolveNullable`) and providers are free to
   as well.
4. **One canonical string per field**, so the predicate can still name which field changed.

Rule 3 is the plan's one intentional behavioural delta: today `JSON.stringify(undefined)` and
`JSON.stringify(null)` differ, so an absent `mcpServers` reads as a change and forces a
spurious restart. After this it injects.

#### The digest

**64-bit FNV-1a rendered as 16 lowercase hex characters**, implemented in the module with no
imports. Two reasons to deviate from this repo's `createHash("sha256").digest("hex").slice(0, 12)`
idiom (`ProjectStatePaths.projectKey`, `WorktreeUtils.createWorktreeDirectoryName`):

- **The module must stay isomorphic.** `src/types/ExecutionPropertyResolver.ts` is imported at
  runtime by the webview (`hooks/useCompatibilityDiagnostics.ts:22`). A `node:crypto` import in
  a sibling module is a bundle landmine the first time someone adds a value import, and staying
  pure leaves the door open for the webview to compute the same identity for a "this step opens
  a new terminal" preview — the one place drift would be visible to a user.
- **It is a cache key, not an integrity boundary.** Nothing authenticates on it and the inputs
  are the user's own resolved config. 64 bits against the handful of live entries one
  workflow produces does not justify a dependency on node.

**The canonical string is never the key itself and is never logged.** By `:2109` the hooks
rewrite (`WorkflowExecutor.ts:2089-2103`) has expanded granted secret _values_ into
`hooks[].env`, so the serialized identity contains plaintext secrets. Hashing is what makes the
key safe to hold in a `Map`, write to `Log`, or put in a message payload later. Log
`harness`, `model`, and the hash — never the payload.

### The interactive restart path stays unconditional

Rule 1 reads as a session-level conflict check, and on the headless path it is one: that
process is a _separate owner_, so the retained interactive PTY may legitimately stay alive
unless the resume would take over the session it already holds. That is exactly what
`doesInteractivePtyOwnSession` decides.

**The interactive restart path is not the same shape, and must not share the gate.**
`hasLivePtySession()` there reports _this integration's own_ `CliTransportCoordinator`, which
tracks exactly one `currentPtySession` and overwrites it on the next spawn. Declining to
retire would leave the previous PTY referenced by nothing —
`terminateCurrentPtySession`, `writeToSession`, steer routing and `cancel()` all reach only
`currentPtySession` — so the process would outlive the run and survive integration disposal,
dying only with the extension host. The user would be left with an invisible harness process
and no way to close it.

Gating that branch on the session-id predicate therefore traded one bug for a worse one, and
it reached the cases that matter: a prompt reusing its integration (same spawn identity,
`resumeSession: true`) whose inject is refused for a _non-identity_ reason — inject mode
disabled globally, a missing `spawnedWith` snapshot, an explicit `sessionId` naming a
different session, or an unresolved `resolvedSessionId`.

So the branch keeps its unconditional teardown. **Nothing is lost**, because the retention this
plan is about is delivered entirely by the cache keys: an incompatible prompt gets its own
integration and coordinator, whose `hasLivePtySession()` is false, so a terminal worth keeping
never reaches this branch. Rule 2 (`resumeSession: false` never kills) holds the same way —
those prompts always allocate a fresh integration upstream.

### Which terminal does a later step inject into?

Today `shouldUseInjectMode` asks one integration whether _its_ context is compatible
(`CliIntegration.ts:571`). With several live same-harness conversations this becomes a
selection, and the new cache key answers it for free: the step's own spawn identity hashes to
exactly one entry. No picker, no heuristic, no new UI. A step wanting a _specific_
conversation already has an explicit `sessionId`, honoured at `:613-621`.

### No terminal cap — decided: build nothing

An earlier revision of this plan added a per-workflow AI terminal cap
(`terminal.maxSessionsPerWorkflow`, default 10) enforced in `PtyProcessManager.spawnPty`,
with an eviction order beginning at ended/frozen sessions. **It was removed after the
chokepoint was checked against the code.** This is a decision, not a deferral.

`spawnPty` cannot see the sessions that cap was meant to bound. `PtyProcessManager.sessions`
is live-only — deleted from on PTY exit (`:643`), in `killSession` (`:754`), and in
`restartShellSession` (`:795`). An ended AI terminal leaves no row there, so the proposed
first eviction tier ("ended/frozen AI sessions, oldest `spawnedAt` first") could never match,
and the cap's own count would see only _running_ AI PTYs. Those are already bounded: a
sequential workflow runs one step at a time, and a group is bounded by
`queue.maxParallelSteps`. The cap would have been inert against the growth it named, while
adding a setting that reads like a guarantee.

The growth is real, but it lives entirely in the webview, which the extension does not
measure. `terminalStore.endSession` keeps an exited session with `COMPLETED`/`FAILED` status
rather than dropping it; `TerminalView.tsx:387` maps _every_ session (inactive ones get
`invisible` and are never unmounted — deliberately: a 0×0 container makes FitAddon clamp to
2×1 and push a bogus size to the PTY); and each entry loads a WebGL addon
(`terminalRegistry.ts:252-266`). So each retained tab costs up to `terminal.scrollback` (5000)
lines, a WebGL context, and a 50KB extension-side `reconnectBuffer`.

That cost is tolerable unbounded. Nothing held here is a process. Browsers already hard-cap
simultaneous WebGL contexts per page (Chrome ~16) and xterm falls back to its DOM renderer
past that rather than failing. And the accumulation is bounded in practice by the `RunRef`:
`closeRetainedTerminalsForFreshRun` (`:1185`) disposes every retained integration and closes
its terminal before a different `RunRef` starts, and `clearAiCliSessions` clears the rail on
run start. Reconnect prunes further — `replayTerminalSessionsTo`
(`WorkflowOrchestrator.ts:1116`) replays only live sessions, so ended tabs already do not
survive a reload.

**If tab accumulation is ever actually reported**, fix it in the layer that owns the resource
— the webview, dropping the oldest already-ended AI tab — not in `spawnPty`, which
structurally cannot see it.

### The webview stops guessing

Delete the harness-eviction block at `terminalMessageHandlers.ts:245-275` entirely, including
the `parallelGroupId` exemption and `isScriptPtySession` (`:27-37`) if nothing else uses it.

The extension then becomes the sole authority on terminal lifetime; the webview only adds on
`TERMINAL_STARTED` and removes on explicit close. That is the real win — today's bug class
exists _because_ two layers hold opinions about which terminals should exist and only one
knows the truth.

`clearAiCliSessions` on run start is unaffected.

---

## Explicitly not in this plan

Each of these was considered and rejected with a reason, not deferred by omission.

- **A per-workflow terminal cap.** Removed from this plan after verification — see **No
  terminal cap** above for the evidence.
- **A global terminal ceiling.** Misaimed: it would protect a resource already bounded by
  `maxParallelSteps`, and drawing an interactive/headless line makes no sense when both run
  the same class of harness process. Machine-capacity limiting is a _step admission_ concern,
  not a terminal one, and is rejected outright — see "Machine capacity" below.
- **A model badge on rail tabs.** Fails exactly when it is needed — three concurrent sonnet
  steps all render the same badge. `getAutoResumePreview`
  (`webview-react/utils/autoResumePreview.ts:17-44`) already names the step a resume will
  continue (`Step N ("name")`), rendered by `WorkflowPropertiesPanel`'s `AutoResumeStatusRow`,
  and explicit session references are by step number. Rail labelling is unchanged.
- **Reaping retained integrations across runs.** There is no cross-`RunRef` retention to reap.
  `closeRetainedTerminalsForFreshRun` (`:1185`) disposes every `liveInjectIntegrations` entry
  and closes its terminal before a different `RunRef` starts; it is called from the
  seed-new-run path (`:1759`) and on restart-from-beginning (`:2095`). Retention is bounded by
  the `RunRef`.
- **Per-session controller arbitration.** Stays per-workflow
  (`PtyProcessManager.workflowRunControllers`, `:460`), documented as v1-acceptable in
  `PARALLEL_STEPS_PLAN.md`. Unchanged here — with several same-harness terminals now live at
  once, a workflow-scoped controller is simply shared across them, exactly as it already is
  for parallel siblings.
- **Changing standalone-CLI behaviour.** It already refuses concurrent interactive sessions
  via `supportsConcurrentInteractiveSessions: false` (`src/cli/CliExecutionMode.ts:38`), a
  host capability rather than a harness one.

### Machine capacity — decided: build nothing

A global `maxConcurrentSteps` admission pool was proposed and **rejected**. This is a
decision, not a deferral: there is no follow-up plan doc, and the reasoning is recorded here
so it is not re-proposed from scratch.

**`queue.maxParallelSteps` remains the only concurrency limit in ctrlyoke.** It bounds group
fan-out, it is an authoring choice rather than a capacity guess, and it is unchanged by this
plan. Nothing else gates how many steps may run at once, by design.

Why a global counter is the wrong instrument:

- **It cannot express a heterogeneous workload.** A step running `npm test` and a step
  awaiting a `fetch` differ in cost by orders of magnitude but consume one slot each. Any
  value tuned for the expensive case needlessly queues the cheap one; any value tuned for the
  cheap case never fires when the expensive one needs it. There is no correct setting.
- **Over-subscription degrades rather than breaks, and the OS already handles it.** CPU
  contention is what schedulers are for: N CPU-bound harnesses all finish slower and none
  fail. The real cliff is memory, and step count is a poor proxy for memory for the same
  heterogeneity reason.
- **An admission pool deadlocks whenever an admitted step waits on an unadmitted one, and
  ctrlyoke ships a feature that invites exactly that.** `ExecutionRootCoordination` has no
  code-level blocking wait — it is transactional append/read — which is what makes it
  dangerous: the waiting happens _inside the agent_, polling `read_notes`, so ctrlyoke cannot
  observe it. Agent A holds a slot awaiting agent B's note while B is queued behind A, and
  `execution.maxPromptTimeout` defaults to `-1`, so nothing ever breaks the hang. It would
  surface as a slow step, not an error.
- **Nested work is a second deadlock vector.** Pre-/end-condition scripts run inside a step's
  lifecycle (`WorkflowExecutor.evaluateEndCondition`, `:3608`). If they ever consumed a slot,
  a step holding a slot would wait for a slot. Avoidable by rule — sub-step work inherits its
  parent's slot — but there is no single dispatch chokepoint today to enforce that in one
  place (`getIntegrationForPrompt` at `:827` and `:2109`, `executeScriptStep` at `:2423`).
- **It would not bound what it claims to.** A process-local pool means two VS Code windows get
  two independent pools and a CLI run gets a third. The machine stays as oversubscribable as
  before, while the setting reads like a guarantee.

**If real machine pressure is ever observed**, the response is advisory, not gating: a banner
when concurrent running steps exceed a threshold, blocking nothing, letting the user decide
what to stop and leaving actual balancing to the OS scheduler. No admission path, no
pending-step state to plumb through the steps panel, terminal, CLI, and MCP, no deadlock
surface. Revisit gating only if advisory proves insufficient against a concrete reported
failure.

---

## Files

| File                                                    | Change                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types/ExecutionSpawnIdentity.ts`                   | **New.** `spawnIdentityFields` / `spawnIdentityHash` — the sole source of both the cache key and the inject predicate's field comparison. No imports (see **The digest**).                                                                          |
| `src/core/harness/CliIntegration.ts`                    | Extract the session-id conflict predicate shared by `retireInteractivePtyBeforeHeadlessResume` and the restart path; narrow `:1176-1181` to it. Replace `getInjectIncompatibilityReason`'s `JSON.stringify` comparisons with `spawnIdentityFields`. |
| `src/core/WorkflowExecutor.ts`                          | Pass `ResolvedProperties` (not just `resolvedProperties.harness`) to `getIntegrationForPrompt` at `:2109`, after MCP normalization and the hooks rewrite.                                                                                           |
| `src/core/WorkflowInstance.ts`                          | Compose cache keys from harness + spawn identity; make the `getIntegrationForPrompt` selection compare that key rather than the harness; `resumeSession: false` bypasses the cache.                                                                 |
| `src/ui/webview-react/hooks/terminalMessageHandlers.ts` | Delete the harness-eviction block.                                                                                                                                                                                                                  |

No `schemas/workflow-schema.json` change — nothing here is authored per workflow.

---

## Staging

**Stage 1 — `ExecutionSpawnIdentity`, and the inject predicate rewired onto it — landed.**
The shared pure module now canonicalizes the eight spawn-time fields and hashes their record
with 64-bit FNV-1a. `getInjectIncompatibilityReason` compares those canonical field values,
retaining its existing reasons and adding `secrets`/`ctrlyokeMcpMode`. The tests cover the
canonicalization and the invariant that the hash and predicate cannot disagree. Folding
`undefined` into `null` causes _fewer_ restarts, while adding `secrets`/`ctrlyokeMcpMode`
causes _more_; Stage 2 now keys compatible integration caches with that hash.

**Stage 2 — the behavioural change, landed in one commit**, in this internal order:

1. Thread `ResolvedProperties` through `getIntegrationForPrompt` and re-key the caches,
   including the `activeIntegration` short-circuit.
2. Extract the session-id conflict predicate for the headless path.
3. Delete the webview harness-eviction block.

**These three cannot be split, and the order within the stage matters.** Re-keying the
sequential integrations first gives every differing spawn identity its own coordinator, which
is what lets a model change or a fresh session spawn a sibling instead of replacing a
terminal. The interactive restart path still retires unconditionally, for the reason recorded
in **The interactive restart path stays unconditional**; the extracted predicate governs the
headless path, where it also now declines to kill for `resumeSession: false`. The webview
keeps every started terminal until an explicit close message, so it no longer guesses which
same-harness tab the backend intended to retain.

Stage 1 and Stage 2 are complete. No per-workflow terminal cap, setting, or eviction logic was
added; `CliTransportCoordinator` still owns exactly one PTY per integration.

---

## Tests

- `src/test/unit/ExecutionSpawnIdentity.test.ts` — object key order does not change the hash;
  array order does; `undefined` and `null` fold together but `[]` and `null` do not; a change
  to each hashed field moves the hash; a change to `sessionId`, `executionMode`, `agent`, or
  `skills` does not. Plus the invariant that ties the two consumers together: equal
  `spawnIdentityHash` implies `getInjectIncompatibilityReason` reports no field change.
- `src/test/unit/CliIntegration.test.ts` — extends the existing `inject compatibility` suite:
  a `secrets` change no longer injects; an absent-vs-null `mcpServers` does. Plus the
  coordinator invariant: a live PTY on this coordinator is retired before its replacement
  spawns whatever that replacement resumes, a same-session resume awaits exit before spawning,
  and the headless path leaves the interactive PTY alone when it resumes another session.
- `src/test/unit/WorkflowInstance.test.ts` — two same-harness different-model steps produce
  two integrations; a third step with step 1's spawn identity resolves back to step 1's
  integration; `resumeSession: false` allocates a fresh one every time, and that fresh one
  — not the integration it displaced — is what the next resuming prompt continues. This is
  the suite that proves sibling retention, since the restart path itself no longer decides it.
- `src/ui/webview-react/test/hooks/useMessageHandler.test.ts` — same-harness
  `TERMINAL_STARTED` no longer removes the prior session.
