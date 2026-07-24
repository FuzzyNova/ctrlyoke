# WebviewMessageRouter Refactor Plan

Status: **Phases 0–1 complete** (2026-07-24). Phases 2–4 proposed.

Target: `src/ui/WebviewMessageRouter.ts` — 3,285 lines, of which `buildDispatchTable()`
is a single ~1,500-line method (lines 230–1736).

## Verdict: refactor, but not by message category

The instinct to split into sibling `*MessageRouter.ts` files by message category
(a `StepMessageRouter`, a `SettingsMessageRouter`, …) should be **rejected**. Two
reasons:

1. **It fragments the one question the file answers well.** Today "where is
   message X handled?" has exactly one answer: open this file, find the
   `table.set(MESSAGE_TYPES.X, …)`. Splitting the dispatch table across N files
   replaces one long-but-linear lookup with an N-file search, and each new file
   is a "router" that doesn't route — it's a handler bag with a misleading name.
2. **The categories are not independent.** The revision-republish protocol
   (`publishViewIdentity` / `reportActionFailure` / `refreshDefinitionMutationView`)
   is a cross-cutting invariant used by the run-lifecycle handlers, the prompt CRUD
   handlers, `LOAD_RUN_VIEW`, `DELETE_ALL_RUNS_FOR_LINEAGE`, `APPEND_FILE`, **and**
   the catch-all in `routeSingleMessage` (lines 211–223). Any category split still
   has to share it, so the shared piece must come out first regardless.

Equally, "leave it as a god object" should be rejected — but note it is *not*
actually a god object. It holds three fields of state (`routeQueue`,
`scopedPostMessage`, `clientId`) and already delegates the heavy lifting to
`WebviewSettingsSync`, `WorkflowSerializer`, `WorkflowOrchestrator`, and
`UndoRedoCoordinator`. It is a **long file, not a tangled one**, which is exactly
what makes this refactor low-risk and worth doing.

**The correct split axis is dependency, not message category.** Handlers that need
nothing from the router beyond "emit a reply", "which client am I", and "what is
the workspace root" are real services and should leave. Handlers that are 3-line
delegations to `settingsSync` / `serializer` / `orchestrator` should **stay** —
moving them buys nothing and adds a hop.

## Motivation beyond length: a real scope-drift bug

This is the strongest reason to act, and it is structural rather than cosmetic.

`route()` wraps each message in `withScopedContext` (lines 153–168), which mutates
`this.clientId` / `this.scopedPostMessage` and restores them in a `finally`. Every
handler reads that mutable scope via `this.clientId` and `this.getCurrentPostMessage()`.

Several dispatch entries are deliberately **fire-and-forget** so long-running
execution cannot deadlock the shared `routeQueue` (documented in
`.github/instructions/ui.instructions.md`):

- `EXECUTE_PROMPT` (line 530) and `UPDATE_PROMPT` (line 534) — called without `await`
- `EXECUTE_DRAFT` / `SEED_NEW_RUN` / `START_NEW_RUN_INSTEAD` / `CONTINUE_RUN` /
  `APPEND_AND_CONTINUE_RUN` / `PAUSE_RUN` / `CANCEL_PAUSE_RUN` / `RESUME_RUN` /
  `STOP_RUN` (lines 1427–1461) — all `void this.handleXxx(...)`
- `CREATE_CUSTOM_TEMPLATE` (line 1124) — `.catch()`, never awaited

For these, `withScopedContext`'s `finally` restores the previous scope *while the
handler is still running*. Any `this.clientId` / `this.scopedPostMessage` read
**after an `await`** therefore sees the restored (usually panel) scope, not the
originating client's.

Concretely: a hosted browser client presses Run, `executeDraftAtAddress` rejects on
a stale revision, and the recovery path
`showRunActionFailure` → `reportActionFailure` → `publishViewIdentity` (lines
2203–2038) runs post-await. It then calls `publishViewIdentityToViewers(this.clientId)`
with the panel's id and posts the result through the panel's transport. The browser
client that actually failed never receives the corrected revisions — which is
precisely the wedge that `reportActionFailure`'s own doc comment (lines 2040–2049)
exists to prevent.

