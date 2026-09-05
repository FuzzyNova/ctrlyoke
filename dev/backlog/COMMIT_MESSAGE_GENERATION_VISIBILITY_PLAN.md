# Commit Message Generation Visibility

> **Status:** Implemented — phases 1-4 and §7 Q3 complete. Written 2026-08-17 against current code.
> Re-verified against current code on 2026-08-24: all facts in §1 still hold
> (line numbers drifted slightly, noted inline), and §3.1's design is
> **simplified below** based on an exact-match existing pattern found in
> `WorkingFileManager`/`PromptQueue`/`WorkflowInstance` (`loadFromMemory` +
> `createWorkingFile`) that the original write-up didn't identify. §7's open
> questions are resolved with concrete, code-verified answers. The revised
> implementation is complete; no further spikes are needed.
>
> **Problem in one line:** commit-message generation runs a full harness
> execution and then throws away everything except a final success/failure
> string, so when it fails silently-empty (as opencode-cli did in the
> triggering incident) there is no way to see what the harness actually did.

---

## 1. The incident that motivated this

`.ctrlyoke/logs/ctrlyoke-1787012079476.log:8510-8531` shows an opencode-cli
commit-message run that exited cleanly (`Process exited - execution complete`,
exit 0, 13148 input / 1707 output tokens) and then failed with `Commit message
generation produced an empty response`.

Traced through the code (line numbers re-verified 2026-08-24; content
unchanged, only line numbers drifted slightly since the 2026-08-17 original):

- `CommitMessageGenerator.generateMessage()` (`src/git/CommitMessageGenerator.ts:144-371`)
  tries the `submit_commit_message` MCP tool first, and only falls
  back to captured response text if the tool was never called
  (`CommitMessageGenerator.ts:313-337`).
- The fallback text comes from `capturedResponseText`, set by an
  `onResponseComplete` listener (`CommitMessageGenerator.ts:280-285`)
  attached to a one-shot `WorkflowInstance`.
- That value is computed by `CliResponseCollector.collectHeadlessResponse()`
  (`src/core/harness/shared/CliResponseCollector.ts:47-`):
  `resultResponse = responseText || failure?.message || ""`. With exit code 0
  and no stderr, there is no `failure`, and `extractTextFromEvents()` returned
  empty — so `""` (a defined, falsy string) is fired through
  `onResponseComplete`, which is exactly what trips
  `!rawResponse?.trim()` in `CommitMessageGenerator.ts:347-350`.

So: the harness produced 1707 output tokens but neither called the MCP tool
nor left extractable final text — almost certainly tool-call/exploration
activity (reading files, etc.) with no closing text turn. Whether that's
opencode model behavior or a gap in its `extractTextFromEvents` handling is
**unknowable today**, because nothing about the run is kept. `generateMessage()`
loads the prompt via `instance.loadPromptString(...)`, which explicitly sets
`filePath: "<inline>"` with no `workflowKey`/`runRef`
(`src/core/WorkflowInstance.ts:1189-1203`) — by design, so this run is never
written to `.ctrlyoke/.runs/`. The only trace is the final string held in a
local variable, gone the moment `generateMessage()` returns.

Also stale: `.github/instructions/git.instructions.md`'s "Capture flow"
section says the fallback "resolve[s] the executed prompt response from that
run's `events.jsonl` through `RunOutputResolver`" — that is not what the code
does (it uses the in-memory `onResponseComplete` capture above). Fix this
sentence as part of whatever change lands here; leaving it wrong is worse than
leaving it silent.

---

## 2. Why "embed OutputPane in the settings page" is the wrong shape

The instinctive fix — put a live `OutputPane` inside `CommitSection.tsx` — was
considered and rejected. `OutputPane`
(`src/ui/webview-react/components/layout/output-section/OutputPane.tsx`) takes
~40 props and is deeply coupled to the main workflow output store: the
`@tanstack/react-virtual` virtualizer, scroll-seek placeholders, the minimap,
bash/tool-call/diff expansion state, undo/redo wiring. All of that assumes
rows sourced from a persisted or actively-streaming run reachable through the
normal workflow store. Commit generation has neither today — reproducing that
plumbing a second time for a settings-page card would be a parallel,
lower-fidelity copy of infrastructure that already exists elsewhere.

