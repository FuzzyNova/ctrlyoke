# Dead Class-Method & Incomplete-Feature Audit

**Status (2026-07-29):** Phase 7 is complete, and the Phase 1 harness slice is
complete. The nominal-type fixes described
below are applied, reducing the finder from 91 to 56 candidates; the completed
Phase 1 harness, core-engine, and utils/config/platform/git slices reduce it to 15. This documents
the output of two sweeps run after deleting `EndConditionHandler.handleExecutionError`
(a dead public method that `knip` could not see because it lives on an
otherwise-live class — see `git log` for that commit) and building a tool to
find more of the same pattern.

**Update (same day, second pass):** the first version of this audit only
scanned the root `tsconfig.json` project (extension host, core, CLI/MCP,
harness, tests) and explicitly called `src/ui/webview-react` out of scope.
That was wrong to leave out — the webview imports directly from extension-side
directories via path aliases (`@root/types/*`, `@root/utils/*`,
`@root/completions/*` in `src/ui/webview-react/tsconfig.json`), so a method
that looks unused from one project's view could in principle be the other
project's only caller. `scripts/find-dead-methods.mjs` now builds one combined
TypeScript program from both tsconfigs so cross-project references are
visible. Re-running it did **not** change any of the extension-side findings
below (none of those 82 turn out to be webview-only callers) but it did
surface 21 new webview-side candidates — see "Sweep 1b" below.

**Related plans:**

- [`BROWSER_USER_FEEDBACK_PLAN.md`](./BROWSER_USER_FEEDBACK_PLAN.md) — Site 1
  is the `handleExecutionError` precedent for how to verify-then-delete a
  candidate from this audit.
- [`STANDALONE_SERVER_PLAN.md`](./STANDALONE_SERVER_PLAN.md) — several
  `WorkflowOrchestrator` methods below are scaffolding for this plan's
  unimplemented phases, not orphaned code; see the special case below before
  deleting any of them.

## Why this exists

`knip` (and `ts-prune`/`ts-unused-exports`) only analyze module-level exports.
A class that is legitimately imported and used reads as "live" to those tools
even if individual public methods on it have zero callers — mark-and-sweep
stops at "the class is reachable" and never looks inside at per-method
reachability. `EndConditionHandler.handleExecutionError` sat dead for an
unknown amount of time for exactly this reason.

## New tool: `scripts/find-dead-methods.mjs`

Walks every class method declaration reachable from **both** the root
`tsconfig.json` (extension host, core engine, CLI/MCP binaries, harness code,
tests) and `src/ui/webview-react/tsconfig.json` (the React dashboard),
combined into a single TypeScript program, and uses the language service's
`findReferences` (the same engine behind VS Code "Find All References") to
count non-declaration usages across both projects at once. Anything at zero
is reported as a candidate.

```
node scripts/find-dead-methods.mjs           # human-readable
node scripts/find-dead-methods.mjs --json    # machine-readable
```

**Scope:** all of `src/`. The two projects are merged into one program (base
options taken from the webview tsconfig, since it carries the `paths` aliases
and DOM lib; `lib`/`target` widened to a superset covering both Node and DOM
globals) precisely so a method that's only called from the _other_ project's
files still shows up as referenced. No dependency install was needed —
`@types/react` was already present.

**Known false-positive sources** (confirmed while triaging this run's
output — see "Bucket C" below):

1. **Duck-typed structural casts.** `CliIntegration.ts:229` formerly did
   `this.platform as unknown as { getConfig?: ... }` and called through that
   inline type. Phase 7 added the optional member to `PlatformAdapter` and
   removed the cast, so `CliAdapter.getConfig` and all three
   `MockPlatform.getConfig` declarations now resolve nominally.
2. **Structural (non-`implements`) interface satisfaction.** Phase 7 added
   explicit DOM/library heritage clauses to the `FakeWebSocket`/`FakeStorage`
   doubles in `src/test/unit/StandaloneShim*.test.ts` and to the webview
   `ResizeObserver`, xterm terminal, fit-addon, and WebGL mocks. Those methods
   now resolve nominally.
3. One real bug was found and fixed while building this: the interface-member
   exclusion originally bailed out via `type.getSymbol()` returning
   `undefined`, which happens for aliased intersection types like
   `DashboardClient = IDashboardProvider & Partial<IDashboardSink>`. That
   silently disabled the exclusion for every class implementing an aliased
   type instead of a plain `interface`, producing ~13 false positives on
   `NotificationManager` alone. Fixed in the script as shipped; flagging here
   so nobody "fixes" it back.
4. **React class-component lifecycle (`extends React.Component`, not
   `implements`).** Found once the webview project was added: `render()`,
   `componentDidCatch()`, etc. are invoked by the React runtime via prototype
   dispatch on a class that `extends Component<Props, State>`. The original
   script only excluded `implements` heritage clauses; it now checks
   `extends` too (same `getPropertyOfType` mechanism), which handles this
   case generically. A fixed list of React lifecycle method names is also
   kept in `IGNORED_METHOD_NAMES` as defense-in-depth.
5. **Anonymous framework-plugin classes and structural runtime mocks.** The
   seven CodeMirror classes and 13 webview mocks originally had no heritage
   clause. Phase 7 added `implements PluginValue` and the relevant
   `Pick<...>` clauses, so those methods now resolve nominally. The remaining
   `MockVsCodePlatform.getExtensionContext()` candidate is different: it is a
   VS Code-only method reached through the intentional dynamic discriminator
   in `CliIntegration`, and remains for Step 6 rather than broadening the
   cross-platform `PlatformAdapter` contract.
   Before Phase 7, this category was **not mechanically fixable** by the
   heritage-clause check, because there was no heritage clause to inspect:
   - CodeMirror's `ViewPlugin.fromClass(class { update(update) {...} ... })`
     pattern (7 hits in `CodeMirrorEditor.tsx` and `WorkspaceFileEditor.tsx`)
     — CodeMirror calls `update()` on the instance it constructs; the class
     literal never declared what it implemented.
   - `vi.stubGlobal("ResizeObserver", class { observe() {} ... })` and
     `vi.mock("@xterm/xterm", () => class MockTerminal { ... })`-style test
     doubles (13 hits across `test/setup.ts` and `terminalRegistry.test.ts`)
     — same structural-satisfaction blind spot as the `FakeWebSocket`/
     `FakeStorage` doubles found on the extension side, just more common in
     the webview's test suite. See "Sweep 1b" below for the full list.

