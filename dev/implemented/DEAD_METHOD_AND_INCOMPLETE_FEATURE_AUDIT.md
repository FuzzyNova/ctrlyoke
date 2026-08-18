# Dead Class-Method & Incomplete-Feature Audit

**Status (2026-07-29):** Audit fixes for Phases 1–7 are **APPLIED**. The
completed dead-method cleanup, nominal-contract pass, and the implemented
`onPass: retry` feature,
manual finder entry, and UI-gap triage leave the finder at **0 candidates**.
The audit is fully applied apart from the explicitly listed open items below:
the owner-supplied VAPID email, the two lost-capability warning routes, and the
deferred UI data/affordance work. The two intentionally retained dashboard
warning endpoints are `@keep`-tagged with their incomplete-protocol reason; the
11 settled `WorkflowOrchestrator` standalone-server tags remain untouched. This
documents the output of two sweeps run after deleting
`EndConditionHandler.handleExecutionError`
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
- [`STANDALONE_SERVER_PLAN.md`](../active/STANDALONE_SERVER_PLAN.md) — several
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
   `Pick<...>` clauses, so those methods now resolve nominally. The previously
   flagged `MockVsCodePlatform.getExtensionContext()` candidate was handled separately:
   it is a VS Code-only method reached through the intentional dynamic
   discriminator in `CliIntegration`, so the test double now declares a
   `Pick<VsCodeAdapter, "getExtensionContext">` heritage entry rather than
   broadening the cross-platform `PlatformAdapter` contract.
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

