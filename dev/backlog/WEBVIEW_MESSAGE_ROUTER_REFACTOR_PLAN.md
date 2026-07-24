# WebviewMessageRouter Refactor Plan

Status: **Phases 0–2 complete** (2026-07-24).
Sub-phases 2a–2e landed. Phases 3–4 remain proposed.

> **Uncommitted.** Phases 0–2 are in the working tree, not committed. Verified green
> (`npm run typecheck`, `npx eslint`, 1982 extension tests, 1180 UI tests) but the
> router carries ~19 pre-existing Prettier deviations that predate this work and
> were deliberately not touched — run `npx prettier --write src/ui/WebviewMessageRouter.ts`
> as a separate cleanup before committing, so the reformat doesn't mix into the motion diff.

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

**Progress: 2a ✅, 2b ✅, 2c ✅ (2026-07-24). 2d and 2e not started.**

Router went 3,222 → 2,209 lines across the three. Each sub-phase left
`src/test/unit/WebviewSettingsSync.test.ts` passing untouched — the plan's stated
signal that a phase was pure motion. All line numbers cited in the sub-sections
below are from the pre-Phase-0 file and are now badly stale; use the method and
message-type names as the durable reference.

### 2a. `src/ui/PromptEditorSupportService.ts` ✅ **DONE**

Landed 2026-07-24, 875 lines out (router 3,186 → 2,364). All 16 named methods
moved; the plan's method list was accurate. The methods were contiguous at
2,170–2,967, not the 2,275–3,077 cited below.

```ts
constructor(
  private readonly getWorkspaceRoot: () => string,
  private readonly getOrchestrator: () => WorkflowOrchestrator | undefined,
  private readonly resolveImageWebviewUri: (absolutePath: string) => string | undefined
) {}
```

Exactly the three dependencies predicted. Both callbacks are wired as thunks, not
bound references, so late binding through `this.callbacks` is preserved. No client-id
or postMessage state — the Phase-0 `ctx: WebviewClientContext` remains the only
source, including for `handleFilePreviewUriRequest`'s `PANEL_CLIENT_ID` branch.

Nine methods are public (`buildPriorContextContent` among them, because
`REQUEST_PRIOR_CONTEXT_PREVIEW` calls it directly); the other seven stayed private.
Both load-bearing security comment blocks moved verbatim. One Phase-1-style
normalization: `buildPriorContextContent`'s inline
`import("../types/CtrlYokeTypes").WorkflowStep` became a top-level `import type`.

Instruction-file updates: four `ui.instructions.md` edits (the three
`<criticalPatterns>` bullets on inline image previews, `OPEN_FILE`, and
`ExternalFileTrustPrompt`, plus a new `<relatedFiles>` entry). The image-preview
bullet's closing clause "the gate belongs in the router" became "the gate belongs
host-side, in `PromptEditorSupportService`" — the one sentence the move falsified.
The `<architecture>` bullet was deliberately left alone: it only claims the router
is the inbound control plane with a dispatch table plus chained `routeQueue`, all
still true because the table stayed. Six further stale symbol citations were fixed
in `completions.instructions.md` (5) and `utils.instructions.md` (2).

Original specification, kept for reference:

#### (original) 2a. `src/ui/PromptEditorSupportService.ts` (~750 lines out)

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

### 2b. Move git validation down to `GitUtils.ts` ✅ **DONE**

Landed 2026-07-24. `GitUtils.ts` +56 lines (378 → 434), router −36.

```ts
export async function gitRefExists(
  workspaceRoot: string,
  gitRef: string
): Promise<{ exists: boolean; message?: string }>
```

Placed between `searchCommitsBySubject` and `getGitTrackedFiles`, reusing the
module's `execFileAsync` and `GIT_TIMEOUT_MS`. It handles the `diff`/`staged`
pseudo-refs and abbreviated/full hashes. Its doc comment flags the one module
convention it breaks — it never throws, because the sole consumer drives a lint
marker where a rejection is indistinguishable from "not found".

**Timeout decision, made deliberately:** `GIT_TIMEOUT_MS` is 10,000 ms, so ref
validation moved from 5s to 10s. Took the reuse option; did **not** add an optional
timeout parameter, since a second timeout constant would reintroduce exactly the
duplication this sub-phase removes, and the only cost is a delayed lint marker.