This is a **heuristic triage tool**, not a source of truth. Every candidate
below still needs the same independent verification `handleExecutionError`
got — repo-wide search including tests/docs, trace where the equivalent
behavior actually lives now — before deletion.

## Coding conventions that would prevent these blind spots

Every false-positive category above has the same root cause, and it's the
same root cause behind a complaint independent of this audit: **VS Code's
own "Find All References" sometimes says "no references" for a symbol a
plain text search finds immediately.** That's not a coincidence — VS Code's
navigation and `scripts/find-dead-methods.mjs` both run on the exact same
TypeScript language service. A reference is only "visible" to either tool if
the checker can walk, symbol by symbol, from the call site back to the
declaration. Anything that breaks that chain — an `as unknown as {...}`
cast, a class that satisfies a type structurally without saying so, an
anonymous class handed straight into a framework function — makes the
reference invisible to _both_ tools at once, not just one. Text search still
finds it because text search doesn't care about types; it's also why text
search is a noisier, weaker signal (Bucket C above), not a stronger one.

The fix is the same in every case: **make the structural relationship
nominal.** These are all zero-runtime-cost changes — they don't change what
the code does, only what the type checker can see:

1. **Replace inline anonymous-type casts with a real shared type.**
   `CliIntegration.ts:229` does
   `this.platform as unknown as { getConfig?: (key: string, defaultValue: string) => string }`
   instead of typing against `PlatformAdapter` directly. Adding
   `getConfig?(key: string, defaultValue: T): T;` as an optional member on
   `PlatformAdapter` itself (or a small exported `HasGetConfig` interface
   that `CliAdapter`/`MockPlatform` explicitly `implements`) removes the cast
   entirely and makes the call site traceable to the real declarations —
   this is exactly what caused `getConfig()` to read as dead everywhere it's
   actually defined.

2. **Give test doubles an `implements` clause for _every_ type they stand
   in for, not just the narrowest one.** `FakeWebSocket implements FakeSocket`
   in `HostedStandaloneShimScript.test.ts` looks like it should have
   prevented the `addEventListener`/`send`/`close` false positives, but
   `FakeSocket` is a narrow local interface that doesn't declare those
   methods — `FakeWebSocket` is _also_ structurally standing in for
   `window.WebSocket` at its injection site, just without saying so. Adding
   a second heritage entry, e.g.
   `implements FakeSocket, Pick<WebSocket, "addEventListener" | "send" | "close">`,
   costs nothing and closes the gap. Same fix for `FakeStorage` in
   `StandaloneShimState.test.ts` (`implements Pick<Storage, "setItem" | "removeItem">`),
   `MockTerminal`/`MockFitAddon` in `terminalRegistry.test.ts`
   (`Pick<Terminal, ...>` / `Pick<FitAddon, ...>`), and the `ResizeObserver`
   mock in `test/setup.ts` (`implements ResizeObserver`).

3. **Annotate anonymous framework-plugin classes with the library's own
   interface when one is exported.** CodeMirror's
   `ViewPlugin.fromClass(class { update(update) {...} })` pattern already
   requires the class to structurally match CodeMirror's exported
   `PluginValue` interface (from `@codemirror/view`) — it just never says so.
   Writing `ViewPlugin.fromClass(class implements PluginValue { ... })`
   changes nothing at runtime (CodeMirror was already enforcing that shape)
   but gives both VS Code and the script a heritage clause to hang the
   reference on.

4. **Avoid string-keyed/dynamic dispatch where a typed call would do** (no
   concrete instance found in this audit, but worth stating as a standing
   rule): `obj[methodName]()`, reflection over `Object.keys(this)`, or a
   command-ID string table not backed by a typed map are permanently
   invisible to both tools regardless of any heritage-clause fix — there's
   no symbol-level edge to find at all. If ctrlyoke ever needs dynamic
   dispatch, keep the set of valid keys as a typed union/const object next to
   the dispatch site so at least the _set_ of valid targets is checked, even
   though individual call-site tracing still won't work.

None of this is required for the Phase 1–3 deletions below — those still get
verified by hand. This is future-facing: applying pattern 1–3 to the
false-positive sites identified in this audit (as part of the `@keep`-tagging
work in Phase 3) would let those methods drop the `@keep` tag entirely,
since the script would then resolve their references correctly on its own.
See Phase 7 in the plan below.

## Sweep 1a: extension-side dead class-method candidates (82 found)

Unchanged from the first pass of this audit — re-running after combining both
projects into one program produced the identical 82 candidates below, meaning
none of them turn out to have a webview-side caller. That's a real result now
(checked), not an assumption.

Method names are frequently reused across unrelated classes in this codebase
(`show`, `close`, `send`, `reset`, `clear`, `initialize`...). To cheaply
pre-triage the 82 language-service candidates, each candidate's method name
was also grepped as `\.name\(` across the **entire repo** (not just the
tsconfig scope — includes `webview-react`, `docs/`, `dev/`, `prompts/`,
templates). This total is **per method name, not per class** — if two
flagged classes share a name (e.g. `ClaudeLogParser.setWorkspaceRoot` and
`QwenLogParser.setWorkspaceRoot`), the count is their combined total, not a
per-class breakdown. Treat it as a coarse pre-filter, not a verdict.

### Bucket A — zero occurrences anywhere in the repo (39 candidates)

