# Commit Message Generation Visibility

> **Status:** Proposed — not implemented. Written 2026-08-17 against current code.
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

Traced through the code:

- `CommitMessageGenerator.generateMessage()` (`src/git/CommitMessageGenerator.ts:147-221`)
  tries the `ctrlyoke_submit_commit_message` MCP tool first, and only falls
  back to captured response text if the tool was never called
  (`CommitMessageGenerator.ts:310-333`).
- The fallback text comes from `capturedResponseText`, set by an
  `onResponseComplete` listener (`CommitMessageGenerator.ts:276-281`)
  attached to a one-shot `WorkflowInstance`.
- That value is computed by `CliResponseCollector.collectHeadlessResponse()`
  (`src/core/harness/shared/CliResponseCollector.ts:95-101`):
  `resultResponse = responseText || failure?.message || ""`. With exit code 0
  and no stderr, there is no `failure`, and `extractTextFromEvents()` returned
  empty — so `""` (a defined, falsy string) is fired through
  `onResponseComplete`, which is exactly what trips
  `!rawResponse?.trim()` in `CommitMessageGenerator.ts:344-346`.

So: the harness produced 1707 output tokens but neither called the MCP tool
nor left extractable final text — almost certainly tool-call/exploration
activity (reading files, etc.) with no closing text turn. Whether that's
opencode model behavior or a gap in its `extractTextFromEvents` handling is
**unknowable today**, because nothing about the run is kept. `generateMessage()`
loads the prompt via `instance.loadPromptString(...)`, which explicitly sets
`filePath: "<inline>"` with no `workflowKey`/`runRef`
(`src/core/WorkflowInstance.ts:1090-1101`) — by design, so this run is never
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
constructor unconditionally (`WorkflowInstance.ts:469`) — the `undefined`
`dashboardSink` argument `CommitMessageGenerator` passes today
(`CommitMessageGenerator.ts:253-261`) doesn't disable persistence machinery,
it's a separate concern (UI push notifications). What actually skips
persistence is `loadPromptString()` never allocating a lineage/run, so the
queue state's `workflowKey`/`runRef` stay unset and nothing downstream has an
address to write `manifest.json`/`events.jsonl` to.

Concretely:

- Allocate a lineage the same way any other first run does:
  `WorkflowLineageRepository.createLineage()` +
  `allocateRun()`/`WorkingFileManager.promoteToNewRun()`, then
  `OutputHistoryManager.initializeRunAt()`
  (`src/core/orchestration/OutputHistoryManager.ts:251-290`) to open
  `manifest.json`/`events.jsonl`, and `finalizeRun()`
  (`OutputHistoryManager.ts:752-789`) when the instance completes — the same
  calls a normal execution triggers, just invoked for this one-shot instance.
  `allocateWorkflowKey(workspaceRoot, nameHint)`
  (`src/utils/WorkflowPaths.ts:445-476`) already supports minting a lineage
  with no backing prompt file — `WorkflowLineageDescriptor.originalFile` is
  already documented as optional "for ephemeral/dashboard-created lineages"
  (`src/types/CtrlYokeTypes.ts:381-401`) — so this is an existing, supported
  shape, not a new one.
- The cleanest integration point is a new `WorkflowInstance` method (e.g.
  `loadPromptStringAsRun()`) that does what `loadPromptString()` does today
  but additionally performs the lineage/run allocation above before handing
  off to the normal `executeLoadedPromptFile()` path — so every downstream
  persistence call site (which already keys off queue-state
  `workflowKey`/`runRef`) fires without needing to know this run is special.
  `CommitMessageGenerator.generateMessage()` switches to this method instead
  of `loadPromptString()`.

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

| Phase | Content                                                                                                                   | Ships value alone?                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1     | §3.5 — `Log.debug` additions around MCP outcome / response length                                                         | Yes — immediate debugging aid                            |
| 2     | §3.1 — `loadPromptStringAsRun()`, lineage allocation, `initializeRunAt`/`finalizeRun` wiring for commit-gen               | Partial — data now persists, but nothing surfaces it yet |
| 3     | §3.2 — `isSystemGenerated` flag + recent-list filtering                                                                   | Gate for phase 2 shipping without cluttering the UI      |
| 4     | §3.3 + §3.4 — dedupe `CommitMessageGenerationRecord`, carry the address, "View full output" affordance in `CommitSection` | Yes — completes the loop                                 |

Phase 3 should land no later than phase 2 — persisting commit-gen runs without
filtering them out of "recent workflows" is a regression (log/history clutter
proportional to how often the user commits), not a strict improvement.

---

## 7. Open questions

1. **Search index / usage stats.** Should `isSystemGenerated` lineages be
   excluded from `refreshSearchIndex()`/`feedUsageStores()` too, or only from
   the recent-workflows list? Excluding them from search removes the ability
   to full-text-search past commit-message generations; excluding them from
   usage stats undercounts real harness spend. Proposed: keep them in search
   and usage, filter only the recent-workflows list — but confirm neither
   feed assumes "every lineage has an `originalFile`" somewhere non-obvious.
2. **Retention.** Commit generation can run far more often than typical
   workflows (every commit). Does this lineage need its own `maxRuns`-style
   cap independent of `ConfigurationUtils.getMaxRuns()`, or is one lineage
   with pruning-as-normal (`OutputHistoryManager.pruneOldRuns`, already called
   from `initializeRunAt`) sufficient? Proposed: reuse one lineage per
   workspace (stable `nameHint`, e.g. `"commit-message-generation"") so normal
per-lineage `maxRuns` pruning applies without new configuration.
3. **CLI parity.** `commitCommand` (CLI) also calls `generateMessage()`
   directly per `git.instructions.md`. Does the CLI want a
   `--show-output`/log-path pointer on failure, given it has no dashboard to
   send `LOAD_RUN_VIEW` to? Proposed: on CLI failure, print the persisted
   run's `events.jsonl` path so a user can inspect it manually — cheap, and
   the file exists once phase 2 lands regardless of caller.
4. **MCP-unavailable dev builds.** `useMcpCapture` is false when
   `mcp-server.js` isn't built (`CommitMessageGenerator.ts:203-209`) — does
   persistence still make sense there, or should phase 2 be conditioned on
   MCP capture being active? Proposed: persist regardless — the visibility
   problem applies to the text-extraction fallback path even more than the
   MCP path, since that's exactly the path that failed in §1's incident.