The right fix is upstream of the UI: **give commit-generation runs the same
persistence a normal workflow run gets**, then reuse the _existing_ run-viewing
machinery instead of building a new one.

---

## 3. Design

### 3.1 Persist commit-generation runs as real (flagged) lineages

`WorkflowInstance` already constructs a real `OutputHistoryManager` in its
constructor unconditionally (`WorkflowInstance.ts:468`) — the `undefined`
`dashboardSink` argument `CommitMessageGenerator` passes today
(`CommitMessageGenerator.ts:257-265`) doesn't disable persistence machinery,
it's a separate concern (UI push notifications). What actually skips
persistence is `loadPromptString()` (`WorkflowInstance.ts:1189-1203`) never
allocating a lineage/run — it calls `promptQueue.loadPrompts(promptFile)`
directly with no `workingFilePath`, so the queue state's
`workflowKey`/`runRef` stay unset and nothing downstream has an address to
write `manifest.json`/`events.jsonl` to.

**Revised design — reuse the existing template-loading path instead of hand-rolling lineage/run allocation.**
The original draft of this section proposed a new method that manually calls
`WorkflowLineageRepository.createLineage()` + `allocateRun()` +
`OutputHistoryManager.initializeRunAt()`/`finalizeRun()`. That duplicates
logic that already exists and already runs automatically. Verified by reading
the actual call chain:

- `WorkflowInstance.loadFromTemplate()` (`WorkflowInstance.ts:1163-1183`) —
  used today for template-created workflows, which also have no source file
  on disk — calls `PromptFileLoader.loadFromMemory()` →
  `loadParsedPromptFile()` (`PromptFileLoader.ts:100-227`), which calls
  `promptQueue.createWorkingFile(displayName, steps, workspaceFolderPath, undefined)`
  **before** `promptQueue.loadPrompts(promptFile, workingFilePath)`.
- `PromptQueue.createWorkingFile()` (`PromptQueue.ts:1344-1372`) calls
  `WorkingFileManager.createWorkingFile()` (`WorkingFileManager.ts:294-327`),
  which calls `WorkflowLineageRepository.createLineage()` — itself just a
  thin wrapper around `WorkflowPaths.allocateWorkflowKey()`
  (`WorkflowLineageRepository.ts:69-111`) — and sets `state.workflowKey` /
  `state.workingFilePath` on the queue. Passing `undefined` for
  `originalFilePath` is already the documented, exercised "ephemeral lineage"
  shape (`WorkflowLineageDescriptor.originalFile` docstring,
  `CtrlYokeTypes.ts:402`) — templates already prove this path works with no
  source file.
- Critically, `PromptQueue.loadPrompts()` (`PromptQueue.ts:334-374`)
  **explicitly preserves** `this.state.workflowKey`/`runRef` across the call
  (lines 350-356), and its own comment says why: _"`createWorkingFile()` sets
  these just before `loadPrompts()` is called
  (`PromptFileLoader.loadParsedPromptFile`); without preserving them here, a
  freshly loaded prompt file's first execution could never satisfy
  `executeLoadedPromptFile`'s fresh-start guard (`... && workflowKey`)."_ This
  is a preexisting, intentional seam for exactly this "create a lineage, then
  load prompts into it" sequencing — not something to build.
- Once `state.workflowKey` is set, `executeLoadedPromptFile()`'s existing
  fresh-run branch (`WorkflowInstance.ts:1774-1811`) already does the rest
  unconditionally: `promptQueue.promoteToNewRun()` →
  `WorkingFileManager.promoteToNewRun()` (allocates the `RunRef`) →
  `outputHistoryManager.initializeRunAt()` (opens `manifest.json`/
  `events.jsonl`). `finalizeRun()` is likewise already called from within
  `executeLoadedPromptFile()`'s own completion paths
  (`WorkflowInstance.ts:2127`, `4516`) with no help needed from the caller.

So the actual, minimal change is:

- Add `WorkflowInstance.loadPromptStringAsRun(promptText, nameHint, workflowOverrides?)`
  that does what `loadPromptString()` does today (clear queue, build the
  single-step `PromptFile`), but — mirroring `loadFromMemory()`'s tail —
  first calls `promptQueue.createWorkingFile(nameHint, promptFile.steps, workspaceFolderPath, undefined)`
  and passes the resulting `workingFilePath` into `loadPrompts()`. No manual
  lineage/run/timeline calls; `executeLoadedPromptFile()` picks it up for
  free exactly like any other fresh run.