Strongest signal: not found via symbolic reference _or_ as plain text,
including in docs, prompts, and templates. Still verify each one the way
`handleExecutionError` was verified — this narrows the search, it doesn't
replace it.

| Location                                                          | Method                                                                                                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/harness/shared/interfaces/IToolPermissionMapper.ts:100` | `ToolPermissionMapperBase.matchesAnyPattern()` — **deleted 2026-07-29 (Step 2)**                                                                                                  |
| `src/core/harness/shared/interfaces/IToolPermissionMapper.ts:155` | `ToolPermissionMapperBase.isValidPattern()` — **deleted 2026-07-29 (Step 2)**                                                                                                     |
| `src/core/harness/shared/interfaces/IToolPermissionMapper.ts:164` | `ToolPermissionMapperBase.normalizeTool()` — **deleted 2026-07-29 (Step 2)**                                                                                                      |
| `src/utils/AgentExpander.ts:101`                                  | `AgentExpander.getAgentCommandName()` — **deleted 2026-07-29 (Step 4)**; its private frontmatter-name helper became dead and was removed as cascade                               |
| `src/utils/TempFileManager.ts:48`                                 | `TempFileManager.getTempDir()` — **deleted 2026-07-29 (Step 4)**                                                                                                                  |
| `src/utils/TempFileManager.ts:520`                                | `TempFileManager.getStats()` — **deleted 2026-07-29 (Step 4)**                                                                                                                    |
| `src/core/HarnessIntegration.ts:612`                              | `HarnessIntegration.buildPriorContextXml()` — **deleted 2026-07-29 (Step 3)**; live code uses `buildPriorContextXmlFromItems()` and its module-level serializer                   |
| `src/core/HarnessIntegration.ts:616`                              | `HarnessIntegration.stripAnsiCodes()` — **deleted 2026-07-29 (Step 3)**; live code calls the module-level sanitizer                                                               |
| `src/core/HarnessIntegration.ts:820`                              | `HarnessIntegration.updateWorkflowProgress()` — **deleted 2026-07-29 (Step 3)**; no caller or status-bar contract exists                                                          |
| `src/core/HarnessIntegration.ts:945`                              | `HarnessIntegration.testAutomation()` — **deleted 2026-07-29 (Step 3)**; no caller or diagnostic contract exists                                                                  |
| `src/core/harness/shared/HeadlessLogTail.ts:148`                  | `HeadlessLogTail.handleStdout()` — **deleted 2026-07-29 (Step 2)**                                                                                                                |
| `src/core/harness/copilot/CopilotToolBuilder.ts:94`               | `CopilotToolBuilder.buildInitiatedEvent()` — **deleted 2026-07-29 (Step 2)**                                                                                                      |
| `src/core/harness/shared/SettingsJsonMcpTracker.ts:501`           | `SettingsJsonMcpTracker.hasActiveManagedServers()` — **deleted 2026-07-29 (Step 2)**                                                                                              |
| `src/core/harness/shared/SettingsJsonMcpTracker.ts:506`           | `SettingsJsonMcpTracker.getBaselineServerNames()` — **deleted 2026-07-29 (Step 2)**                                                                                               |
| `src/core/harness/qwen/QwenCliProvider.ts:518`                    | `QwenCliProvider.getAvailableModels()` — **deleted 2026-07-29 (Step 2)**                                                                                                          |
| `src/core/orchestration/TimelineRecorder.ts:33`                   | `TimelineRecorder.isRunEntry()` — **deleted 2026-07-29 (Step 3)**; run-directory filtering uses `WorkflowPaths` directly, with its two legacy filename helpers removed as cascade |
| `src/core/orchestration/TimelineRecorder.ts:48`                   | `TimelineRecorder.extractRunTimestamp()` — **deleted 2026-07-29 (Step 3)**; run ordering uses lineage/run metadata rather than this legacy parser                                 |
| `src/core/WorkflowStateMachine.ts:78`                             | `WorkflowStateMachine.executionEndTime()` — **deleted 2026-07-29 (Step 3)**; timing consumers use `getSnapshot()` and persisted runtime state                                     |
| `src/core/PromptQueue.ts:945`                                     | `PromptQueue.reloadAndMergeQueue()` — **deleted 2026-07-29 (Step 3)**; dynamic queue merging now runs through `WorkingFileManager.mergeDiskSteps()` during reload/write paths     |
| `src/utils/WorkspaceSnapshotService.ts:1181`                      | `WorkspaceSnapshotService.hashCurrentFile()` — **deleted 2026-07-29 (Step 4)**; snapshot reads remain shared by capture/enrichment paths                                          |
| `src/config/FileConfigBackend.ts:44`                              | `FileConfigBackend.startWatching()` — **deleted 2026-07-29 (Step 4)**; no startup caller or `ConfigBackend` contract uses file watching                                           |
| `src/config/FileConfigBackend.ts:73`                              | `FileConfigBackend.stopWatching()` — **deleted 2026-07-29 (Step 4)**; watcher state/imports and unused factory callbacks removed as cascade                                       |
| `src/completions/PromptCompletionProvider.ts:462`                 | `PromptCompletionProvider.clearCache()` — **deleted 2026-07-29 (Step 4)**; the shared `clearFilesCache()` remains owned by `CompletionHelpers`                                    |
| `src/utils/HarnessFileManager.ts:530`                             | `HarnessFileManager.syncToHarnesses()` — **deleted 2026-07-29 (Step 4)**; `SyncResult` and its error-formatting import were dead with it                                          |
| `src/core/orchestration/HistorySearchService.ts:79`               | `HistorySearchService.enqueueIndexRefresh()` — **deleted 2026-07-29 (Step 3)**; `OutputHistoryManager` owns direct index refresh scheduling                                       |
| `src/ui/CtrlYokeWebviewProvider.ts:641`                           | `CtrlYokeWebviewProvider.notifyTerminalStarted()`                                                                                                                                 |
| `src/ui/CtrlYokeWebviewProvider.ts:657`                           | `CtrlYokeWebviewProvider.notifyTerminalOutput()`                                                                                                                                  |
| `src/ui/CtrlYokeWebviewProvider.ts:671`                           | `CtrlYokeWebviewProvider.notifyTerminalEnded()`                                                                                                                                   |
| `src/ui/CtrlYokeWebviewProvider.ts:686`                           | `CtrlYokeWebviewProvider.notifyQueueExtended()`                                                                                                                                   |
| `src/ui/CtrlYokeWebviewProvider.ts:785`                           | `CtrlYokeWebviewProvider.notifyQueueSizeLimitReached()`                                                                                                                           |
| `src/ui/CtrlYokeWebviewProvider.ts:796`                           | `CtrlYokeWebviewProvider.notifyExecutionTimeLimitReached()`                                                                                                                       |
| `src/ui/CtrlYokeWebviewProvider.ts:896`                           | `CtrlYokeWebviewProvider.sendHistoryUndoData()`                                                                                                                                   |
| `src/ui/CtrlYokeWebviewProvider.ts:928`                           | `CtrlYokeWebviewProvider.sendUndoPromptResult()`                                                                                                                                  |
| `src/core/WorkflowOrchestrator.ts:440`                            | `WorkflowOrchestrator.addDashboardProvider()` — see special case                                                                                                                  |
| `src/core/WorkflowOrchestrator.ts:444`                            | `WorkflowOrchestrator.removeDashboardProvider()` — see special case                                                                                                               |
| `src/core/WorkflowOrchestrator.ts:623`                            | `WorkflowOrchestrator.getAllWorkflows()` — see special case                                                                                                                       |
| `src/core/WorkflowOrchestrator.ts:647`                            | `WorkflowOrchestrator.getActiveWorkflowId()` — see special case                                                                                                                   |
| `src/core/WorkflowOrchestrator.ts:1649`                           | `WorkflowOrchestrator.cancelPauseWorkflow()` — see special case                                                                                                                   |
| `src/core/WorkflowOrchestrator.ts:4297`                           | `WorkflowOrchestrator.getHarnessDetailedStatus()` — see special case                                                                                                              |

### Bucket B — 1–3 occurrences, none of them real call sites (14 candidates)

The occurrences that exist are in `dev/backlog/*.md`, `prompts/*.md`, or
test/mock declarations of the _same_ dead method (i.e. the declaration line
itself in a differently-named sibling file) — not a production caller. Still
worth an individual look since 1–3 is a small enough number to just read.

| Location                                             | Method                                                                                       | Where the occurrence(s) are                                                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/harness/claude/ClaudeLogParser.ts:127`     | `setWorkspaceRoot()` — **kept 2026-07-29 (Step 2)**                                          | Live via `CliIntegration`'s intentional property-presence dispatch                                                                                              |
| `src/core/harness/qwen/QwenLogParser.ts:158`         | `setWorkspaceRoot()` — **kept 2026-07-29 (Step 2)**                                          | Live via `CliIntegration`'s intentional property-presence dispatch                                                                                              |
| `src/core/harness/opencode/OpenCodeLogParser.ts:539` | `getLogDirectory()` — **deleted 2026-07-29 (Step 2)**                                        | No caller; OpenCode uses the session ID as its export path                                                                                                      |
| `src/core/PromptQueue.ts:733`                        | `getWorkflowName()` — **deleted 2026-07-29 (Step 3)**                                        | Queue consumers use `getState().workflowName`; the working-file adapter already captures state directly                                                         |
| `src/core/PromptQueue.ts:893`                        | `persistSessionId()` — **kept 2026-07-29 (Step 3)**                                          | `WorkflowExecutor` passes the queue as `WorkflowWorkingFilePersistence`; `CliExecutionRunner` calls the optional hook when session/log discovery resolves an ID |
| `src/ui/StatusBarManager.ts:153`                     | `hide()` — **deleted 2026-07-29 (Step 4)**; status updates call the underlying item directly |
| `src/core/TemplateManager.ts:767`                    | `setDefaultTemplateId()` — **deleted 2026-07-29 (Step 3)**                                   | The active UI route persists through `ConfigurationUtils.setDefaultWorkflowTemplate()` directly                                                                 |
| `src/core/harness/shared/HeadlessLogTail.ts:179`     | `getLogPath()` — **deleted 2026-07-29 (Step 2)**                                             | The result exposes `logPath` directly; no method caller existed                                                                                                 |
| `src/ui/CtrlYokeWebviewProvider.ts:1337`             | `getPanelScopedSend()`                                                                       | —                                                                                                                                                               |
| `src/ui/NotificationManager.ts:65`                   | `notifyStartupComplete()`                                                                    | **confirmed true positive** — see special case                                                                                                                  |
| `src/test/unit/CliIntegration.test.ts:53`            | `MockVsCodePlatform.getExtensionContext()`                                                   | —                                                                                                                                                               |
| `src/core/WorkflowOrchestrator.ts:637`               | `getActiveWorkflow()`                                                                        | `dev/backlog/STANDALONE_SERVER_PLAN.md` — see special case                                                                                                      |
| `src/core/WorkflowOrchestrator.ts:1634`              | `pauseWorkflow()`                                                                            | `dev/backlog/STANDALONE_SERVER_PLAN.md`, `prompts/copilot-integration.prompt.md` — see special case                                                             |
| `src/core/WorkflowOrchestrator.ts:1669`              | `resumeWorkflow()`                                                                           | `dev/backlog/STANDALONE_SERVER_PLAN.md` — see special case                                                                                                      |
| `src/core/WorkflowOrchestrator.ts:1717`              | `stopWorkflow()`                                                                             | `dev/backlog/STANDALONE_SERVER_PLAN.md`, `prompts/copilot-integration.prompt.md` — see special case                                                             |

### Bucket C — 4+ occurrences, name too common to trust the count (29 candidates)

These need a real per-symbol check (IDE "Find All References" on the exact
declaration, or `service.findReferences` in the script) — the aggregate text
count mixes in unrelated classes with the same method name. Two false-positive
patterns from the "known false-positive sources" section above account for
most of this bucket:

- **Duck-typed cast (`getConfig`, count 7):** `CliAdapter.getConfig()`,
  `MockPlatform.getConfig()` (×3, one per test file),
  `MockHarness`'s `MockPlatform.getConfig()` — all genuinely used via
  `CliIntegration.ts:229`'s `as unknown as { getConfig?: ... }` cast. **Do
  not delete these.** Tag with `@keep` in a follow-up so future runs of the
  script skip them without re-litigating.
- **Structural test doubles (`addEventListener`/`send`/`close`/`setItem`,
  counts 9–101):** `FakeWebSocket` in `HostedStandaloneShimScript.test.ts`,
  `StandaloneShimLiveness.test.ts`, `StandaloneShimState.test.ts`, and
  `FakeStorage.setItem`/`.removeItem` in `StandaloneShimState.test.ts`. These
  satisfy their target types structurally (no `implements` clause), so the
  script's interface-exclusion can't see them. Very likely all false
  positives — confirm each test still exercises the method via the object it
  hands to the code under test, then `@keep`-tag rather than delete.

One item in this bucket was manually verified as a **real dead method**
despite the noisy count:

- `src/git/CommitMessageGenerator.ts:371` — `CommitMessageGenerator.generate()`
  (count 6, all unrelated) — **deleted 2026-07-29 (Step 4)**. The class's
  real entry point remains `generateMessage()`, used by `cli.ts`,
  `ScmCommitCommand.ts`, and `HostedWorkspaceViewerService.ts`; `generate()`
  was only an orphaned forwarding wrapper.

The remaining unverified items in this bucket are:
`HarnessIntegration.resolveWorkspacePath()`
(5),
`PromptQueue.loadWorkingFile()` (7), `StreamingHistoryBuffer.clear()` (58,
very common name), `WorkflowInstance.initialize()` (17, common name),
`WorkflowOrchestrator.readWorkingFile()` (22, common name — see special case
below).

The Phase 1 utils/config/platform/git slice also resolved the other requested
Bucket C names: `vscode-shim.ts` `EventEmitter.fire()` was **made nominal**
2026-07-29 (Step 4) by having the shim emitter implement its emulated
contract; `Log.show()` and `Log.append()`, plus
`StatusBarManager.show()`, were **deleted** 2026-07-29 (Step 4) after
per-class searches found no callers. The shim emitter is live through
shim-backed `vscode.EventEmitter` instances in `ModelRegistry`, so it was not
deleted.

The four core-engine Bucket C candidates in this slice were individually
verified and deleted on 2026-07-29 (Step 3); their current source line numbers
are reflected in the finder output above:

- `HarnessIntegration.resolveWorkspacePath()` — no subclass or caller uses it;
  `ContextExpander` owns the active workspace-path resolution and security
  checks.
- `PromptQueue.loadWorkingFile()` — no caller uses this thin wrapper;
  `WorkflowInstance` and its loader use `readWorkingFile()` plus the explicit
  reload modes.
- `StreamingHistoryBuffer.clear()` — no disposal or test path calls it;
  `OutputHistoryManager` flushes the buffer before lifecycle writes.
- `WorkflowInstance.initialize()` — `WorkflowInstance` is a plain class with
  direct construction and no initialization contract or call; all setup occurs
  in its constructor and explicit load/execute methods.

The Phase 1 harness slice checked the three harness-area Bucket C candidates:
`CliTransportCoordinator.writeToCurrentPtySession()` — **kept** because
`CliExecutionRunner` calls it through the transport contract for inject mode;
`CliNotificationMonitor.monitorForCompletion()` — **deleted 2026-07-29**
because the class's current consumers use `NotificationMonitorBase` and only
the shared path/command helpers remain; and
`AntigravityTranscriptReader.reset()` — **deleted 2026-07-29** because no
parser, test, or other runtime caller resets the reader.

## Sweep 1b: webview-side dead class-method candidates (21 found)

New in the second pass, once `src/ui/webview-react` was added to the combined
program. All 21 were individually read (not just grepped) since the set is
small.

### Resolved since audit (1)

| Removed code                                              | Resolution                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/webview-react/terminalRegistry.ts` `InputCapture` | Removed 2026-07-29. `reset()` had no callers, and the remaining browser-keystroke heuristic was also obsolete: provider session logs now authoritatively produce `USER_STEER` output events where available. The heuristic could misclassify TUI commands and does not observe backend inject-mode writes. |

### Resolved false positives — CodeMirror plugin lifecycle (7)

All follow the exact same shape: `ViewPlugin.fromClass(class { ... update(update) {...} ... })` in `CodeMirrorEditor.tsx`, an anonymous class literal handed straight to CodeMirror's plugin constructor. Phase 7 added `implements PluginValue` to each class, making CodeMirror's lifecycle relationship visible to the language service without changing runtime behavior.

| Location                                                                       | Method     |
| ------------------------------------------------------------------------------ | ---------- |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx:1899`             | `update()` |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx:2084`             | `update()` |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx:2606`             | `update()` |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx:2653`             | `update()` |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx:2741`             | `update()` |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx:2853`             | `update()` |
| `src/ui/webview-react/components/workspace-viewer/WorkspaceFileEditor.tsx:403` | `update()` |

### Resolved false positives — structural test/runtime mocks (13)

Same blind spot as the `FakeWebSocket`/`FakeStorage` doubles found on the
extension side (Bucket C), just more common in the webview's test suite.
Phase 7 added explicit `implements`/`Pick<...>` clauses and matched the real
library signatures where required; no test assertions or runtime behavior
changed.

| Location                                                | Method                             | Mocking what                                             |
| ------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------- |
| `src/ui/webview-react/test/setup.ts:10`                 | `observe()`                        | `window.ResizeObserver` (jsdom doesn't implement it)     |
| `src/ui/webview-react/test/setup.ts:11`                 | `unobserve()`                      | `window.ResizeObserver`                                  |
| `src/ui/webview-react/test/setup.ts:12`                 | `disconnect()`                     | `window.ResizeObserver`                                  |
| `src/ui/webview-react/test/terminalRegistry.test.ts:18` | `MockTerminal.loadAddon()`         | `@xterm/xterm`'s `Terminal`                              |
| `src/ui/webview-react/test/terminalRegistry.test.ts:20` | `MockTerminal.open()`              | `@xterm/xterm`'s `Terminal`                              |
| `src/ui/webview-react/test/terminalRegistry.test.ts:24` | `MockTerminal.resize()`            | `@xterm/xterm`'s `Terminal`                              |
| `src/ui/webview-react/test/terminalRegistry.test.ts:29` | `MockTerminal.write()`             | `@xterm/xterm`'s `Terminal`                              |
| `src/ui/webview-react/test/terminalRegistry.test.ts:33` | `MockTerminal.scrollLines()`       | `@xterm/xterm`'s `Terminal`                              |
| `src/ui/webview-react/test/terminalRegistry.test.ts:35` | `MockTerminal.refresh()`           | `@xterm/xterm`'s `Terminal`                              |
| `src/ui/webview-react/test/terminalRegistry.test.ts:37` | `MockTerminal.onData()`            | `@xterm/xterm`'s `Terminal`                              |
| `src/ui/webview-react/test/terminalRegistry.test.ts:49` | `MockFitAddon.fit()`               | `@xterm/addon-fit`'s `FitAddon`                          |
| `src/ui/webview-react/test/terminalRegistry.test.ts:51` | `MockFitAddon.proposeDimensions()` | `@xterm/addon-fit`'s `FitAddon`                          |
| `src/ui/webview-react/test/terminalRegistry.test.ts:75` | `onContextLoss()`                  | `@xterm/addon-webgl`'s `WebglAddon` (inline `vi.doMock`) |

All 20 false positives above (7 CodeMirror + 13 mocks) are now nominal and
need no `@keep` tags. `MockVsCodePlatform.getExtensionContext()` remains a
separate Step 6 candidate because the call site intentionally uses a
VS Code-only dynamic discriminator.

## Special cases worth reading before touching anything

### `WorkflowOrchestrator` pause/resume/stop/dashboard/status family

`addDashboardProvider`, `removeDashboardProvider`, `getAllWorkflows`,
`getActiveWorkflow`, `getActiveWorkflowId`, `pauseWorkflow`,
`cancelPauseWorkflow`, `resumeWorkflow`, `stopWorkflow`, `readWorkingFile`,
and `getHarnessDetailedStatus` all show zero real callers. The pause/resume/
stop quartet's only repo occurrences are in
`dev/backlog/STANDALONE_SERVER_PLAN.md`'s message-routing table (documenting
`orchestrator.pauseWorkflow(id)` etc. as the intended direct call for the
not-yet-built standalone server) and in `prompts/copilot-integration.prompt.md`
(a demo/example prompt, not source).

This is **scaffolding for an unimplemented plan, not abandoned code** —
`STANDALONE_SERVER_PLAN.md` is still in `dev/backlog/` (not `dev/implemented/`),
and `ServerSection.tsx:338` explicitly says "Phases 5–10 are unimplemented."

**Decision (2026-07-29): retain this near-term standalone-server API.** All 11
methods are marked `@keep` in `WorkflowOrchestrator.ts`, each pointing to
`STANDALONE_SERVER_PLAN.md`, so the dead-method finder excludes them until
that implementation begins. This resolves the audit item; revisit the tags
only if the standalone-server plan is abandoned or its message-routing API
changes materially.

### `NotificationManager.notifyStartupComplete()` — confirmed no-op

```ts
notifyStartupComplete(): void {}
```

Empty body, zero callers. The real implementation is
`DashboardBroadcastHub.notifyStartupComplete()` (`src/ui/DashboardBroadcastHub.ts:115`),
which **is** called, from `WorkflowOrchestrator.ts:1470`. `NotificationManager`
implements `DashboardClient` (`IDashboardProvider & Partial<IDashboardSink>`)
so the interface requires _some_ method with this name to exist, but the
broadcast hub is what actually fans it out — this override is dead weight,
not a missing wire-up. Safe to delete once confirmed nothing depends on it
being present-but-empty (e.g. a mock `implements DashboardClient` check).

### `CtrlYokeWebviewProvider` notify*/send* family