The fix is structural: capture the scope **once at dispatch** into an explicit
context object and thread it through, so no post-await read can drift. That is the
same shape `UndoRedoCoordinator` already uses (it takes `postMessage` and `clientId`
as parameters rather than reading router state), so the precedent exists in-tree.

## Phase 0 — Introduce an explicit dispatch context ✅ **DONE**

Landed 2026-07-24 in `src/ui/WebviewClientContext.ts` + `WebviewMessageRouter.ts`.

The drift was confirmed real, and the observed failure was worse than predicted
above. In `publishViewIdentity`, `this.clientId` was read *synchronously* in the
argument list (still the browser client) but `this.scopedPostMessage(identity)`
ran *after* the await, by which time the restore had fired. So the identity was
**computed for `browser:1` and delivered to the panel transport** — the failing
client got nothing at all, and the panel got an identity describing a different
client's view.

The regression test (`WebviewMessageRouter client scoping` in
`src/test/unit/WebviewSettingsSync.test.ts`) pins exactly this, and was verified
to fail against the pre-Phase-0 router with:

```
AssertionError: nothing may leak to the panel transport
+ [ { clientId: 'browser:1', type: 'workflowViewIdentity' } ]
- []
```

What landed, versus what this section originally specified:

- `WebviewClientContext` + `createWebviewClientContext` in their own file (not
  inline in the router) so Phases 1–3 can import it without a cycle.
- `type WebviewMessageHandler = (message, ctx) => void | Promise<void>` — the
  dispatch table's value type, replacing the inline signature.
- `withScopedContext`, `getCurrentPostMessage`, `emitMessage`, `scopedPostMessage`
  and `clientId` are all **deleted**. `route()` builds the context once.
- 39 private handler methods took `ctx` as their first parameter (85 call sites);
  90 dispatch-table lambdas took it as their second.
- The `READY` handler's hand-rolled `const send = …; const clientId = …` snapshot
  before the detached `completeBrowserReadyAfterStartup` call is gone — that was a
  manual workaround for this very bug, applied in the one place someone noticed
  it. `ctx` now makes it unnecessary everywhere.

Original specification, kept for reference:

Add to `src/ui/` (co-located with the router):

```ts
/** Per-message client scope, captured once at dispatch and never re-read. */
export interface WebviewClientContext {
  readonly clientId: string;
  readonly postMessage: PostMessageFn;
  /** Send a message back to the originating client. */
  emit(message: unknown): void;
}
```

- `withScopedContext` builds one context per message and passes it to
  `routeSingleMessage`, which passes it to the handler.
- Dispatch-table signature becomes
  `(message: any, ctx: WebviewClientContext) => void | Promise<void>`.
- `this.clientId` / `this.scopedPostMessage` / `emitMessage()` / `getCurrentPostMessage()`
  are deleted from the router. Their absence is what makes the drift unrepresentable —
  leaving them as deprecated fallbacks defeats the whole phase.
- The mutable-field + `try/finally` restore dance in `withScopedContext` goes away
  entirely; scope is now a value, not router state.

**Test:** add a regression test that routes a fire-and-forget message under a
browser `clientTag` whose orchestrator call rejects, and asserts the failure reply
and republished identity go to the *browser* `postMessage`, not the default one.
Today that test fails. `src/test/unit/WebviewSettingsSync.test.ts` already builds
routers directly (11 construction sites) and is the natural home.

## Phase 1 — Extract the mutation protocol ✅ **DONE**

Landed 2026-07-24 in `src/ui/WorkflowMutationCoordinator.ts` (204 lines).

Moved `finishWorkflowPropertiesMutation`, `prepareDefinitionMutation`,
`prepareWorkflowPropertiesMutation`, `asWorkflowDefinitionMutation`,
`refreshDefinitionMutationView`, `publishViewIdentity`, `reportActionFailure`,
`canStartRun`, and `showRunActionFailure` into a new `WorkflowMutationCoordinator`
class, taking `getOrchestrator` in the constructor exactly as specified. All doc
comments moved verbatim, including the wedge-prevention rationale on
`publishViewIdentity`/`reportActionFailure`, the run-addressed-broadcast redundancy
note on `refreshDefinitionMutationView`, and the run-start gate's
hosted-client-replay origin on `canStartRun`.