| Location                                                          | Method                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/harness/shared/interfaces/IToolPermissionMapper.ts:100` | `ToolPermissionMapperBase.matchesAnyPattern()` — **deleted 2026-07-29 (Step 2)**                                                                                                                                                               |
| `src/core/harness/shared/interfaces/IToolPermissionMapper.ts:155` | `ToolPermissionMapperBase.isValidPattern()` — **deleted 2026-07-29 (Step 2)**                                                                                                                                                                  |
| `src/core/harness/shared/interfaces/IToolPermissionMapper.ts:164` | `ToolPermissionMapperBase.normalizeTool()` — **deleted 2026-07-29 (Step 2)**                                                                                                                                                                   |
| `src/utils/AgentExpander.ts:101`                                  | `AgentExpander.getAgentCommandName()` — **deleted 2026-07-29 (Step 4)**; its private frontmatter-name helper became dead and was removed as cascade                                                                                            |
| `src/utils/TempFileManager.ts:48`                                 | `TempFileManager.getTempDir()` — **deleted 2026-07-29 (Step 4)**                                                                                                                                                                               |
| `src/utils/TempFileManager.ts:520`                                | `TempFileManager.getStats()` — **deleted 2026-07-29 (Step 4)**                                                                                                                                                                                 |
| `src/core/HarnessIntegration.ts:612`                              | `HarnessIntegration.buildPriorContextXml()` — **deleted 2026-07-29 (Step 3)**; live code uses `buildPriorContextXmlFromItems()` and its module-level serializer                                                                                |
| `src/core/HarnessIntegration.ts:616`                              | `HarnessIntegration.stripAnsiCodes()` — **deleted 2026-07-29 (Step 3)**; live code calls the module-level sanitizer                                                                                                                            |
| `src/core/HarnessIntegration.ts:820`                              | `HarnessIntegration.updateWorkflowProgress()` — **deleted 2026-07-29 (Step 3)**; no caller or status-bar contract exists                                                                                                                       |
| `src/core/HarnessIntegration.ts:945`                              | `HarnessIntegration.testAutomation()` — **deleted 2026-07-29 (Step 3)**; no caller or diagnostic contract exists                                                                                                                               |
| `src/core/harness/shared/HeadlessLogTail.ts:148`                  | `HeadlessLogTail.handleStdout()` — **deleted 2026-07-29 (Step 2)**                                                                                                                                                                             |
| `src/core/harness/copilot/CopilotToolBuilder.ts:94`               | `CopilotToolBuilder.buildInitiatedEvent()` — **deleted 2026-07-29 (Step 2)**                                                                                                                                                                   |
| `src/core/harness/shared/SettingsJsonMcpTracker.ts:501`           | `SettingsJsonMcpTracker.hasActiveManagedServers()` — **deleted 2026-07-29 (Step 2)**                                                                                                                                                           |
| `src/core/harness/shared/SettingsJsonMcpTracker.ts:506`           | `SettingsJsonMcpTracker.getBaselineServerNames()` — **deleted 2026-07-29 (Step 2)**                                                                                                                                                            |
| `src/core/harness/qwen/QwenCliProvider.ts:518`                    | `QwenCliProvider.getAvailableModels()` — **deleted 2026-07-29 (Step 2)**                                                                                                                                                                       |
| `src/core/orchestration/TimelineRecorder.ts:33`                   | `TimelineRecorder.isRunEntry()` — **deleted 2026-07-29 (Step 3)**; run-directory filtering uses `WorkflowPaths` directly, with its two legacy filename helpers removed as cascade                                                              |
| `src/core/orchestration/TimelineRecorder.ts:48`                   | `TimelineRecorder.extractRunTimestamp()` — **deleted 2026-07-29 (Step 3)**; run ordering uses lineage/run metadata rather than this legacy parser                                                                                              |
| `src/core/WorkflowStateMachine.ts:78`                             | `WorkflowStateMachine.executionEndTime()` — **deleted 2026-07-29 (Step 3)**; timing consumers use `getSnapshot()` and persisted runtime state                                                                                                  |
| `src/core/PromptQueue.ts:945`                                     | `PromptQueue.reloadAndMergeQueue()` — **deleted 2026-07-29 (Step 3)**; dynamic queue merging now runs through `WorkingFileManager.mergeDiskSteps()` during reload/write paths                                                                  |
| `src/utils/WorkspaceSnapshotService.ts:1181`                      | `WorkspaceSnapshotService.hashCurrentFile()` — **deleted 2026-07-29 (Step 4)**; snapshot reads remain shared by capture/enrichment paths                                                                                                       |
| `src/config/FileConfigBackend.ts:44`                              | `FileConfigBackend.startWatching()` — **deleted 2026-07-29 (Step 4)**; no startup caller or `ConfigBackend` contract uses file watching                                                                                                        |
| `src/config/FileConfigBackend.ts:73`                              | `FileConfigBackend.stopWatching()` — **deleted 2026-07-29 (Step 4)**; watcher state/imports and unused factory callbacks removed as cascade                                                                                                    |
| `src/completions/PromptCompletionProvider.ts:462`                 | `PromptCompletionProvider.clearCache()` — **deleted 2026-07-29 (Step 4)**; the shared `clearFilesCache()` remains owned by `CompletionHelpers`                                                                                                 |
| `src/utils/HarnessFileManager.ts:530`                             | `HarnessFileManager.syncToHarnesses()` — **deleted 2026-07-29 (Step 4)**; `SyncResult` and its error-formatting import were dead with it                                                                                                       |
| `src/core/orchestration/HistorySearchService.ts:79`               | `HistorySearchService.enqueueIndexRefresh()` — **deleted 2026-07-29 (Step 3)**; `OutputHistoryManager` owns direct index refresh scheduling                                                                                                    |
| `src/ui/CtrlYokeWebviewProvider.ts:641`                           | `CtrlYokeWebviewProvider.notifyTerminalStarted()` — **deleted 2026-07-29 (Step 5)**; terminal messages use `ptyPostMessage`, workflow-instance sends, and per-client replay                                                                    |
| `src/ui/CtrlYokeWebviewProvider.ts:657`                           | `CtrlYokeWebviewProvider.notifyTerminalOutput()` — **deleted 2026-07-29 (Step 5)**; terminal output uses `ptyPostMessage` and replay buffers                                                                                                   |
| `src/ui/CtrlYokeWebviewProvider.ts:671`                           | `CtrlYokeWebviewProvider.notifyTerminalEnded()` — **deleted 2026-07-29 (Step 5)**; PTY exit callbacks use `ptyPostMessage`                                                                                                                     |
| `src/ui/CtrlYokeWebviewProvider.ts:686`                           | `CtrlYokeWebviewProvider.notifyQueueExtended()` — **deleted 2026-07-29 (Step 5)**; `STEPS_EXTENDED` is the current sink route and the orphaned `QUEUE_EXTENDED` constant was removed                                                           |
| `src/ui/CtrlYokeWebviewProvider.ts:719`                           | `CtrlYokeWebviewProvider.notifyQueueSizeLimitReached()` — **`@keep`-tagged 2026-07-29 (Step 6)**; the webview warning receiver (`useMessageHandler.ts:2074`) is a future protocol endpoint and no sender route exists for the checker to trace |
| `src/ui/CtrlYokeWebviewProvider.ts:731`                           | `CtrlYokeWebviewProvider.notifyExecutionTimeLimitReached()` — **`@keep`-tagged 2026-07-29 (Step 6)**; the webview warning receiver is a future protocol endpoint and no sender route exists for the checker to trace                           |
| `src/ui/CtrlYokeWebviewProvider.ts:896`                           | `CtrlYokeWebviewProvider.sendHistoryUndoData()` — **deleted 2026-07-29 (Step 5)**; `OUTPUT_HISTORY_LOADED` now carries replayed history                                                                                                        |
| `src/ui/CtrlYokeWebviewProvider.ts:928`                           | `CtrlYokeWebviewProvider.sendUndoPromptResult()` — **deleted 2026-07-29 (Step 5)**; `UndoRedoCoordinator` emits the result through the client-scoped router                                                                                    |
| `src/core/WorkflowOrchestrator.ts:440`                            | `WorkflowOrchestrator.addDashboardProvider()` — see special case                                                                                                                                                                               |
| `src/core/WorkflowOrchestrator.ts:444`                            | `WorkflowOrchestrator.removeDashboardProvider()` — see special case                                                                                                                                                                            |
| `src/core/WorkflowOrchestrator.ts:623`                            | `WorkflowOrchestrator.getAllWorkflows()` — see special case                                                                                                                                                                                    |
| `src/core/WorkflowOrchestrator.ts:647`                            | `WorkflowOrchestrator.getActiveWorkflowId()` — see special case                                                                                                                                                                                |
| `src/core/WorkflowOrchestrator.ts:1649`                           | `WorkflowOrchestrator.cancelPauseWorkflow()` — see special case                                                                                                                                                                                |
| `src/core/WorkflowOrchestrator.ts:4297`                           | `WorkflowOrchestrator.getHarnessDetailedStatus()` — see special case                                                                                                                                                                           |

### Bucket B — 1–3 occurrences, none of them real call sites (14 candidates)

The occurrences that exist are in `dev/backlog/*.md`, `prompts/*.md`, or
test/mock declarations of the _same_ dead method (i.e. the declaration line
itself in a differently-named sibling file) — not a production caller. Still
worth an individual look since 1–3 is a small enough number to just read.

| Location                                             | Method                                                                                       | Where the occurrence(s) are                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/harness/claude/ClaudeLogParser.ts:127`     | `setWorkspaceRoot()` — **made nominal 2026-07-29 (Step 6)**                                  | `ILogParser` now owns the optional hook; `CliIntegration` calls that typed contract directly                                            |
| `src/core/harness/qwen/QwenLogParser.ts:158`         | `setWorkspaceRoot()` — **made nominal 2026-07-29 (Step 6)**                                  | `ILogParser` now owns the optional hook; `CliIntegration` calls that typed contract directly                                            |
| `src/core/harness/opencode/OpenCodeLogParser.ts:539` | `getLogDirectory()` — **deleted 2026-07-29 (Step 2)**                                        | No caller; OpenCode uses the session ID as its export path                                                                              |
| `src/core/PromptQueue.ts:733`                        | `getWorkflowName()` — **deleted 2026-07-29 (Step 3)**                                        | Queue consumers use `getState().workflowName`; the working-file adapter already captures state directly                                 |
| `src/core/PromptQueue.ts:885`                        | `persistSessionId()` — **made nominal 2026-07-29 (Step 6)**                                  | `PromptQueue` now explicitly implements `WorkflowWorkingFilePersistence`, the contract passed by `WorkflowExecutor`                     |
| `src/ui/StatusBarManager.ts:153`                     | `hide()` — **deleted 2026-07-29 (Step 4)**; status updates call the underlying item directly |
| `src/core/TemplateManager.ts:767`                    | `setDefaultTemplateId()` — **deleted 2026-07-29 (Step 3)**                                   | The active UI route persists through `ConfigurationUtils.setDefaultWorkflowTemplate()` directly                                         |
| `src/core/harness/shared/HeadlessLogTail.ts:179`     | `getLogPath()` — **deleted 2026-07-29 (Step 2)**                                             | The result exposes `logPath` directly; no method caller existed                                                                         |
| `src/ui/CtrlYokeWebviewProvider.ts:1337`             | `getPanelScopedSend()`                                                                       | **deleted 2026-07-29 (Step 5)**; no callers remained after client-scoped router wiring                                                  |
| `src/ui/NotificationManager.ts:65`                   | `notifyStartupComplete()`                                                                    | **deleted 2026-07-29 (Step 5)**; see special case                                                                                       |
| `src/test/unit/CliIntegration.test.ts:53`            | `MockVsCodePlatform.getExtensionContext()` — **made nominal 2026-07-29 (Step 6)**            | The test double explicitly implements `Pick<VsCodeAdapter, "getExtensionContext">`, matching the intentional VS Code-only discriminator |
| `src/core/WorkflowOrchestrator.ts:637`               | `getActiveWorkflow()`                                                                        | `dev/active/STANDALONE_SERVER_PLAN.md` — see special case                                                                               |
| `src/core/WorkflowOrchestrator.ts:1634`              | `pauseWorkflow()`                                                                            | `dev/active/STANDALONE_SERVER_PLAN.md`, `prompts/copilot-integration.prompt.md` — see special case                                      |
| `src/core/WorkflowOrchestrator.ts:1669`              | `resumeWorkflow()`                                                                           | `dev/active/STANDALONE_SERVER_PLAN.md` — see special case                                                                               |
| `src/core/WorkflowOrchestrator.ts:1717`              | `stopWorkflow()`                                                                             | `dev/active/STANDALONE_SERVER_PLAN.md`, `prompts/copilot-integration.prompt.md` — see special case                                      |

### Bucket C — 4+ occurrences, name too common to trust the count (29 candidates)

These need a real per-symbol check (IDE "Find All References" on the exact
declaration, or `service.findReferences` in the script) — the aggregate text
count mixes in unrelated classes with the same method name. Two false-positive
patterns from the "known false-positive sources" section above account for
most of this bucket:

- **Duck-typed cast (`getConfig`, count 7):** `CliAdapter.getConfig()`,
  `MockPlatform.getConfig()` (×3, one per test file), and
  `MockHarness`'s `MockPlatform.getConfig()` were made nominal in Phase 7 by
  adding the optional hook to `PlatformAdapter` and removing the cast from
  `CliIntegration`.
- **Structural test doubles (`addEventListener`/`send`/`close`/`setItem`,
  counts 9–101):** `FakeWebSocket` and `FakeStorage` now explicitly declare
  the `Pick<...>` contracts they satisfy, so their live test calls are
  nominally visible to the finder.

One item in this bucket was manually verified as a **real dead method**
despite the noisy count:

- `src/git/CommitMessageGenerator.ts:371` — `CommitMessageGenerator.generate()`
  (count 6, all unrelated) — **deleted 2026-07-29 (Step 4)**. The class's
  real entry point remains `generateMessage()`, used by `cli.ts`,
  `ScmCommitCommand.ts`, and `HostedWorkspaceViewerService.ts`; `generate()`
  was only an orphaned forwarding wrapper.

All Bucket C items are now resolved: the dead methods were deleted, the
confirmed structural relationships were made nominal, and the two retained
dashboard warning endpoints were tagged with explicit reasons.

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
`CliTransportCoordinator.writeToCurrentPtySession()` — **made nominal 2026-07-29
(Step 6)** because `CliExecutionRunner` calls it through the exported transport
contract for inject mode;
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
need no `@keep` tags. `MockVsCodePlatform.getExtensionContext()` is also
nominal: its test double declares the VS Code-only heritage contract while
the production discriminator remains intentionally dynamic.

## Special cases worth reading before touching anything

### `WorkflowOrchestrator` pause/resume/stop/dashboard/status family

`addDashboardProvider`, `removeDashboardProvider`, `getAllWorkflows`,
`getActiveWorkflow`, `getActiveWorkflowId`, `pauseWorkflow`,
`cancelPauseWorkflow`, `resumeWorkflow`, `stopWorkflow`, `readWorkingFile`,
and `getHarnessDetailedStatus` all show zero real callers. The pause/resume/
stop quartet's only repo occurrences are in
`dev/active/STANDALONE_SERVER_PLAN.md`'s message-routing table (documenting
`orchestrator.pauseWorkflow(id)` etc. as the intended direct call for the
not-yet-built standalone server) and in `prompts/copilot-integration.prompt.md`
(a demo/example prompt, not source).

This is **scaffolding for an unimplemented plan, not abandoned code** —
`STANDALONE_SERVER_PLAN.md` is still in `dev/active/` (not `dev/implemented/`),
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
so the sink half does not require this optional member. A repository search
found no `implements DashboardClient` mock or other existence check; the only
startup test double supplies `notifyStartupComplete` on its private hub stub,
not on a `DashboardClient`. The override was deleted in Step 5 and
`npm run typecheck` proved the contract remains satisfied.

### `CtrlYokeWebviewProvider` notify*/send* family