- `CommitMessageGenerator.generateMessage()` switches to this method instead
  of `loadPromptString()`, passing a stable `nameHint` (see §3.1.1 for what
  that hint needs to be and why it can't just be a literal string reused
  as-is).
- One thing `loadPromptString()` does that must be preserved:
  `workflowOverrides` (harness/model/executionMode/etc. from
  `buildCommitWorkflowOverrides()`) are spread onto the in-memory
  `PromptFile`, not persisted as working-file properties the way
  `loadParsedPromptFile()` persists them for real prompt files
  (`PromptFileLoader.ts:183-217`). That's fine to leave as-is — commit-gen's
  overrides are deliberately transient per-call config, not something a user
  would want written into a reusable lineage's working file — but note it
  explicitly so a future edit doesn't "fix" it into matching template
  behavior by accident.

#### 3.1.1 Reusing one lineage across calls (needed for open question 2, §7)

`WorkflowPaths.allocateWorkflowKey()` (`WorkflowPaths.ts:445-476`) is **not**
idempotent on `nameHint` — every call mints a brand-new,
timestamp-suffixed key and creates a new directory, even with an identical
hint. So "one lineage per workspace" (the proposal in §7 Q2) is not free: two
back-to-back commits would otherwise create two lineages. Making reuse work
needs a small persisted pointer, since `CommitMessageGenerator` is
reconstructed fresh on every call (a brand-new process for the CLI, no
in-memory state to carry a resolved key across invocations for the extension
either). Concretely:

- Store the resolved `workflowKey` at a well-known path, e.g.
  `<runsRoot>/.commit-message-lineage.json` (a sibling of the per-lineage
  directories under `.runs/`, not itself a lineage — no collision with
  `assertValidWorkflowKey`'s key format since it's a different file, not a
  directory entry `listLineageKeys()` would enumerate).
- On each `generateMessage()` call: read the pointer; if present, validate it
  with `WorkflowLineageRepository.tryReadDescriptor()`
  (`WorkflowLineageRepository.ts:151-160`, already returns `undefined` on a
  missing/corrupt lineage — an existing, exercised validate-and-fallback
  primitive) before reusing the key. If absent or invalid, mint a new lineage
  via the normal `createWorkingFile()` path and (re)write the pointer.
- This keeps `maxRuns`-based pruning (`OutputHistoryManager.pruneOldRuns`,
  already invoked from `initializeRunAt`, confirmed at
  `OutputHistoryManager.ts:284-290`) working unmodified, per the original
  proposal — it's a normal single lineage accumulating normal runs.

### 3.2 Keep these runs out of the recent-workflows list

Verified: `WorkspaceSessionManager.listWorkingFilesByRecency()`
(`src/core/orchestration/WorkspaceSessionManager.ts:120-172`) enumerates
**every** lineage key under `.ctrlyoke/.runs/` via
`WorkflowLineageRepository.listLineageKeys()` unconditionally — there is no
existing "hidden" or "system" concept on `WorkflowLineageDescriptor` to filter
on (checked: no `favorite`-adjacent hidden flag, no `kind` discriminator).
Persisting commit-gen runs the normal way would therefore make every commit
message generation attempt show up as a "recent workflow," which is not
wanted.

Add one field to `WorkflowLineageDescriptor`
(`src/types/CtrlYokeTypes.ts:381`), e.g. `isSystemGenerated?: boolean`, set
true when `CommitMessageGenerator` creates the lineage, and filter it out in
`listWorkingFilesByRecency()`. Also check (during implementation) whether the
search index and usage-stats feeds
(`OutputHistoryManager.refreshSearchIndex()` / `feedUsageStores()`, both
called from `initializeRunAt`/`finalizeRun`) need the same filter, or whether
excluding "internal" runs from search/usage is undesirable (arguably you _do_
want commit-gen runs searchable/countable — only the recent-workflows list is
in scope here; treat the others as an open question, §7).

### 3.3 Viewing: reuse `LOAD_RUN_VIEW`, not a new renderer

