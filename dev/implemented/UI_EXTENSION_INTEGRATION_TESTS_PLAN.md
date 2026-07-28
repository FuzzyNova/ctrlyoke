# UI ↔ Extension Integration Tests — Property Round-Trip Contract

Status: **In progress — first slice implemented and green (2026-07-22).**
Step-1 discovery complete; entry point decided (message-contract, no browser —
see "Step-1 discovery findings"). Implemented so far, all passing in the
extension host (23 tests; full suite green alongside):

- `src/test/integration/helpers/propertyRoundTrip.ts` — shared harness
  (promoted-run fixture, seeded orchestrator + real `WebviewSettingsSync` +
  real `WorkflowLineageRepository`, router-shaped routing, wire-faithful JSON
  clone of payloads to reproduce the `postMessage` `undefined`-stripping hop).
- `src/test/integration/workflowPropertyRoundTrip.integration.test.ts` —
  19 workflow-level cases: canary, revision bump, sentinel clears
  (`agent:""`, `skills:[]`, `mcpServers:null`, `endCondition:null`,
  `preCondition:null`, `additionalArgs:""`, `hooks:null`), nested objects
  (`toolPermissions`, `errorBehavior`, `hooks`), `resumeSession` + Final Step
  Session sentinel pairing, numeric `sessionId`, blank-`sessionId` delete,
  `priorContext` keyword and `number[]` shapes, batched atomic update,
  `undefined` delete semantics, settings-sync echo, stale-revision rejection
  with unchanged file.
- `src/test/integration/promptPropertyRoundTrip.integration.test.ts` —
  4 prompt-level cases: per-step override lands on the right step only, text +
  override together, `clearProperties` inherit removal, revision bump.

**Second slice — full-flow execution harness (2026-07-22), also green:**

- `src/test/helpers/mockHarness.ts` — shared `MockHarnessIntegration` (records
  `sentPrompts`, fires canned responses; extracted from
  `WorkflowExecutor.test.ts`), `MockPlatform` (workspace-root-configurable),
  and `MockIntegrationFactory`.
- `src/test/integration/helpers/executionHarness.ts` — a **real
  `WorkflowInstance`** over a temp workspace with the mock factory: the full
  production pipeline runs (parse → draft → run promotion → executor loop →
  pre/end-condition evaluation → history persistence) at zero AI cost. Its
  `dispose()` awaits `outputHistoryManager.flushPendingIndexRefresh()` before
  the caller deletes the workspace (otherwise the fire-and-forget search-index
  refresh races the rmdir).
- `src/test/integration/preConditionFlow.integration.test.ts` — 9 full
  user-flow cases for workflow-level `preCondition`: control (no gate → prompt
  reaches harness), gate in source file, gate set via property update after
  load, ephemeral new-workflow flow (`ensureEphemeralWorkingFile` →
  `updateWorkingFileProperties` → `executeEphemeralPrompt`), failing gate
  default-skip, passing gate default-continue, re-run after completion,
  restore-in-fresh-session then run, and step-level `null` override. Gate
  scripts write a marker file so "did the gate run" is a filesystem assertion.
  **All 9 pass** — the reported "workflow-level preCondition not run before
  first prompt" bug does not reproduce in any of these instance-level paths.
  Prime remaining suspect (UI half): enabling the Pre-Condition toggle posts
  `{script: "", onFail: "skipPrompt"}` (`WorkflowPropertiesPanel.
handlePreConditionToggle`), the script text field commits only on
  blur/Enter (`ScriptConditionEditor`), and the executor **silently** skips
  gates whose script is empty (`WorkflowExecutor` checks
  `resolvedPreCondition.script?.trim()`). A user who types the script and
  clicks Run without leaving the field runs with `script: ""` — which
  presents exactly as "pre-condition not run". Confirm via the run's
  `workflow.ctrlyoke.json`: an empty `preCondition.script` proves it.

Remaining: `harness`-switch batched pairing against a model list, prompt-level
`null` "none" overrides, final-step (`UPDATE_FINAL_PROMPT`) coverage, the
`mutationAddressing.integration.test.ts` scenarios, and continuation-contract
execution coverage (`appendAndContinueAtRun`/`continueAtRun` through the
execution harness).

**Fidelity decision (chosen by Nathan): message-contract, not browser E2E.**
These tests enter one layer below the pixels: they construct the exact
`postMessage` payload each panel emits and drive the real extension pipeline to
disk. Rationale — the VS Code webview is effectively un-drivable in automated
tests (isolated CSP iframe, no DOM handle from `@vscode/test-electron`), and the
regressions this targets live below the postMessage boundary (addressing,
revision guards, in-place-vs-draft routing), not in the React components. The
component→payload half is closed separately by Vitest assertions that each panel
emits the expected payload. A Playwright hosted-dashboard E2E remains a valid
heavier follow-up (browser surface only) but was deliberately not chosen for
this bug class.