One deviation from the original text: `showRunActionFailure` was not adjacent to
the other eight methods (six Phase-3 run-lifecycle handlers — `handleExecuteDraft`
through `handleRunExecutionControl` — sit between `canStartRun` and it in the
router). It moved as a second, non-contiguous edit rather than one block copy; the
method bodies themselves are unchanged.

The router gained a `private readonly mutationCoordinator: WorkflowMutationCoordinator`
field, constructed alongside `undoRedoCoordinator` in the constructor. Every
remaining call site in the router (the `routeSingleMessage` catch-all, the
Phase-3 step/run handlers that still live in the router, and the still-inline
`LOAD_WORKFLOW`/`UPDATE_PROMPT`/etc. handlers) now calls
`this.mutationCoordinator.xxx(...)`; internal calls between the coordinator's own
methods (e.g. `finishWorkflowPropertiesMutation` → `refreshDefinitionMutationView`)
stayed as plain `this.xxx(...)` since they moved together into the same class.

`asWorkflowDefinitionMutation`'s inline `import("../types/WebviewMessageTypes").WorkflowDefinitionMutation`
return-type annotations were replaced with a normal top-level `import type` in the
new file — the inline form was working around not wanting a router-wide import for
a single method; the new file has no such constraint.

Verified with `npm run typecheck`, `npx eslint` on both files, and the extension-host
suite grepped to `WebviewMessageRouter|WebviewSettingsSync` (32 passing, including
the Phase-0 client-scoping regression test) — all green with no test changes
required, confirming this was pure code motion.

## Phase 2 — Extract the genuine services

Each of these has near-zero router coupling and is the bulk of the win.

### 2a. `src/ui/PromptEditorSupportService.ts` (~750 lines out)

Moves lines 2275–3077: completions (`handleCompletionRequest`,
`emitCompletionsResponse`, `getCompletionItems`), `handleFileRefValidation`,
`handleSavePastedImage`, `handleFilePreviewUriRequest`, `handleContextRefsValidation`,
`validateContextReference`, `notFoundWithSuggestions`, `resolveContextReferencePath`,
`handleOpenFile`, `buildPriorContextContent`, `handleOpenPriorContext`,
`handleAttachmentTokenCountRequest`, plus `getTempFileManager`.

Dependencies: workspace-root helpers, `getOrchestrator` (prior context only), a
`resolveImageWebviewUri` callback, and the per-call context (needed for the
panel-vs-browser branch in `handleFilePreviewUriRequest`, line 2554). This service
also drags out most of the file's import block — `gpt-tokenizer`, `ContextExpander`,
`PriorContextPreviewBuilder`, `CompletionHelpers`, `FileAccessPolicy`,
`ExternalFileTrustPrompt`.

The security-relevant comments on `handleFilePreviewUriRequest` (lines 2476–2497)
and the `handleOpenFile` trust flow are load-bearing and cross-referenced from
`ui.instructions.md`; move them intact and update that file's
`<relatedFiles>` + the two `<criticalPatterns>` bullets that name
`WebviewMessageRouter.handleFilePreviewUriRequest` and the `OPEN_FILE` handler to
point at the new file.

### 2b. Move git validation down to `GitUtils.ts`

`validateGitContextReference` (lines 2795–2848) is pure git and does not belong in
the UI layer at all — this is the clearest "doesn't belong in the router" case.
The router currently declares its **own** `execFileAsync` and
`GIT_VALIDATION_TIMEOUT_MS` (lines 96–97) while already importing `getStashList`
from `src/utils/GitUtils.ts`, which owns exactly that pattern (`execFileAsync` +
`GIT_TIMEOUT_MS`). Duplicated infrastructure, one file apart.

Move the ref-existence checks into `GitUtils` as e.g.
`gitRefExists(workspaceRoot, gitRef)` returning
`{ exists: boolean; message?: string }`, reusing the module's existing
`execFileAsync`/`GIT_TIMEOUT_MS`. Delete both router-local constants. The stash
branch then calls `getStashList` as a peer rather than reaching across layers.

Note the timeout changes from 5s to `GitUtils`' 10s. That is acceptable for
validation (it only delays a lint marker), but decide it deliberately rather than
by accident — if 5s matters, add an optional timeout parameter instead.