Because the run is now a normal persisted run, the dashboard already has a
mechanism to display it in the full `OutputPane` — live while running, replayed
after: `LOAD_RUN_VIEW` (`MESSAGE_TYPES.LOAD_RUN_VIEW`,
`src/types/WebviewMessageTypes.ts:1619-1622`), sent through the shared sender
in `src/ui/webview-react/utils/runNavigation.ts` and already used by
`RunSummaryRow.tsx` and `HistorySearchDrawer.tsx` to switch a client's
displayed draft/run. It takes a `WorkflowViewAddress` (kind `"run"`,
`workflowKey` + `runRef`) — nothing about it requires the lineage to be
"discoverable" in the recent list first, so §3.2's filtering doesn't block
this.

This is strictly better than the original "embed a read-only row list in
settings" idea: it gets **live** streaming for free (tool calls, diffs, the
real event sequence) while the harness is still running, plus full replay
afterward, using 100% existing rendering — the exact thing the original ask
wanted ("does it read other files, does it try to call the mcp and fail").

UI change in `CommitSection.tsx`'s existing "Last Generation Input" panel
(`src/ui/webview-react/components/settings/CommitSection.tsx:162-256`): add a
"View full output" affordance that sends `LOAD_RUN_VIEW` for the last
generation's address and switches the dashboard to the Output tab. Requires
knowing that address, which is §3.4.

### 3.4 Carry the run address on the generation record

`CommitMessageGenerationRecord` is currently duplicated verbatim in two
places — `src/git/CommitMessageGenerationTracker.ts:1-13` and
`src/types/WebviewMessageTypes.ts:517-529` — with no import between them. Fix
this while touching it: keep one definition (the git-side one, since
`src/git/` is the producer) and have `WebviewMessageTypes.ts` import it,
per the project's single-source-of-truth rule.

Add `workflowKey?: string` and `runRef?: string` to the record, populated by
`CommitMessageGenerator.generateMessage()` from the lineage it allocates in
§3.1. `CommitMessageGenerationTracker` (passive in-memory singleton, already
documented as UI-only state in `.github/instructions/git.instructions.md`)
needs no changes beyond the type gaining fields — its writers
(`ScmCommitCommand`, `HostedWorkspaceViewerService`) already pass the record
through.

### 3.5 Cheap complementary win: log the event boundary

Independent of §3.1-3.4 and worth doing regardless (small, immediate): add
`Log.debug` calls in `CommitMessageGenerator.generateMessage()` around the MCP
outcome and the raw response length before the empty-response throw, and
consider a temporary streaming-chunk subscriber (mirroring
`emitStreamingChunk`/`emitStreamingEvents` in
`src/core/harness/CliIntegration.ts:634-640`) so a developer reading
`ctrlyoke-*.log` mid-incident sees _something_ about tool calls even before
§3.1 ships. This does not replace the UI fix — it's a stopgap for exactly the
kind of log-diving that produced this plan's triggering incident — but it's
cheap enough to land first/independently.

---

## 4. Non-goals

- Not a user-configurable "define your own commit-message workflow" system.
  That's a materially bigger feature (template authoring, end-condition
  opt-out UI, per-user workflow definitions) than the visibility problem
  requires. If demand shows up for customizing _how_ commit-gen prompts run
  beyond the existing harness/model/prompt settings, that's a separate plan.
- Not a fix to `extractTextFromEvents` / opencode's parser. §1 identifies
  where the empty-response path is, not why the model's output didn't parse
  to text — that needs the visibility this plan adds before it can even be
  diagnosed.
- Does not change the MCP-capture-first design (§ "Capture flow" in
  `git.instructions.md`) — structured submission stays primary, prose
  extraction stays fallback.

---

## 5. Cross-file contracts touched

Per `.github/instructions/git.instructions.md`'s existing contract note:
`generateMessage()`'s return shape (`{ message, prompt, cliCommand? }`) and
`CommitMessageGenerationRecord` are consumed by `ScmCommitCommand` and
`HostedWorkspaceViewerService`, and mirrored into webview message types.
Adding `workflowKey`/`runRef` to the record is an additive, optional-field
change — no existing consumer needs updating, but both writers should be
checked to confirm they pass through whatever `generateMessage()` now returns.