## Why

`WORKING_FILE_PER_RUN_PLAN.md` and `RUN_HEAD_MUTABILITY_FOLLOWUP.md` rebuilt
the entire persistence spine: per-run working files, stable
`{ workflowKey, runRef }` addressing, per-client view addresses, optimistic
`definitionRevision`/`descriptorRevision` guards, and in-place promoted-run
edits. Those changes are correct in isolation and each shipped with unit tests,
but they moved the seam where a dashboard edit turns into bytes on disk through
several new layers. Regressions have surfaced where **a property changed in the
UI is not reflected when the prompt actually runs** — i.e. the edit never
reached (or reached the wrong) `workflow.ctrlyoke.json`.

The existing suite cannot catch this class of bug. Unit tests exercise
`WorkingFileManager`, `WorkflowLineageRepository`, the orchestrator's address
registries, etc. in isolation; webview Vitest tests stop at the store /
`postMessage` boundary. Nothing asserts the **whole contract**: "user sets
property X in panel Y → the addressed run/draft file on disk now contains X in
the shape the executor reads." That contract is exactly what broke.

This plan adds harness-free integration tests that drive the real message
pipeline end to end and assert the on-disk result — round-tripping every
workflow-level and prompt-level property.

## Scope

In scope:

- The contract from a webview `postMessage` payload (as produced by
  `WorkflowPropertiesPanel.tsx` and `PropertiesDrawer.tsx` / `PromptEditor.tsx`)
  through `WebviewMessageRouter` → `WebviewSettingsSync` /
  `prepare*Mutation` → `WorkflowOrchestrator` → `WorkingFileManager`, ending at
  the persisted `workflow.ctrlyoke.json` for the addressed run or draft.
- Round-trip coverage of every field in `WorkflowProperties`
  (`settingsStore.ts`) at the workflow level, and the per-step override subset
  at the prompt level.
- Address/revision behaviors that the recent work introduced and that the bugs
  live inside: draft vs promoted-run targeting, optimistic-revision rejection,
  in-place promoted-run edits, and multi-client view isolation.

Out of scope (keep these where they already are):

- Real harness execution. No CLI is launched; we assert persisted definition
  bytes, not model output. (`test.instructions.md` also forbids running
  `npm run test:harness` for ordinary verification — these tests must never
  need it.)