### 2c. `src/ui/HarnessFileMessageService.ts` (~210 lines → ~80)

Lines 769–981 are **five near-verbatim copies** of the same shape: perform an op,
re-run `HarnessFileManager.resolveAllLocations` + `resolveTargetDirectories`, emit
`HARNESS_FILE_OP_RESULT { success: true, files, targetDirectories }`, catch and emit
`{ success: false, error }`. `EXPORT_TO_HARNESS`, `IMPORT_TO_CTRLYOKE`,
`DELETE_FROM_HARNESS`, `SYNC_ALL_TO_HARNESS`, `DELETE_ALL_FROM_HARNESS` differ only
in the middle line — and `DELETE_ALL_FROM_HARNESS` (line 924) omits
`targetDirectories`, which is very likely an unintentional inconsistency worth
confirming against the webview consumer before collapsing.

Collapse to a single `private async runFileOp(ctx, fileType, op: () => Promise<void>)`
plus five one-line callers. This is the single largest DRY violation in the file.

### 2d. `src/ui/McpManagerService.ts` (~150 lines out)

Moves lines 3111–3236 (`getMcpRegistryFileManager`, `getHarnessMcpExporter`,
`emitManagedMcpRegistryServers`, `handleSaveMcpRegistryServer`,
`handleDeleteMcpRegistryServer`, `handleRequestMcpRegistrySearch`,
`handleExportMcpToHarness`, `handleDeleteMcpFromHarness`) plus the thin table
entries at 720–766. `handleExportMcpToHarness` and `handleDeleteMcpFromHarness`
share an identical "re-scan and emit `MCP_LOCAL_SCAN_RESULT`" tail — fold it into
one private helper while moving.

### 2e. `src/ui/TerminalMessageHandlers.ts` (~230 lines out)

Moves the PTY block at lines 1546–1722 **and** the panel-reconnect loop currently
inlined in the `READY` handler (lines 331–370), which is the same concern living in
two places.

`TERMINAL_SPAWN_SHELL` (1601) and `TERMINAL_RESTART_SHELL` (1649) pass byte-identical
`onData`/`onExit` callbacks; extract one `buildSessionCallbacks()` factory. The
controller-gate check is also duplicated verbatim between `TERMINAL_INPUT` (1553)
and `TERMINAL_RESIZE` (1567) — extract `isController(session, ctx)`.

Keep the comments explaining why viewport hints need no gate (1591–1593) and why
the panel skips terminal replay (1252–1258) — both are non-obvious and both are
called out in `ui.instructions.md`.

## Phase 3 — Extract the step / run-lifecycle handlers

Only now, with Phase 1 in place, does the excerpt the discussion started from
(lines 1738–2269) become cleanly extractable.

New `src/ui/WorkflowStepHandlers.ts` (~400 lines out): `handleExecutePrompt`,
`handleUpdatePrompt`, `handleInsertWorkflowStep`, `handleUpdateFinalStep`,
`handleDeletePrompt`, `handleUpdateWorkflowProperty`, `handleUpdateWorkflowProperties`,
`handleExecuteDraft`, `handleSeedNewRun`, `handleStartNewRunInstead`,
`handleContinueRun`, `handleAppendAndContinue`, `handleRunExecutionControl`,
`handleSetStartPosition`, `handleDiscardContinuation`.

It takes `getOrchestrator`, `settingsSync`, and the `WorkflowMutationCoordinator`.
The inline `UNDO_REDO_SYNC` handler (lines 577–633, ~60 lines with the
undefined-stripping subtlety) should move here as a named method at the same time —
it is by far the largest inline handler left in the table and its comment about
`allowDeletes` wiping live working-file values is the kind of thing that gets lost
in a wall of `table.set`.

This file is the one place the category-split instinct is right, because these
handlers genuinely share the mutation/revision protocol with each other and with
nothing else.

## Phase 4 — Split the dispatch table into registrars

The table stays in `WebviewMessageRouter.ts` — this preserves the single lookup
point — but `buildDispatchTable()` becomes ~20 lines:

```ts
private buildDispatchTable(): DispatchTable {
  const table: DispatchTable = new Map();
  this.registerLifecycle(table);
  this.registerDevActions(table);
  this.registerWorkflowControl(table);
  this.registerPromptEditor(table);
  this.registerEditorSupport(table);
  this.registerMcpManager(table);
  this.registerHarnessFiles(table);
  this.registerOutputHistory(table);
  this.registerWorkflowModal(table);
  this.registerWorkflowStatus(table);
  this.registerSettings(table);
  this.registerSaveWorkflow(table);
  this.registerMultiWorkflow(table);
  this.registerRunLifecycle(table);
  this.registerUndoRedo(table);
  this.registerTerminal(table);
  this.registerWorkspaceInit(table);
  return table;
}
```

The existing `// ── Category ──` banner comments already mark these exact boundaries
(449, 529, 635, 719, 768, 983, 1084, 1150, 1218, 1298, 1337, 1379, 1426, 1512, 1545,
1724), so this phase is mechanical. After Phases 1–3, each registrar is 20–70 lines
of near-uniform delegation.

## What deliberately stays

> Line numbers below (and in the Phase 2–4 sections above) predate Phases 0–1 and
> have drifted — Phase 0 deleted `withScopedContext` and Phase 1 moved ~170 lines
> out of the router. Re-verify against the current file before acting on any of
> them; treat the method/handler names as the durable reference.

- `route` / `routeSingleMessage` — the actual routing contract and the
  serialization guarantee. (`withScopedContext` no longer exists — deleted in
  Phase 0.)
- The `READY` handler's non-terminal body (237–330): startup ordering, the
  browser-vs-panel asymmetry, and the deliberate non-awaited
  `completeBrowserReadyAfterStartup`. This is genuinely router lifecycle, its
  ordering constraints are subtle and heavily commented, and it is the highest-risk
  thing to move for the least gain.
- Every 1–5 line delegation to `settingsSync` (1219–1335), `serializer` (1338–1377,
  1085–1148), and `orchestrator` (1725–1733). Relocating these adds a hop and
  removes nothing.
- The `UndoRedoCoordinator` delegations (1513–1543) — already correct.

## Expected shape

| File                             | Approx. lines | Status |
| -------------------------------- | ------------: | ------ |
| `WebviewMessageRouter.ts`        |    ~700–800 (currently 3,222) | Phases 2–4 pending |
| `PromptEditorSupportService.ts`  |        ~750 | proposed |
| `WorkflowStepHandlers.ts`        |        ~450 | proposed |
| `TerminalMessageHandlers.ts`     |        ~240 | proposed |
| `McpManagerService.ts`           |        ~160 | proposed |
| `WorkflowMutationCoordinator.ts` |        196 | ✅ done |
| `HarnessFileMessageService.ts`   |         ~90 | proposed |
| `GitUtils.ts`                    |    +~55 | proposed |

## Sequencing and risk

Phases are independently shippable **in order**; Phase 0 gates everything.

- **Phase 0** is the only risky one — it touches every handler signature. It is also
  the only phase that fixes a bug, so it carries its own regression test. Do it
  alone, in its own commit. ✅ done.
- **Phase 1** ✅ done — pure code motion, verified against the Phase 0 regression
  test plus the rest of the router suite with no test changes needed.
- **Phase 2** is the largest by volume but the lowest risk: near-pure code motion
  with no shared mutable state. 2b/2c/2d/2e are independent of each other. Not
  started.
- **Phase 3** depends on Phase 1 (done) and can now proceed. **Phase 4** should be
  last, when the registrars are already thin. Neither started.

Testing: `src/test/unit/WebviewSettingsSync.test.ts` constructs `WebviewMessageRouter`
at 11 sites and is the de facto router test file. Phase 0 changes its construction
and routing expectations; every later phase should leave it passing untouched, which
is the signal that a phase was pure motion. Consider renaming it to
`WebviewMessageRouter.test.ts` (or splitting out the router cases) once Phase 0 lands —
the current name hides where router coverage actually lives.

## Instruction-file follow-up

`.github/instructions/ui.instructions.md` names `WebviewMessageRouter` in its
`<architecture>` summary, in two `<criticalPatterns>` bullets (inline image previews;
`OPEN_FILE` binary-file branching), in the `ExternalFileTrustPrompt` bullet, and in
`<relatedFiles>`. Update all five as the corresponding phase lands — not in a
batch at the end, or the file will describe a layout that does not exist yet.