---

## 6. Phasing

| Phase | Content                                                                                                                                                                                                     | Ships value alone?                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1     | §3.5 — `Log.debug` additions around MCP outcome / response length                                                                                                                                           | Yes — immediate debugging aid                            |
| 2+3   | §3.1 — `WorkflowInstance.loadPromptStringAsRun()` (mirrors `loadFromMemory()`; no new lineage/run/timeline plumbing) + §3.1.1 pointer-file lineage reuse + §3.2 system-generated flag/recent-list filtering | Partial — data now persists, but nothing surfaces it yet |
| 4     | §3.3 + §3.4 — dedupe `CommitMessageGenerationRecord`, carry the address, "View full output" affordance in `CommitSection`                                                                                   | Yes — completes the loop                                 |
| —     | §7 Q3 — CLI failure-path `WorkflowPaths.eventsPath()` pointer via an address-carrying error                                                                                                                 | Independent, cheap; can land alongside phase 2 or later  |

The persistence and filtering work ships together — persisting commit-gen runs
without filtering them out of "recent workflows" is a regression (log/history
clutter proportional to how often the user commits), not a strict improvement.

---

## 7. Open questions — resolved 2026-08-24

1. **Search index / usage stats. RESOLVED — keep them in both.** Read
   `OutputHistoryManager.feedUsageStores()` (`OutputHistoryManager.ts:1572-1606`)
   and `refreshSearchIndex()` (`OutputHistoryManager.ts:1628-1635`) in full:
   both operate purely off `workflowKey`/`runRef`/the run manifest content
   (`WorkflowPaths.parseRunArtifactPath()`, `timelineRecorder.readManifest()`,
   `historySearchIndexService.enqueueWorkspaceRefresh()`). Neither reads
   `WorkflowLineageDescriptor.originalFile` or any other descriptor field —
   there is no hidden assumption to trip. Implement exactly as originally
   proposed: filter `isSystemGenerated` lineages out of
   `listWorkingFilesByRecency()` only (`WorkspaceSessionManager.ts:120-172`);
   leave search indexing and usage-store feeding untouched.
2. **Retention. RESOLVED — one reused lineage, but it needs a pointer file.**
   `allocateWorkflowKey()` always mints a new key per call regardless of
   `nameHint` (verified, §3.1.1) — "reuse one lineage" is not automatic from
   passing the same hint string. §3.1.1 above specifies the required
   mechanism: a small pointer file at `<runsRoot>/.commit-message-lineage.json`
   holding the resolved `workflowKey`, validated each call via
   `WorkflowLineageRepository.tryReadDescriptor()` before reuse, with a fresh
   lineage minted (and the pointer rewritten) whenever it's missing or
   invalid. Once resolved to a real lineage, normal `maxRuns` pruning applies
   with zero new configuration, as originally proposed.
3. **CLI parity. RESOLVED — attach the address to the thrown error.**
   Verified `commitCommand` in `src/cli.ts:1676-1725`: its `catch` block
   (1721-1725) only has `err.message` to work with today — `generateMessage()`
   throws a plain `Error` with no run address attached. `WorkflowPaths.eventsPath(workspaceRoot, workflowKey, runRef)`
   (`WorkflowPaths.ts:275-283`) already exists and is exactly the helper
   needed to print a path. Implementation: give `generateMessage()`'s
   empty-response throw (and any other post-allocation failure) a
   `workflowKey`/`runRef`-carrying error (a small `CommitMessageGenerationError`
   subclass, or `Error.cause`), and have `commitCommand`'s catch block check
   for those fields and print the `eventsPath()` result when present. Cheap,
   and needs nothing beyond what phase 2 already allocates.
4. **MCP-unavailable dev builds. RESOLVED — persist regardless, as proposed.**
   Confirmed `useMcpCapture` (`CommitMessageGenerator.ts:200-206`) only gates
   whether the MCP tool/temp-file capture path is wired into the prompt and
   `mcpServerConfig` — it has no interaction with `WorkflowInstance`
   construction or execution, which is where §3.1's persistence attaches. No
   conditioning needed; persistence is orthogonal to MCP availability, and (as
   originally noted) the text-extraction fallback is exactly the path that
   failed silently in §1's incident, so it needs the visibility most.