`notifyTerminalStarted`, `notifyTerminalOutput`, `notifyTerminalEnded`,
`notifyQueueExtended`, `notifyQueueSizeLimitReached`,
`notifyExecutionTimeLimitReached`, `sendHistoryUndoData`,
`sendUndoPromptResult`, `getPanelScopedSend` — none of these are part of
`IDashboardSink` (checked directly against `src/types/IDashboardSink.ts`),
so they're not dead interface stubs, they're extra methods beyond the
provider's interface contract. Given `NotificationManager` and
`DashboardBroadcastHub` both exist as newer centralized notification paths,
the likely story is the same as `notifyStartupComplete()` above: these were
the pre-centralization way `CtrlYokeWebviewProvider` pushed messages directly,
superseded by routing through `NotificationManager`/`DashboardBroadcastHub`,
and never deleted. Worth confirming with `git log -p` on
`CtrlYokeWebviewProvider.ts` around when `DashboardBroadcastHub` was
introduced before deleting the whole family at once.

## Sweep 2: half-implemented features (grep sweep)

Searched `src/` for
`not yet (fully )?implemented|not fully implemented|TODO|FIXME|HACK:|stub|placeholder|unimplemented|not currently supported`.
Most of the 74 hits are noise (dictionary words in the spellcheck data file,
`vi.stubGlobal`/`stubDocumentElement` test helpers, `CodeMirror`'s `toDOM()`
lifecycle method, literal `"TODO"` strings used as test fixture content, the
harness log parsers' `todo_list` tool-call handling). The real findings:

1. **`EndConditionHandler.ts:174` — `onPass: "retry"` silently behaves as
   `"continue"`.** This is the highest-priority item in this whole audit: it
   isn't a private implementation detail, it's a **schema-validated,
   autocomplete-advertised option**. `schemas/workflow-schema.json` and
   `PromptPropertyCompletionProvider.ts:171` both tell users `onPass` accepts
   `continue | retry | stopWorkflow`. A user who picks `retry` gets silently
   downgraded to `continue` with only a debug-log line
   (`⚠️ onPass: retry is not yet fully implemented`) — no schema error, no
   visible warning. Either implement real retry-on-pass semantics (the code
   comment says it "requires orchestrator-level loop support") or remove
   `retry` from the schema/completions/types until it's real, so an invalid
   selection fails loudly instead of quietly doing the wrong thing.

2. **`ServerSection.tsx:338`** — already correctly documented as inert
   pending `STANDALONE_SERVER_PLAN.md` Phases 5–10, with the type/schema/
   default deliberately kept for forward compatibility. Not a bug, no action
   needed — included here only because it's the UI-side confirmation of the
   `WorkflowOrchestrator` special case above.

3. **`src/ui/webview-react/components/layout/WorkflowStepsPanel.tsx:647`** —
   `// TODO: End condition results would come from workflow state`. The
   step-details tooltip/panel has a placeholder comment where end-condition
   evaluation results should be populated. Worth a look to confirm the data
   just isn't wired through yet vs. genuinely unavailable at that point in
   the render.

4. **`src/ui/webview-react/components/editor/PromptEditor.tsx:509` and `:531`**
   — `forceNewWorkflow: false, // TODO: Add checkbox for this`.
   `EXECUTE_PROMPT` messages hardcode `forceNewWorkflow: false` at **two**
   call sites (only the second carries the TODO comment); there's no UI to
   ever send `true`. Confirm whether that's an intentional current default
   with the checkbox as future work, or a real gap (i.e. some other code path
   is now unreachable for users who'd want to force a new workflow). If a
   checkbox is added, both sites must be updated together.

5. **`src/server/WebPushService.ts:74`** — cosmetic: a hardcoded placeholder
   support email in the VAPID `vapidSubject` constructor default
   (`mailto:ctrlyoke@example.com`). Not functionally broken, just needs a real
   address before this ships. Requires an owner decision on the address, so it
   is not actionable by an implementing agent.

6. **`ICliProvider.ts:404`** — "Other providers leave this unimplemented
   (returns undefined → treated as [])" is a documented, intentional default
   for an optional hook, not a bug. No action needed; excluded from the plan
   below.

## Plan

**Execution order (revised 2026-07-29 during orchestration).** The phases below
are numbered by topic, not by the order they should be done. Two ordering
corrections were made before staging the work:

1. **Phase 7 (make false positives nominal) runs _first_, before Phase 3's
   `@keep`-tagging.** As originally written the plan tags ~33 false positives
   with `@keep` in Phase 3 and then, in Phase 7, converts those same sites to
   nominal types and removes the tags again — editing the same lines twice and
   leaving `@keep` tags in the tree that were never needed. Doing Phase 7 first
   shrinks the finder's output from 91 candidates to the genuinely suspicious
   ones, which makes every subsequent verification pass cheaper and less noisy.
   Phase 3 then only tags the residue that is provably un-fixable.
2. **Phase 1's ~55 candidates are split into four area-sized chunks** (harness,
   core engine, utils/config/platform/git, UI notification family) rather than
   one pass. Each area shares context and a test surface, and the UI
   notification family needs its own `git log -p` archaeology per the special
   case above.

Baselines established before staging, both at commit `360a36fa`:

- `node scripts/find-dead-methods.mjs` reports **91 candidates**, consistent
  with the 103 documented here minus the 11 `@keep`-tagged
  `WorkflowOrchestrator` methods and the removed `InputCapture.reset()`.
- `npm test` is **fully green** — 2190 passing (extension host) and 103 test
  files / 1236 tests passing (React dashboard). There are no pre-existing
  failures to explain away, so any failure introduced while applying these
  phases is caused by that phase's own changes.

`npm test` is the gate for every phase. Never run `npm run test:harness` — it
makes real paid API calls.

### Phase 1 — delete remaining Bucket A + Bucket B candidates

For each of the remaining 42 extension-side candidates, verify with the same
rigor as `handleExecutionError` — repo-wide search including tests and docs,
confirm the equivalent behavior lives elsewhere if one would expect it to —
then delete the method and any support code/imports/constants that become dead
as a result (mirroring the `looksLikeFilePath`/`SCRIPT_EXTENSIONS` cascade
from the `handleExecutionError` deletion). Run `npm run typecheck`, `npm run
lint`, `npm run knip`, and the relevant test files after each file's edits.
The webview-side `InputCapture` item is already resolved above; its removal
also eliminated the incomplete ad-hoc attribution feature rather than
retaining an inert heuristic.

**Phase 1 progress (2026-07-29, Step 3):** The harness slice handled 12 of the
42 Bucket A/B candidates assigned to Phase 1 (all 12 were deleted). The
core-engine slice handled 12 more Bucket A/B candidates (11 deleted and
`PromptQueue.persistSessionId()` kept because it is reached through the
`WorkflowWorkingFilePersistence` contract), leaving **19 Phase 1 Bucket A/B
candidates** for the remaining area slices. Four additional Bucket C
candidates were deleted as documented above. The utils/config/platform/git
slice in Step 4 deleted nine more Bucket A/B candidates and made the shim
emitter nominal; the kept harness methods and `persistSessionId()` remain
expected false negatives of the heuristic.

### Phase 2 — retain the `WorkflowOrchestrator` standalone-server API (completed 2026-07-29)

The owner confirmed `STANDALONE_SERVER_PLAN.md` is near-term. The 11 methods
listed in the special case are tagged `@keep` with a reference to that plan,
so the dead-method finder no longer reports them. No further action is needed
in this audit until standalone implementation changes the API.

### Phase 3 — verify Bucket C individually, then either delete or `@keep`-tag

**Runs after Phase 7**, which should already have made most of the confirmed
false positives below resolve on their own. Only tag what survives.

Use the language service directly (or the IDE's Find All References) per
candidate, not the grep count — the count only tells you "worth a closer
look," it can't tell you "dead." Confirmed so far:

- Delete: `CommitMessageGenerator.generate()`; `Log.show()`;
  `Log.append()`; `StatusBarManager.hide()`; and
  `StatusBarManager.show()` (all **2026-07-29, Step 4**).
- Made nominal: `vscode-shim.ts` `EventEmitter.fire()` (**2026-07-29,
  Step 4**); live through shim-backed `vscode.EventEmitter` instances in
  `ModelRegistry`.
- Confirmed false positives now made nominally in Phase 7 and needing no
  `@keep`: `CliAdapter.getConfig()`, all three `MockPlatform.getConfig()`
  declarations, the `FakeWebSocket`/`FakeStorage` structural test doubles,
  all 7 CodeMirror `ViewPlugin.fromClass` `update()` methods, and all 13
  webview structural test/runtime mocks (`ResizeObserver`, `MockTerminal`,
  `MockFitAddon`, `WebglAddon`).
- `MockVsCodePlatform.getExtensionContext()` remains a candidate for Step 6:
  its call site intentionally detects the VS Code-only adapter by property
  presence, and adding it to `PlatformAdapter` would violate that contract.
- Everything else in Bucket C: unverified, needs the per-symbol check.

### Phase 4 — fix `onPass: "retry"`

**Decision (2026-07-29): strip `retry` from `onPass` only.** Implementing real
retry-on-pass needs orchestrator-level loop support — a genuine feature, too
large to smuggle into a cleanup audit, and not something to leave half-wired in
the meantime. Removing the option makes an invalid selection fail loudly at
schema-validation time instead of silently downgrading to `continue`.

Scope notes established while making this call:

- `onFail: "retry"` **is** fully implemented and must keep working. Only the
  `onPass` direction is affected.
- `EndConditionAction` (`CtrlYokeTypes.ts:579`) is shared by both `onPass` and
  `onFail`, so `onPass` needs its own narrower type
  (e.g. `EndConditionPassAction = Exclude<EndConditionAction, "retry">`) rather
  than editing `EndConditionAction` itself.
- `schemas/workflow-schema.yaml` is **generated** from
  `schemas/workflow-schema.json` by `npm run generate-schema` — edit the JSON
  and regenerate; never hand-edit the YAML.
- The `endCondition.onPass` enum and description at
  `schemas/workflow-schema.json:539` and the prose at
  `PromptPropertyCompletionProvider.ts:171` both advertise `retry`.
- The schema's current `onPass: retry` description names a real use case
  ("keep implementing backlog items while tests stay green"). Capture that as a
  new `dev/backlog/` doc when removing it so the intent isn't lost — this phase
  removes a broken option, it does not reject the feature.

### Phase 5 — the smaller UI gaps

Triage items 3–5 from Sweep 2 as normal small tickets; none are urgent, none
block anything else in this plan. Item 5 (VAPID support email) needs an owner
decision on the real address and is not actionable by an implementing agent.

### Phase 6 — keep the tool around

`scripts/find-dead-methods.mjs` is a real, working detector for this pattern
now that the interface-exclusion bug is fixed and both the extension and
webview projects are scanned together. It's not wired into `npm run knip` or
CI — false-positive rate is too high for a hard gate without the
`@keep`-tagging from Phase 3 done first, and the anonymous-class blind spot
(framework plugins, `vi.mock`/`vi.stubGlobal` test doubles) means it will
never reach zero false positives no matter how much the heritage-clause check
improves — there's structurally no signal to check for an unnamed class with
no `implements`/`extends`. Once Phase 3's `@keep` tags land, consider adding
an `npm run find-dead-methods` script entry and running it periodically
(alongside `npm run test:coverage`'s zero-coverage scan) rather than gating
merges on it.

### Phase 7 — make the confirmed false positives nominal instead of `@keep`-tagging them (completed 2026-07-29)

Applied all three requested patterns without changing runtime behavior:

- Added optional `getConfig(key, defaultValue: string): string` to
  `PlatformAdapter` and removed the inline cast in `CliIntegration`. This was
  chosen over a separate interface because the existing CLI and test adapters
  already expose the same compatibility hook, while `VsCodeAdapter` can omit
  it.
- Added `Pick<WebSocket, ...>`, `Pick<Storage, ...>`, `Pick<Terminal, ...>`,
  `Pick<FitAddon, ...>`, `Pick<WebglAddon, ...>`, and `implements
ResizeObserver` clauses to the extension and webview test doubles. Mock
  signatures were widened to match the real APIs where the clauses required it.
- Verified `PluginValue` is exported by the installed `@codemirror/view`
  6.43.0 and added `implements PluginValue` to all seven anonymous plugin
  classes.

The finder now reports **56 candidates**, down from the 91-candidate
baseline. All 35 `getConfig`/structural-mock/CodeMirror entries are nominal
and need no `@keep` tag. The one requested site that remains is
`src/test/unit/CliIntegration.test.ts:53`:
`MockVsCodePlatform.getExtensionContext()` is reached through the intentional
VS Code-only property-presence check in `CliIntegration`; it remains for
Step 6 rather than broadening `PlatformAdapter`.