- Rendering assertions on React components (that is Vitest's job).
- Re-testing `WorkingFileManager`/`WorkflowLineageRepository` internals already
  covered by unit tests, except as reached through the full pipeline.

## The contract under test (verified pipeline)

Two distinct write paths exist and both must be covered, because they broke
independently and use different messages.

### Workflow-level properties (`WorkflowPropertiesPanel.tsx`)

1. Handlers call `postWorkflowDefinitionMutation(vscode, { type, ... })`, which
   attaches `mutation = { address, expectedDefinitionRevision,
expectedDescriptorRevision }` derived from `uiStore`
   (`utils/workflowMutation.ts`). Single edits post
   `UPDATE_WORKFLOW_PROPERTY { property, value }`; batched edits
   (harness change, reset-all) post `UPDATE_WORKFLOW_PROPERTIES { properties }`.
2. `WebviewMessageRouter.handleUpdateWorkflowProperty(ies)` calls
   `prepareWorkflowPropertiesMutation` (validates the addressed run in place /
   steps a draft client onto its draft) then
   `WebviewSettingsSync.handleUpdateWorkflowProperties`.
3. `WebviewSettingsSync` seeds an ephemeral working file only when the address
   is **not** a run, then calls `orchestrator.updateWorkingFileProperties`,
   then republishes via `sendWorkflowPropertiesToSettings`.
4. `WorkflowOrchestrator` routes the write to the addressed run/draft file;
   `WorkingFileManager` is the sole writer and bumps `definitionRevision`.
5. `refreshDefinitionMutationView` / `invalidateRunViews` push the new snapshot
   back to viewers.

### Prompt-level (per-step) overrides (`PropertiesDrawer.tsx` → `PromptEditor.tsx`)

The drawer mutates `editorStore` in memory; persistence happens when the editor
commits the step via `postWorkflowDefinitionMutation(vscode, {
type: UPDATE_PROMPT | UPDATE_FINAL_PROMPT, index, properties })` (also
`EXECUTE_PROMPT` carries `properties`). These land as **step-level overrides**
inside the step object, routed through `prepareDefinitionMutation`. This is a
different key surface (three-state `undefined`/`null`/value "inherit / none /
custom" semantics per property) and a different on-disk location than the
top-level workflow properties, so it needs its own round-trip matrix.

## Test architecture

### Where

New directory `src/test/integration/` already exists
(`cli.integration.test.ts`). Add:

- `src/test/integration/workflowPropertyRoundTrip.integration.test.ts`
- `src/test/integration/promptPropertyRoundTrip.integration.test.ts`
- `src/test/integration/mutationAddressing.integration.test.ts`
  (draft/run targeting, revision conflicts, multi-client isolation)

Mocha TDD style, Node `assert`, hand-written fakes (matching
`test.instructions.md` conventions). These compile via `npm run compile-tests`
and run under `npm test`.

### Recommended driving level: the message router with a fake sink

Drive the **real** `WebviewMessageRouter` (or the smallest wiring that
constructs a real `WorkflowOrchestrator` + `WebviewSettingsSync` +
`WorkingFileManager` over a temp workspace), feeding it the exact `postMessage`
payloads the two components produce, and capturing outbound messages with a
fake `postMessage` sink.

Rationale: the bugs are in the glue — `prepare*Mutation`, address resolution,
the ephemeral-vs-run seed decision, revision plumbing. A test that calls
`orchestrator.updateWorkingFileProperties` directly would skip exactly the
layers that failed. Entering at the router means one message reproduces the
production path.

To keep this harness-free and fast:

- Build a temp workspace with `os.tmpdir()` + `fs.mkdtemp`; point the
  orchestrator's workspace folder at it; clean up in `teardown`
  (`test.instructions.md`: always restore globals, never leak temp dirs).
- Construct the orchestrator without VS Code UI dependencies the way
  `WorkflowOrchestrator.test.ts` already does (`Object.create(prototype)` +
  internal field seeding) **or**, preferably, add a small
  `createIntegrationOrchestrator(workspaceRoot)` test helper under
  `src/test/integration/helpers/` that wires the real collaborators over the
  temp workspace and exposes the fake client sink. Extract it once and share
  across all three files.
- Fabricate the client's starting address/revisions the way the webview would
  hold them: create a lineage/draft (or run) via the repository, load its view
  for the client (`loadRunViewForClient`) so `viewAddressRegistry` and the
  captured `RUN_VIEW_LOADED`/`WORKFLOW_VIEW_IDENTITY` give the test the current
  `definitionRevision`/`descriptorRevision` to echo back — never hardcode them.

### Reading the result

Resolve the addressed file through `WorkflowPaths.runFilePath` /
`draftFilePath` (never hand-build `.runs` paths — the canonical module is the
single authority) and parse it. Assert on the parsed definition, not a string
match, so key ordering and formatting don't cause flakiness. Where meaningful,
also assert the executor's _effective_ view by parsing through
`PromptFileParser` / `PropertyResolver` so the test proves the value is not
just present but reaches the shape execution consumes.

## Property round-trip matrix (workflow level)

One parameterized test per `WorkflowProperties` field, each asserting the
persisted top-level workflow definition. The high-value cases are the sentinel
distinctions the UI deliberately encodes — these are where "looks set in the UI
but runs with the default" bugs hide:

| Property          | Message value(s) to exercise                                                         | On-disk expectation                                                   |
| ----------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `harness`         | a non-default harness id (batched with `model`+`additionalArgs`, as the panel sends) | harness persisted; paired model/args persisted together               |
| `model`           | valid model id                                                                       | persisted                                                             |
| `agent`           | `"some.agent.md"`, and `""` (explicit None)                                          | value persisted; `""` persisted as an explicit clear, **not** dropped |
| `skills`          | `["a","b"]`, and `[]` (explicit None)                                                | array persisted; `[]` survives (not stripped to undefined)            |
| `resumeSession`   | `true`, `false`                                                                      | persisted                                                             |
| `sessionId`       | UUID string, prompt number, `""` (clear), `FINAL_STEP` sentinel                      | each persisted; `""` clears; sentinel preserved                       |
| `mcpServers`      | `["ctrlyoke", {...}]`, and `null` (None)                                             | list persisted; `null` persisted as explicit disable                  |
| `hooks`           | `[{...}]`, `null`                                                                    | persisted / explicit disable                                          |
| `errorBehavior`   | `{onError:"retry",maxRetries:N}`, `{onError:"stop"}`, `null`                         | persisted incl. nested fields                                         |
| `endCondition`    | full object, `null` (disable)                                                        | persisted; `null` disables (distinct from undefined-inherit)          |
| `preCondition`    | `{script,onFail}`, `null`                                                            | persisted                                                             |
| `priorContext`    | keyword string, `number[]` custom                                                    | persisted in both shapes                                              |
| `additionalArgs`  | non-empty string, `""` (cleared)                                                     | string persisted; `""` persisted as explicit clear                    |
| `toolPermissions` | `{mode,allowedTools,deniedTools}`, `null`, mode `none`                               | persisted; null/none normalized as the resolver expects               |

Also include:

- **Batched update atomicity**: `UPDATE_WORKFLOW_PROPERTIES` (reset-all,
  harness switch) writes all keys as one revision bump, no partial file.
- **Delete semantics**: a property set to `undefined` triggers the
  `allowDeletes` path and removes the key rather than writing `undefined`.

## Property round-trip matrix (prompt level)

Mirror the workflow matrix for the per-step override subset the
`PropertiesDrawer` exposes, driven via `UPDATE_PROMPT`/`UPDATE_FINAL_PROMPT`
with `{ index, properties }`. The critical axis here is the three-state
control encoding:

- `undefined` → **inherit**: the key is absent from the step; execution falls
  back to workflow → global. Assert the step object has no override key.
- `null` → **none/explicit disable** (agent, additionalArgs, conditions,
  toolPermissions, endCondition): assert the null override persists on the step
  and is not confused with inherit.
- concrete value → **custom**: persisted on the step.

Cover both a normal queue step (`index`) and the final step
(`UPDATE_FINAL_PROMPT`), since they persist to different locations in the file.

## Addressing & revision scenarios (`mutationAddressing.integration.test.ts`)

These encode the exact failures `RUN_HEAD_MUTABILITY_FOLLOWUP.md` fixed, so
they guard against re-regression:

1. **Draft edit** — a never-run workflow: property write seeds/updates the
   draft file; no run directory is created.
2. **In-place promoted-run edit** — viewing an idle completed run, a property
   write lands on that run's `workflow.ctrlyoke.json` **without** forking a
   draft and without changing the client's view label.
3. **Revision conflict** — a write carrying a stale
   `expectedDefinitionRevision` is deterministically rejected and the file is
   unchanged; assert the rejection still republishes identity so the client
   isn't left frozen (per `core.instructions.md`).
4. **Property-then-append race** — the ordering the followup calls out: a
   property edit bumps the revision; a subsequent append carrying the old
   revision is rejected, not silently applied to the wrong head.
5. **Multi-client isolation** — client A editing run N's properties does not
   mutate or redirect client B viewing run M (or a draft); B's file and address
   are untouched.
6. **Executing-run guard** — a property mutation addressed at a run in an
   unsafe active state is rejected without creating a draft.
7. **Ephemeral seed only off-run** — an `UPDATE_WORKFLOW_PROPERTY` from a
   client whose bound instance has a blank working file but a **run** address
   writes to the run and does **not** create an extra lineage (the
   `WebviewSettingsSync` guard at the `mutation.address.kind !== "run"` branch).

## Keeping it harness-free

- No `IntegrationFactory` execution path is invoked; tests stop at persistence.
- If the router pulls in execution collaborators at construction, inject
  no-op/fake integrations via the existing seams rather than real PTY/harness
  objects. Prefer the smallest real object graph that still exercises
  `prepare*Mutation` + `WebviewSettingsSync` + `WorkingFileManager`.
- Assertions read files and parse them; they never wait on a process, so
  timeouts stay short.

## Delivery sequence

1. Build the shared `createIntegrationOrchestrator` + fake-client helper and
   one canary test (single `model` round-trip on a draft) to prove the wiring.
2. Fill the workflow-level property matrix, including sentinel/delete cases.
3. Add the prompt-level (per-step + final-step) matrix with three-state
   coverage.
4. Add the addressing/revision/multi-client file.
5. Run `npm test` (which includes `npm run test:ui`); confirm the new suite
   count moves (per `test.instructions.md`, recompile tests first — a stale
   `out/test` will silently run the previous build and report green).

## Step-1 discovery findings (resolved)

Discovery traced the real code; the entry-point question is settled.

- **Everything runs in the existing `@vscode/test-electron` host.** The whole
  `npm test` suite (including `src/test/unit/**`) already launches inside a VS
  Code instance, so top-level `import * as vscode` in the pipeline
  (`WorkflowOrchestrator`, `WebviewSettingsSync`) is a non-issue. These new
  files live under `src/test/integration/` and run the same way — **no browser,
  no separate runner.**
- **A full `WebviewMessageRouter` is unnecessary and not worth its wiring.** Its
  handlers for property/prompt writes are thin: `handleUpdateWorkflowProperty`
  is just `prepareWorkflowPropertiesMutation` → `settingsSync
.handleUpdateWorkflowProperties` → `refreshDefinitionMutationView`;
  `handleUpdatePrompt` is `prepareDefinitionMutation` →
  `orchestrator.updatePromptInQueue` → refresh. The harness reproduces those
  exact call sequences (this is the "router-shaped helper" the old open
  decision described) so no real serializer/`historySearchService`/callbacks are
  needed.
- **The proven construction pattern already exists** in
  `WorkflowOrchestrator.test.ts` (see the `ctrlyoke-run-edit-` /
  `ctrlyoke-run-properties-` tests): `Object.create(WorkflowOrchestrator
.prototype)` seeded with a **real** `WorkflowLineageRepository`, an
  `fs.mkdtemp` temp workspace as `currentWorkspaceFolder`, and the view
  registries. No `ExtensionContext`, no `IntegrationFactory`, no `StatusBar`.
  Workspace root is read solely from `currentWorkspaceFolder?.uri.fsPath`
  everywhere, so this fully redirects persistence into the temp dir.
- **Run-addressed writes need no `WorkflowInstance`.** For an idle promoted run
  (empty `instances`/`cliSessions`), `updateWorkingFileProperties` and
  `updatePromptInQueue` take the static path
  (`WorkingFileManager.updatePropertiesAtRun` / `updateStepAtRun` +
  `lineageRepository`) via `applyRunAddressedMutation`'s no-resident branch, and
  `prepareWorkflowPropertiesMutation` falls through to
  `prepareDefinitionMutation`'s revision-checked "run" branch. So the primary
  in-place-edit case — exactly the followup's regression surface — is testable
  with only the repository + `WorkingFileManager` statics.
- **`WebviewSettingsSync` is trivially real**: `new WebviewSettingsSync(fakePost,
() => orchestrator)`. Its republish `sendWorkflowPropertiesToSettings` is
  wrapped in try/catch and resolves `getViewFilePath` from the seeded view
  address, so `handleUpdateWorkflowProperties` never rejects on republish even
  with empty `instances`. Seeding a benign fake instance for the client (an
  unrelated `workflowKey`, `workingFilePath: undefined`) keeps the idle static
  path while letting the `WORKFLOW_PROPERTIES_UPDATE` republish actually post,
  so a test can also assert the contract's echo-back.
- **Revisions come from disk, not captured messages.** After each write the
  harness re-reads `descriptor.revision` and the run file's `definitionRevision`
  to build the next mutation — precisely the values the client echoes back.
  Optimistic-revision-conflict tests pass a stale revision and assert the
  `prepare*Mutation` rejection + unchanged file.

### Harness shape (implemented under `src/test/integration/helpers/`)

`propertyRoundTrip.ts` exports:

- `createPromotedRun(workspace, { name, steps, workflowName, finalStep? })` —
  builds a lineage + promotes one run via `WorkingFileManager.createWorkingFile`
  - `promoteToNewRun`, returns `{ workflowKey, runRef, workingFilePath }`.
- `createRoundTripHarness(workspace, address)` — the seeded orchestrator + real
  `WebviewSettingsSync` + capturing `fakePost`, exposing:
  `routeWorkflowPropertyUpdate(message)`,
  `routeWorkflowPropertiesUpdate(message)`, `routeUpdatePrompt(message)`
  (each mirroring the corresponding router handler),
  `currentMutationContext()` (reads live revisions from disk),
  `readRunDefinition()`, and `sentMessages`.

### Draft/ephemeral path — deferred to next phase

The "new workflow → edit → run" flow routes through
`getInstanceForClient(clientId).updateWorkingFileProperties(...)`, i.e. a real
`WorkflowInstance` (watcher, executor, integrations). Standing that up over a
temp workspace is heavier; it is the next phase. Run-addressed coverage lands
first because it is both the larger surface and the one the followup churned.

## Open decisions

- **Parameterization source of truth**: derive the workflow matrix from a
  single fixture list so adding a new `WorkflowProperties` field forces a new
  round-trip case (a lightweight guard against future untested properties).
- **Vitest component half**: confirm whether existing webview tests already
  assert each panel's emitted payload; if not, add focused ones so the
  component→payload step is covered without a browser (the other half of the
  chosen message-contract strategy).