Deleted from the router: `execFileAsync`, `GIT_VALIDATION_TIMEOUT_MS`, and the
`execFile`/`promisify` imports (grep-confirmed unused). Every returned message
string is byte-identical from the webview's point of view.

**One seam where the split isn't free:** stash refs deliberately stay in the router
(`gitRefExists` matches none of them and its doc comment points callers at
`getStashList`), so the stash branch needed its own `try/catch` to preserve the
`"git context not found"` fallback the shared outer catch used to provide. That's
4 lines of `catch` that would disappear if `gitRefExists` also owned stash resolution.

`GitUtils.ts` had **no test file at all**; added `src/test/unit/GitUtils.test.ts`
(8 tests, temp-git-repo pattern borrowed from `WorkspaceSnapshotService.test.ts`),
including one pinning that `gitRefExists` does not claim `stash:N`.

Original specification, kept for reference:

#### (original) 2b. Move git validation down to `GitUtils.ts`

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

### 2c. `src/ui/HarnessFileMessageService.ts` ✅ **DONE**

Landed 2026-07-24, 207 lines (router 2,364 → 2,209). Larger than the ~80 estimate
because the whole section moved, not just the five duplicated handlers.

```ts
constructor(private readonly getWorkspaceRoot: () => string) {}

private async runFileOp(
  ctx: WebviewClientContext,
  fileType: HarnessFileType,
  op: (workspaceRoot: string) => Promise<void>
): Promise<void>
```

`runFileOp` passes the workspace root **into** the op rather than taking the
plan's bare `() => Promise<void>` — it already resolves the root once, outside the
`try`, exactly as the originals did, so handing it over saves five re-resolutions.
A second helper, `resolveFileView(workspaceRoot, fileType)`, returns
`{ files, targetDirectories }`.

**Scope deviation:** all seven handlers in the section moved, not the plan's five.
`REQUEST_HARNESS_FILES` was a *sixth* copy of the `resolveAllLocations` +
`resolveTargetDirectories` pair (hence `resolveFileView`), and `OPEN_HARNESS_DIR`
was the router's last `fs` consumer. Taking both is what let `HarnessFileManager`
and `import * as fs` leave the router entirely.

**The `DELETE_ALL_FROM_HARNESS` `targetDirectories` question — resolved: the
omission was unintentional, and the payload is now uniform.** Three independent
findings, and the middle one is the durable gotcha:

1. `HarnessFileManager.resolveTargetDirectories` is pure path derivation over a
   fixed target list × both scopes. It never stats the filesystem and never
   inspects what an op just did, so its result before and after a delete-all is
   identical by construction.
2. **The store treats an absent `targetDirectories` as "keep the previous value",
   not "clear it"** — `useHarnessFileStore.ts` does `targetDirectories ?? state.targetDirectories`,
   and `useMessageHandler.ts` passes `message.targetDirectories` through *without*
   a `?? []`, unlike the `HARNESS_FILES_RESULT` handler directly above it, which
   does coalesce. That asymmetry is why the omission never blanked the UI.
3. The preserved list was the same list anyway: delete-all is always issued for the
   active `fileType`, whose directories were already loaded by `requestFiles()`.

So including the field is a no-op for every realistic sequence and strictly more
correct for the pathological one (a client whose store still holds directories for
a previously active `fileType`). **Behavior change, flagged:** the wire payload now
carries `targetDirectories`; observable UI state does not change.
`HarnessFileOpResultMessage` already declared the field optional, so no type change.

`HARNESS_FILE_OP_RESULT` had **zero** coverage on either side; added
`src/test/unit/HarnessFileMessageService.test.ts` (3 tests), one of which pins the
identical success key set across all five mutating ops — that's the assertion
holding the collapse in place. One `<relatedFiles>` line added to `ui.instructions.md`.

Original specification, kept for reference:

#### (original) 2c. `src/ui/HarnessFileMessageService.ts` (~210 lines → ~80)

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

### 2d. `src/ui/McpManagerService.ts` ✅ **DONE**

Landed 2026-07-24, 174 lines. The complete `// ── MCP Manager ──` concern moved:
all seven dispatch entries now delegate to the service, and the registry-manager,
harness-exporter, discovery, save/delete/search, and local-scan implementations
left the router. The constructor needs only `getWorkspaceRoot`, matching the
dependency shape discovered in 2a/2c.