`notifyTerminalStarted`, `notifyTerminalOutput`, `notifyTerminalEnded`,
`notifyQueueExtended`, `notifyQueueSizeLimitReached`,
`notifyExecutionTimeLimitReached`, `sendHistoryUndoData`,
`sendUndoPromptResult`, `getPanelScopedSend` — none of these are part of
`IDashboardSink` (checked directly against `src/types/IDashboardSink.ts`),
so they were extra methods beyond the provider's interface contract. The
archaeology was conclusive: `git log -p --follow` identifies commit
`3c41b2f8` ("Refactor dashboard communication by introducing
DashboardBroadcastHub") as the centralization point. The terminal trio was
superseded by `ptyPostMessage`, direct `WorkflowInstance` PTY sends, and
`WorkflowOrchestrator.replayTerminalSessionsTo()`; the React terminal client
still receives `TERMINAL_STARTED`, `TERMINAL_OUTPUT`, and `TERMINAL_ENDED` from
those routes. This remains consistent with the preceding
`360a36fa` terminal-input-capture removal.

`notifyQueueExtended` was superseded by the typed `STEPS_EXTENDED` sink path
used by `PromptFileLoader` and CLI-watch routing. Its old `QUEUE_EXTENDED`
constant had no receiver and was removed. `sendHistoryUndoData` was made
obsolete when history replay moved to `OUTPUT_HISTORY_LOADED`; undo result and
record messages are now emitted by `UndoRedoCoordinator` via the router's
client-scoped `postMessage`. `getPanelScopedSend` had no callers after that
router migration and was removed with the dead helpers/imports.

Two findings are intentionally retained rather than silently deleted:
`notifyQueueSizeLimitReached` and `notifyExecutionTimeLimitReached`. React
still has handlers for both messages, but repository-wide tracing found no
current sender and no equivalent dashboard route. The core currently warns
through the platform/log and transitions execution to failed/stopped state;
it does not publish the corresponding live-history warning payload. The
methods and their shared constants/receivers therefore remain as an explicit
lost-capability finding for a future feature fix. They are now retained by
reasoned `@keep` tags, and the final finder reports **0 candidates**.

## Sweep 2: half-implemented features (grep sweep)

Searched `src/` for
`not yet (fully )?implemented|not fully implemented|TODO|FIXME|HACK:|stub|placeholder|unimplemented|not currently supported`.
Most of the 74 hits are noise (dictionary words in the spellcheck data file,
`vi.stubGlobal`/`stubDocumentElement` test helpers, `CodeMirror`'s `toDOM()`
lifecycle method, literal `"TODO"` strings used as test fixture content, the
harness log parsers' `todo_list` tool-call handling). The real findings:

1. **Resolved in Phase 4, implemented in the follow-up plan:**
   `EndConditionHandler.ts` no longer silently downgrades `onPass: "retry"` to
   `"continue"`. The temporary removal from the `onPass` type, schema, and
   completions was reversed on 2026-07-29, and the feature is now implemented
   with parser coverage and shared pass/fail retry handling. See
   [`END_CONDITION_PASS_RETRY_PLAN.md`](END_CONDITION_PASS_RETRY_PLAN.md).

2. **`ServerSection.tsx:338`** — already correctly documented as inert
   pending `STANDALONE_SERVER_PLAN.md` Phases 5–10, with the type/schema/
   default deliberately kept for forward compatibility. Not a bug, no action
   needed — included here only because it's the UI-side confirmation of the
   `WorkflowOrchestrator` special case above.

3. **`src/ui/webview-react/components/layout/WorkflowStepsPanel.tsx:647`** —
   **Deferred: data is not available in this render.** The component receives
   each step's `_runtime`, but the webview runtime type has no end-condition
   result. The executor sends the evaluation result on the
   `STEP_STATUS_CHANGED` status payload, while `useMessageHandler` only merges
   that message's `details` into `_runtime`; the result is therefore not
   present in the step object used by `getStepDetails`. The source comment now
   names this missing message/runtime contract instead of promising a local
   implementation.

4. **`src/ui/webview-react/components/editor/PromptEditor.tsx:513` and `:539`**
   — **Deferred UI affordance.** Both `EXECUTE_PROMPT` call sites intentionally
   send `forceNewWorkflow: false`, and repository-wide search found no caller
   that sends `true`. The receiving behavior is real and useful: the
   extension-side handler passes the flag through, the orchestrator bypasses
   addressed-run routing, and `WorkflowInstance` clears the current workflow
   before initializing the submitted step. No checkbox was added because that
   destructive action needs a deliberate, tested UI design; both source sites
   now document the finding rather than carrying a bare TODO.

5. **`src/server/WebPushService.ts:74`** — **OPEN: owner decision required.**
   The hardcoded placeholder support email in the VAPID `vapidSubject`
   constructor default (`mailto:ctrlyoke@example.com`) is intentionally left
   unchanged. It needs the real owner-approved address before shipping; an
   implementing agent must not invent one.

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

### Phase 1 — delete remaining Bucket A + Bucket B candidates (completed 2026-07-29)

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
expected contract-backed false positives; Step 6 made those relationships
nominal.

**Phase 1 progress (2026-07-29, Step 5):** The UI notification slice removed
`NotificationManager.notifyStartupComplete()`, the terminal trio, the old
queue-extension sender, the obsolete history-undo replay method and its dead
undo-record helper, the obsolete undo-result sender, and
`getPanelScopedSend()`. The two queue-limit methods remain as explicit
lost-capability findings because their React receivers have no current sender
or replacement route. The `QUEUE_EXTENDED` constant was removed because it
had neither a sender nor receiver. The final finder count is recorded below
after the Step 6 nominal-contract pass.

**Phase 1 completion (2026-07-29, Step 6):** Every Phase 1 candidate is now
resolved. The two intentionally retained queue-limit endpoints are tagged as
future protocol surfaces; all other verified-dead methods were deleted or
made nominal. `CommitMessageGenerator.generate()` is gone, as required.

### Phase 2 — retain the `WorkflowOrchestrator` standalone-server API (completed 2026-07-29)

The owner confirmed `STANDALONE_SERVER_PLAN.md` is near-term. The 11 methods
listed in the special case are tagged `@keep` with a reference to that plan,
so the dead-method finder no longer reports them. No further action is needed
in this audit until standalone implementation changes the API.

### Phase 3 — verify Bucket C individually, then either delete or `@keep`-tag (completed 2026-07-29)

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
- `CliTransportCoordinator.writeToCurrentPtySession()`, both
  `setWorkspaceRoot()` implementations, `PromptQueue.persistSessionId()`, and
  `MockVsCodePlatform.getExtensionContext()` were made nominal using explicit
  shared/heritage contracts.
- The two dashboard warning methods were `@keep`-tagged because their live
  webview receivers preserve a future protocol endpoint while no sender route
  currently exists for the checker to trace.
- The finder reports **0 candidates** after this resolution pass.

### Phase 4 — fix `onPass: "retry"` (completed 2026-07-29)

**Decision (2026-07-29): the temporary removal of `retry` from `onPass` was
reversed.** The cleanup audit initially stripped the option because real
retry-on-pass needed orchestrator-level loop support. That support was then
implemented and shipped through [`END_CONDITION_PASS_RETRY_PLAN.md`](END_CONDITION_PASS_RETRY_PLAN.md), so `onPass: "retry"` is now a supported,
validated workflow action.

Scope notes established while making this call:

- `onFail: "retry"` **is** fully implemented and must keep working. The
  follow-up plan added the corresponding retry behavior for `onPass`.
- `EndConditionAction` (`src/types/CtrlYokeTypes.ts`) is shared by both `onPass` and
  `onFail`; the implemented feature keeps `retry` available in that shared
  action union while `preCondition` and `scriptStep` continue to use their
  narrower action types.
- `schemas/workflow-schema.yaml` is **generated** from
  `schemas/workflow-schema.json` by `npm run generate-schema` — edit the JSON
  and regenerate; never hand-edit the YAML.
- The `endCondition.onPass` enum and description in
  `schemas/workflow-schema.json`, and the prose in
  `PromptPropertyCompletionProvider.ts`, now advertise the implemented
  `retry` action.
- The former schema use case ("keep implementing backlog items while tests
  stay green") is preserved by the shipped implementation and documented in
  [`END_CONDITION_PASS_RETRY_PLAN.md`](END_CONDITION_PASS_RETRY_PLAN.md).

**Landed:** the temporary narrower `onPass` restriction was removed;
the generated JSON/YAML schemas, validation, completions, dashboard editor, and
runtime all support `onPass: "retry"`. Pass retries share the step's retry
budget, re-evaluate the condition, and route a later failure through `onFail`.
The implementation and its coverage are recorded in
[`END_CONDITION_PASS_RETRY_PLAN.md`](END_CONDITION_PASS_RETRY_PLAN.md).

### Phase 5 — the smaller UI gaps (completed 2026-07-29)

Sweep 2 items 3–5 were diagnosed and recorded. Item 3 is deferred because
the end-condition result is sent in the status payload but is not present in
the step `_runtime` consumed by `WorkflowStepsPanel`; the source comment names
the required message/runtime contract extension. Item 4 is deferred because
the backend `forceNewWorkflow` behavior is live but no UI caller sends `true`;
both editor call sites retain the intentional `false` default and now explain
the missing affordance. Item 5 remains open for the owner-approved VAPID
support address and was left unchanged. Sweep 2 items 2 and 6 remain
intentional and required no action.

### Phase 6 — keep the tool around (completed 2026-07-29)

`scripts/find-dead-methods.mjs` is a real, working detector for this pattern
now that the interface-exclusion bug is fixed and both the extension and
webview projects are scanned together. It's not wired into `npm run knip` or
CI — false-positive rate is too high for a hard gate without the
`@keep`-tagging from Phase 3 done first, and the anonymous-class blind spot
(framework plugins, `vi.mock`/`vi.stubGlobal` test doubles) means it will
never reach zero false positives no matter how much the heritage-clause check
improves — there's structurally no signal to check for an unnamed class with
no `implements`/`extends`. The tool is now exposed as
`npm run find-dead-methods`. It remains a manual
periodic check and is not wired into `knip`, `pretest`, `npm test`, or CI.

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

The Phase 7 intermediate finder reported **56 candidates**, down from the
91-candidate baseline. All 35 `getConfig`/structural-mock/CodeMirror entries
were nominal and needed no `@keep` tag. The final Step 6 pass also made the
transport, parser, persistence, and VS Code-only test-double contracts
nominal, leaving only the two explicitly tagged future warning endpoints;
the final finder count is **0 candidates**.

## Open items after close-out

- **VAPID support email:** `src/server/WebPushService.ts` still uses
  `mailto:ctrlyoke@example.com` until an owner supplies the real address.
- **Lost-capability warning routes:** `notifyQueueSizeLimitReached` and
  `notifyExecutionTimeLimitReached` remain `@keep`-tagged because the React
  receivers have no current sender or replacement route. Restore the live
  history warning protocol when the corresponding feature is implemented.
- **End-condition result display:** Extend the `STEP_STATUS_CHANGED` /
  `_runtime` contract so the evaluation result reaches the step object before
  wiring the existing `StepDetails.endConditionResult` renderer.
- **Force-new-workflow UI:** Design and test an explicit editor affordance for
  the destructive `forceNewWorkflow: true` path, then wire both editor
  submission sites together.

Final close-out check: `node scripts/find-dead-methods.mjs` scanned 752 files
and 1,717 class-method candidates on 2026-07-29 and reported **0 candidates**.
The remaining known residue is the two intentionally `@keep`-tagged dashboard
warning endpoints and the 11 intentional standalone-server API tags; there are
no untagged finder candidates.
