# Dead Class-Method & Incomplete-Feature Audit

**Status (2026-07-29):** Audit complete, fixes not yet applied. This documents
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
globals) precisely so a method that's only called from the *other* project's
files still shows up as referenced. No dependency install was needed —
`@types/react` was already present.

**Known false-positive sources** (confirmed while triaging this run's
output — see "Bucket C" below):

1. **Duck-typed structural casts.** `CliIntegration.ts:229` does
   `this.platform as unknown as { getConfig?: ... }` and calls through that
   inline type instead of the real `PlatformAdapter` type. The language
   service can't connect that call site back to `CliAdapter.getConfig` or the
   `MockPlatform.getConfig` test doubles, so all of them read as dead when
   they're genuinely load-bearing.
2. **Structural (non-`implements`) interface satisfaction.** Test doubles like
   `FakeWebSocket`/`FakeStorage` in `src/test/unit/StandaloneShim*.test.ts`
   satisfy a parameter type by shape, without an `implements` clause. The
   script only excludes interface members when the class has an explicit
   `implements X` heritage clause naming an interface/type that declares the
   member (this **is** handled correctly now — see next point — but classes
   with no heritage clause at all can't be excluded this way).
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
5. **Anonymous framework-plugin classes and structural runtime mocks with no
   heritage clause at all.** This one is **not mechanically fixable** by the
   heritage-clause check, because there's no heritage clause to inspect:
   - CodeMirror's `ViewPlugin.fromClass(class { update(update) {...} ... })`
     pattern (7 hits in `CodeMirrorEditor.tsx` and `WorkspaceFileEditor.tsx`)
     — CodeMirror calls `update()` on the instance it constructs; the class
     literal never declares what it implements.
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
reference invisible to *both* tools at once, not just one. Text search still
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

2. **Give test doubles an `implements` clause for *every* type they stand
   in for, not just the narrowest one.** `FakeWebSocket implements FakeSocket`
   in `HostedStandaloneShimScript.test.ts` looks like it should have
   prevented the `addEventListener`/`send`/`close` false positives, but
   `FakeSocket` is a narrow local interface that doesn't declare those
   methods — `FakeWebSocket` is *also* structurally standing in for
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
   the dispatch site so at least the *set* of valid targets is checked, even
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

Strongest signal: not found via symbolic reference *or* as plain text,
including in docs, prompts, and templates. Still verify each one the way
`handleExecutionError` was verified — this narrows the search, it doesn't
replace it.

| Location | Method |
| --- | --- |
| `src/core/harness/shared/interfaces/IToolPermissionMapper.ts:100` | `ToolPermissionMapperBase.matchesAnyPattern()` |
| `src/core/harness/shared/interfaces/IToolPermissionMapper.ts:155` | `ToolPermissionMapperBase.isValidPattern()` |
| `src/core/harness/shared/interfaces/IToolPermissionMapper.ts:164` | `ToolPermissionMapperBase.normalizeTool()` |
| `src/utils/AgentExpander.ts:101` | `AgentExpander.getAgentCommandName()` |
| `src/utils/TempFileManager.ts:48` | `TempFileManager.getTempDir()` |
| `src/utils/TempFileManager.ts:520` | `TempFileManager.getStats()` |
| `src/core/HarnessIntegration.ts:612` | `HarnessIntegration.buildPriorContextXml()` |
| `src/core/HarnessIntegration.ts:616` | `HarnessIntegration.stripAnsiCodes()` |
| `src/core/HarnessIntegration.ts:820` | `HarnessIntegration.updateWorkflowProgress()` |
| `src/core/HarnessIntegration.ts:945` | `HarnessIntegration.testAutomation()` |
| `src/core/harness/shared/HeadlessLogTail.ts:148` | `HeadlessLogTail.handleStdout()` |
| `src/core/harness/copilot/CopilotToolBuilder.ts:94` | `CopilotToolBuilder.buildInitiatedEvent()` |
| `src/core/harness/shared/SettingsJsonMcpTracker.ts:501` | `SettingsJsonMcpTracker.hasActiveManagedServers()` |
| `src/core/harness/shared/SettingsJsonMcpTracker.ts:506` | `SettingsJsonMcpTracker.getBaselineServerNames()` |
| `src/core/harness/qwen/QwenCliProvider.ts:518` | `QwenCliProvider.getAvailableModels()` |
| `src/core/orchestration/TimelineRecorder.ts:33` | `TimelineRecorder.isRunEntry()` |
| `src/core/orchestration/TimelineRecorder.ts:48` | `TimelineRecorder.extractRunTimestamp()` |
| `src/core/WorkflowStateMachine.ts:78` | `WorkflowStateMachine.executionEndTime()` |
| `src/core/PromptQueue.ts:945` | `PromptQueue.reloadAndMergeQueue()` |
| `src/utils/WorkspaceSnapshotService.ts:1181` | `WorkspaceSnapshotService.hashCurrentFile()` |
| `src/config/FileConfigBackend.ts:44` | `FileConfigBackend.startWatching()` |
| `src/config/FileConfigBackend.ts:73` | `FileConfigBackend.stopWatching()` |
| `src/completions/PromptCompletionProvider.ts:462` | `PromptCompletionProvider.clearCache()` |
| `src/utils/HarnessFileManager.ts:530` | `HarnessFileManager.syncToHarnesses()` |
| `src/core/orchestration/HistorySearchService.ts:79` | `HistorySearchService.enqueueIndexRefresh()` |
| `src/ui/CtrlYokeWebviewProvider.ts:641` | `CtrlYokeWebviewProvider.notifyTerminalStarted()` |
| `src/ui/CtrlYokeWebviewProvider.ts:657` | `CtrlYokeWebviewProvider.notifyTerminalOutput()` |
| `src/ui/CtrlYokeWebviewProvider.ts:671` | `CtrlYokeWebviewProvider.notifyTerminalEnded()` |
| `src/ui/CtrlYokeWebviewProvider.ts:686` | `CtrlYokeWebviewProvider.notifyQueueExtended()` |
| `src/ui/CtrlYokeWebviewProvider.ts:785` | `CtrlYokeWebviewProvider.notifyQueueSizeLimitReached()` |
| `src/ui/CtrlYokeWebviewProvider.ts:796` | `CtrlYokeWebviewProvider.notifyExecutionTimeLimitReached()` |
| `src/ui/CtrlYokeWebviewProvider.ts:896` | `CtrlYokeWebviewProvider.sendHistoryUndoData()` |
| `src/ui/CtrlYokeWebviewProvider.ts:928` | `CtrlYokeWebviewProvider.sendUndoPromptResult()` |
| `src/core/WorkflowOrchestrator.ts:440` | `WorkflowOrchestrator.addDashboardProvider()` — see special case |
| `src/core/WorkflowOrchestrator.ts:444` | `WorkflowOrchestrator.removeDashboardProvider()` — see special case |
| `src/core/WorkflowOrchestrator.ts:623` | `WorkflowOrchestrator.getAllWorkflows()` — see special case |
| `src/core/WorkflowOrchestrator.ts:647` | `WorkflowOrchestrator.getActiveWorkflowId()` — see special case |
| `src/core/WorkflowOrchestrator.ts:1649` | `WorkflowOrchestrator.cancelPauseWorkflow()` — see special case |
| `src/core/WorkflowOrchestrator.ts:4297` | `WorkflowOrchestrator.getHarnessDetailedStatus()` — see special case |

### Bucket B — 1–3 occurrences, none of them real call sites (14 candidates)

The occurrences that exist are in `dev/backlog/*.md`, `prompts/*.md`, or
test/mock declarations of the *same* dead method (i.e. the declaration line
itself in a differently-named sibling file) — not a production caller. Still
worth an individual look since 1–3 is a small enough number to just read.

| Location | Method | Where the occurrence(s) are |
| --- | --- | --- |
| `src/core/harness/claude/ClaudeLogParser.ts:127` | `setWorkspaceRoot()` | shared count with `QwenLogParser` below |
| `src/core/harness/qwen/QwenLogParser.ts:158` | `setWorkspaceRoot()` | shared count with `ClaudeLogParser` above |
| `src/core/harness/opencode/OpenCodeLogParser.ts:539` | `getLogDirectory()` | — |
| `src/core/PromptQueue.ts:733` | `getWorkflowName()` | — |
| `src/core/PromptQueue.ts:893` | `persistSessionId()` | — |
| `src/ui/StatusBarManager.ts:153` | `hide()` | — |
| `src/core/TemplateManager.ts:767` | `setDefaultTemplateId()` | — |
| `src/core/harness/shared/HeadlessLogTail.ts:179` | `getLogPath()` | — |
| `src/ui/CtrlYokeWebviewProvider.ts:1337` | `getPanelScopedSend()` | — |
| `src/ui/NotificationManager.ts:65` | `notifyStartupComplete()` | **confirmed true positive** — see special case |
| `src/test/unit/CliIntegration.test.ts:53` | `MockVsCodePlatform.getExtensionContext()` | — |
| `src/core/WorkflowOrchestrator.ts:637` | `getActiveWorkflow()` | `dev/backlog/STANDALONE_SERVER_PLAN.md` — see special case |
| `src/core/WorkflowOrchestrator.ts:1634` | `pauseWorkflow()` | `dev/backlog/STANDALONE_SERVER_PLAN.md`, `prompts/copilot-integration.prompt.md` — see special case |
| `src/core/WorkflowOrchestrator.ts:1669` | `resumeWorkflow()` | `dev/backlog/STANDALONE_SERVER_PLAN.md` — see special case |
| `src/core/WorkflowOrchestrator.ts:1717` | `stopWorkflow()` | `dev/backlog/STANDALONE_SERVER_PLAN.md`, `prompts/copilot-integration.prompt.md` — see special case |

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
  (count 6, all unrelated). The class also has `generateMessage()` at line
  148, which is what every real caller (`cli.ts`, `ScmCommitCommand.ts`,
  `HostedWorkspaceViewerService.ts`) actually uses.  `generate()` just calls
  `this.generateMessage(...)` internally and has no callers of its own — an
  orphaned second entry point. Delete it.

Everything else in this bucket still needs a one-by-one check:
`vscode-shim.ts` `EventEmitter.fire()` (46), `Log.show()`/`StatusBarManager.show()`
(10, shared name), `Log.append()` (4), `HarnessIntegration.resolveWorkspacePath()`
(5), `CliTransportCoordinator.writeToCurrentPtySession()` (4),
`CliNotificationMonitor.monitorForCompletion()` (11),
`AntigravityTranscriptReader.reset()` (28, common name),
`PromptQueue.loadWorkingFile()` (7), `StreamingHistoryBuffer.clear()` (58,
very common name), `WorkflowInstance.initialize()` (17, common name),
`WorkflowOrchestrator.readWorkingFile()` (22, common name — see special case
below).

## Sweep 1b: webview-side dead class-method candidates (21 found)

New in the second pass, once `src/ui/webview-react` was added to the combined
program. All 21 were individually read (not just grepped) since the set is
small.

### Resolved since audit (1)

| Removed code | Resolution |
| --- | --- |
| `src/ui/webview-react/terminalRegistry.ts` `InputCapture` | Removed 2026-07-29. `reset()` had no callers, and the remaining browser-keystroke heuristic was also obsolete: provider session logs now authoritatively produce `USER_STEER` output events where available. The heuristic could misclassify TUI commands and does not observe backend inject-mode writes. |

### Confirmed false positives — CodeMirror plugin lifecycle (7)

All follow the exact same shape: `ViewPlugin.fromClass(class { ... update(update) {...} ... })` in `CodeMirrorEditor.tsx`, an anonymous class literal with **no heritage clause** handed straight to CodeMirror's plugin constructor. CodeMirror calls `.update()` on the instance it creates via its own internal dispatch — there is no static call site to find, and there never will be, regardless of how the script's heritage-clause check is improved (there's no heritage clause to check).

| Location | Method |
| --- | --- |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx:1899` | `update()` |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx:2084` | `update()` |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx:2606` | `update()` |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx:2653` | `update()` |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx:2741` | `update()` |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx:2853` | `update()` |
| `src/ui/webview-react/components/workspace-viewer/WorkspaceFileEditor.tsx:403` | `update()` |

### Confirmed false positives — structural test/runtime mocks (13)

Same blind spot as the `FakeWebSocket`/`FakeStorage` doubles found on the
extension side (Bucket C), just more common in the webview's test suite:
`vi.stubGlobal(...)` and `vi.mock(...)` register a class literal in place of
a real browser/library API, and the real production code that calls those
methods only ever sees the mocked-in type, not the literal declaration.

| Location | Method | Mocking what |
| --- | --- | --- |
| `src/ui/webview-react/test/setup.ts:10` | `observe()` | `window.ResizeObserver` (jsdom doesn't implement it) |
| `src/ui/webview-react/test/setup.ts:11` | `unobserve()` | `window.ResizeObserver` |
| `src/ui/webview-react/test/setup.ts:12` | `disconnect()` | `window.ResizeObserver` |
| `src/ui/webview-react/test/terminalRegistry.test.ts:18` | `MockTerminal.loadAddon()` | `@xterm/xterm`'s `Terminal` |
| `src/ui/webview-react/test/terminalRegistry.test.ts:20` | `MockTerminal.open()` | `@xterm/xterm`'s `Terminal` |
| `src/ui/webview-react/test/terminalRegistry.test.ts:24` | `MockTerminal.resize()` | `@xterm/xterm`'s `Terminal` |
| `src/ui/webview-react/test/terminalRegistry.test.ts:29` | `MockTerminal.write()` | `@xterm/xterm`'s `Terminal` |
| `src/ui/webview-react/test/terminalRegistry.test.ts:33` | `MockTerminal.scrollLines()` | `@xterm/xterm`'s `Terminal` |
| `src/ui/webview-react/test/terminalRegistry.test.ts:35` | `MockTerminal.refresh()` | `@xterm/xterm`'s `Terminal` |
| `src/ui/webview-react/test/terminalRegistry.test.ts:37` | `MockTerminal.onData()` | `@xterm/xterm`'s `Terminal` |
| `src/ui/webview-react/test/terminalRegistry.test.ts:49` | `MockFitAddon.fit()` | `@xterm/addon-fit`'s `FitAddon` |
| `src/ui/webview-react/test/terminalRegistry.test.ts:51` | `MockFitAddon.proposeDimensions()` | `@xterm/addon-fit`'s `FitAddon` |
| `src/ui/webview-react/test/terminalRegistry.test.ts:75` | `onContextLoss()` | `@xterm/addon-webgl`'s `WebglAddon` (inline `vi.doMock`) |

All 20 false positives above (7 CodeMirror + 13 mocks) should get `@keep`
tags rather than deletion — see Phase 3.

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
so the interface requires *some* method with this name to exist, but the
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

3. **`WorkflowStepsPanel.tsx:647`** — `// TODO: End condition results would
   come from workflow state`. The step-details tooltip/panel has a
   placeholder comment where end-condition evaluation results should be
   populated. Worth a look to confirm the data just isn't wired through yet
   vs. genuinely unavailable at that point in the render.

5. **`PromptEditor.tsx:531`** — `forceNewWorkflow: false, // TODO: Add
   checkbox for this`. `EXECUTE_PROMPT` messages hardcode
   `forceNewWorkflow: false`; there's no UI to ever send `true`. Confirm
   whether that's an intentional current default with the checkbox as future
   work, or a real gap (i.e. some other code path is now unreachable for
   users who'd want to force a new workflow).

6. **`WebPushService.ts:74`** — cosmetic: a hardcoded placeholder support
   email in the VAPID subject (`mailto:ctrlyoke@example.com`). Not
   functionally broken, just needs a real address before this ships.

7. **`ICliProvider.ts:404`** — "Other providers leave this unimplemented
   (returns undefined → treated as [])" is a documented, intentional default
   for an optional hook, not a bug. No action needed; excluded from the plan
   below.

## Plan

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

### Phase 2 — retain the `WorkflowOrchestrator` standalone-server API (completed 2026-07-29)

The owner confirmed `STANDALONE_SERVER_PLAN.md` is near-term. The 11 methods
listed in the special case are tagged `@keep` with a reference to that plan,
so the dead-method finder no longer reports them. No further action is needed
in this audit until standalone implementation changes the API.

### Phase 3 — verify Bucket C individually, then either delete or `@keep`-tag

Use the language service directly (or the IDE's Find All References) per
candidate, not the grep count — the count only tells you "worth a closer
look," it can't tell you "dead." Confirmed so far:
- Delete: `CommitMessageGenerator.generate()`.
- `@keep`-tag (false positives, confirmed): `CliAdapter.getConfig()`,
  both `MockPlatform.getConfig()` declarations, `MockVsCodePlatform`'s
  duck-typed callers, the `FakeWebSocket`/`FakeStorage` structural test
  doubles, and — from Sweep 1b — all 7 CodeMirror `ViewPlugin.fromClass`
  `update()` methods plus all 13 webview structural test/runtime mocks
  (`ResizeObserver`, `MockTerminal`, `MockFitAddon`, `WebglAddon`).
- Everything else in Bucket C: unverified, needs the per-symbol check.

### Phase 4 — fix `onPass: "retry"`

Decide: implement real retry-on-pass orchestrator support, or strip `retry`
from `schemas/workflow-schema.json`, `CtrlYokeTypes.ts`'s `EndConditionAction`,
and `PromptPropertyCompletionProvider.ts` so it can't be selected. Silent
downgrade-to-continue is the worse of the two options long-term since it's a
correctness footgun that only shows up as a debug-log line.

### Phase 5 — the smaller UI gaps

Triage items 3–6 from Sweep 2 as normal small tickets; none are urgent, none
block anything else in this plan.

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

### Phase 7 — make the confirmed false positives nominal instead of `@keep`-tagging them

Optional, lower priority than Phases 1–4, but worth doing opportunistically:
apply the "Coding conventions" patterns above to the specific false-positive
sites this audit found — add `getConfig` to `PlatformAdapter`, add the
missing `Pick<...>`/interface heritage clauses to `FakeWebSocket`,
`FakeStorage`, `MockTerminal`, `MockFitAddon`, and the `ResizeObserver` mock,
and add `implements PluginValue` to the CodeMirror `ViewPlugin.fromClass`
classes. Each one converts a permanent `@keep` tag into a self-verifying
reference the script (and VS Code's own "Find All References") can resolve
correctly going forward, and fixes the underlying VS Code navigation gap you
run into day to day, not just this script's blind spot.