The duplicated post-mutation discovery tail is now one private `emitLocalScan`
helper, also used by the explicit `REQUEST_MCP_LOCAL_SCAN` handler. Export's
zero-count early return remains before that helper, preserving the original rule
that a no-op export shows a warning without re-scanning. `McpDiscoveryUtils`,
`HarnessMcpExporter`, and `McpRegistryFileManager` are no longer router imports.

No behavior changed and no test needed construction changes. Verified through
the existing router suite and the full extension/UI suites.

#### (original spec)

Moves lines 3111–3236 (`getMcpRegistryFileManager`, `getHarnessMcpExporter`,
`emitManagedMcpRegistryServers`, `handleSaveMcpRegistryServer`,
`handleDeleteMcpRegistryServer`, `handleRequestMcpRegistrySearch`,
`handleExportMcpToHarness`, `handleDeleteMcpFromHarness`) plus the thin table
entries at 720–766. `handleExportMcpToHarness` and `handleDeleteMcpFromHarness`
share an identical "re-scan and emit `MCP_LOCAL_SCAN_RESULT`" tail — fold it into
one private helper while moving.

### 2e. `src/ui/TerminalMessageHandlers.ts` ✅ **DONE**

Landed 2026-07-24, 250 lines. The complete PTY dispatch block and the panel's
active-session reconnect loop moved. The router retains READY ordering and
panel-only lifecycle decisions, but delegates both the `skipTerminalReplay`
choice and reconnect replay to `TerminalMessageHandlers`; every terminal dispatch
entry is now a thin delegation.

The duplicated spawn/restart callbacks collapsed into `buildSessionCallbacks()`,
and input/resize share `isController(session, ctx)`. The load-bearing explanation
for skipping panel terminal replay moved to `shouldSkipClientReadyReplay`, while
the viewport-hint no-gate explanation moved intact with its handler. Controller
assignment, broadcast-vs-targeted delivery, reconnect-buffer clearing, and shell
error notifications are behavior-identical.

No router test construction changed. Verified through the existing router suite
and the full extension/UI suites.

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
| `WebviewMessageRouter.ts`        |    ~700–800 target (currently 1,867, was 3,222) | Phases 3–4 pending |
| `PromptEditorSupportService.ts`  |        875 | ✅ done (2a) |
| `WorkflowStepHandlers.ts`        |        ~450 | proposed |
| `TerminalMessageHandlers.ts`     |        250 | ✅ done (2e) |
| `McpManagerService.ts`           |        174 | ✅ done (2d) |
| `WorkflowMutationCoordinator.ts` |        196 | ✅ done |
| `HarnessFileMessageService.ts`   |        207 | ✅ done (2c) |
| `GitUtils.ts`                    |    +56 (378 → 434) | ✅ done (2b) |

Test files added along the way: `src/test/unit/GitUtils.test.ts` (8 tests, 2b) and
`src/test/unit/HarnessFileMessageService.test.ts` (3 tests, 2c) — both areas had
zero prior coverage. Extension suite went 1,971 → 1,982 passing.

## Sequencing and risk

Phases are independently shippable **in order**; Phase 0 gates everything.

- **Phase 0** is the only risky one — it touches every handler signature. It is also
  the only phase that fixes a bug, so it carries its own regression test. Do it
  alone, in its own commit. ✅ done.
- **Phase 1** ✅ done — pure code motion, verified against the Phase 0 regression
  test plus the rest of the router suite with no test changes needed.
- **Phase 2** ✅ done — the largest by volume but the lowest risk: near-pure code
  motion with no shared mutable state. The claim
  that the sub-phases are mutually independent held, with one exception worth
  knowing: **2b must precede 2a**, because 2a moves `validateContextReference`,
  which is `validateGitContextReference`'s caller. Order them that way if this is
  ever replayed. 2d and 2e were genuinely independent of each other and of the
  earlier sub-phases.
- **Sub-phases are not safely parallelizable** despite being logically independent:
  every one of them edits `buildDispatchTable()` in the same file, so concurrent
  agents conflict. Run them one at a time.
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

Status after Phase 2: the three prompt-editor `<criticalPatterns>` bullets, the
terminal-ownership bullet, utils' MCP-consumer reference, and `<relatedFiles>` are
updated to the extracted owners. The `<architecture>` router bullet was checked
and deliberately left as-is — it describes the router as the inbound control
plane with a dispatch table plus chained `routeQueue`, which stays true through
every phase here, since the table itself never leaves the router. Revisit it only
if Phase 4 changes that.
