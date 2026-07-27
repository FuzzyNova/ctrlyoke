# Parser Unification — One Event Mapping Per Harness

**Status:** Phases 0, 1, 2, 3, and 4 complete; Phases 5 and later remain in progress. Phases were staged as queued ctrlyoke steps on 2026-07-26.
**Motivation:** Maintaining a response-parser path and a log-parser path per harness is a recurring tax. The response path is routinely the one missing data, and the fix is always "read it back out of the session log anyway" — see `353ad5f0` (Codex headless `file_change` items carry `{path, kind}` with no patch body; `CodexCliProvider.augmentParsedOutput()` back-fills hunks from `event_msg:patch_apply_end`).

That back-fill is not just maintenance debt, it is a **user-visible defect**: because it runs only after the prompt completes, a headless Codex run shows a bare `Edited <file>` with no diff for its entire duration. The information exists in the log the whole time. Deleting `augmentParsedOutput()` as a stdout-repair mechanism is a primary goal of this plan, not a side effect.

---

## Verdict on the original proposal

The **goal is right**: there should be exactly one event-mapping implementation per harness, and it should be the log parser's.

The **stated mechanism is wrong in two places**, and correcting them makes the change both cheaper and non-lossy:

1. **`src/core/harness/shared/CliParseUtils.ts` must not be deleted.** Despite its predecessor's name it is not part of the response-parser layer — it's a static utility class, and its `parseUnifiedDiff()` has log-side consumers today: `CodexLogParser.ts:1454`, `CodexLogParser.ts:1615`, `CopilotToolBuilder.ts:198`, and `AntigravityToolEventBuilder.ts:244`. The thing to remove is the `IResponseParser` layer (the six `*ResponseParser.ts` classes, 2,466 LOC). `CliParseUtils` survives the eventual deletion.

2. **"Unify on log parsers" does not have to mean "wait for the session log."** Those are separable. The invariant that matters is _one mapping implementation per harness, and it is the log parser's_. Where those events come from is a second, independent choice, made per harness on **fidelity** grounds:
   - **stdout-sourced** — the harness's stdout already speaks the log parser's event vocabulary and carries everything the log does, so stdout events feed `extractResponse()` / `extractStructuredEventsFromEvent()` directly and no log is ever read. Zero latency. The provider-side adapter is a JSONL split (~10 lines), not a parser.
   - **log-sourced** — the session log is _richer_ than stdout, so the log is the content source and stdout is demoted to a clock and a session-ID carrier (see [The stdout contract](#the-stdout-contract)).

   The `IResponseParser` layer dies in both cases. That is the point: source mode is a per-harness switch, not a reason to keep a second parser stack alive.

   **Choose on fidelity, not latency** — and per [Measured: the log is live](#measured-the-log-is-live), latency isn't even on the table: log-sourcing costs no measurable delay. Where the log is richer the log wins outright, because the alternative is shipping degraded events live and patching them at the end, which is exactly the `augmentParsedOutput()` pattern this plan exists to delete.

### The duplication is worse than 2×

Each harness today carries **three or four** independent mappings from raw CLI output to `CliEvent[]`:

| Mapping                                   | Owner             | Used by                    |
| ----------------------------------------- | ----------------- | -------------------------- |
| `parse(stdout, stderr, exitCode)`         | `*ResponseParser` | headless final output      |
| `processStreamingChunk(chunk, state)`     | `*ResponseParser` | headless live streaming    |
| `extractResponse(events)`                 | `*LogParser`      | interactive final output   |
| `extractStructuredEventsFromEvent(event)` | `*LogParser`      | interactive live streaming |

`processStreamingChunk` is a separate implementation from `parse()` in every harness that has one (`ClaudeResponseParser.ts:396`, `CodexResponseParser.ts:465`, `CopilotResponseParser.ts:319`, `QwenResponseParser.ts:264`, `OpenCodeResponseParser.ts:123`) — the streaming path and the batch path can and do drift from each other _within_ the response parser, not just against the log parser. Unification collapses four mappings to two.

### Churn supports the direction

Last 12 months, `src/core/harness/*/*LogParser.ts` took 20 commits; `src/core/harness/*/*ResponseParser.ts` took 7. The log parsers are where the fidelity work actually lands. That is consistent with the response path being the one that silently falls behind.

---

## Measured: the log is live

The design originally assumed log-sourcing traded ~10–15s of startup latency for fidelity. **It does not.** Measured against two real headless runs (`originator: "codex_exec"`, `source: "exec"`, Codex 0.145.0, `~/.codex/sessions/2026/07/26/`):

| Δ from session start | Event                                        |
| -------------------- | -------------------------------------------- |
| **0.00s**            | `session_meta` — the log file already exists |
| 0.00s                | `event_msg:task_started`                     |
| 0.79s / 0.92s        | first `response_item:message`                |
| 5.03s / 5.11s        | first `agent_message` (first actual AI text) |
| 12.93s → **12.96s**  | `custom_tool_call` → `patch_apply_end`       |
| 16.80s → **16.81s**  | `custom_tool_call` → `patch_apply_end`       |
| 18.48s → **18.49s**  | `custom_tool_call` → `patch_apply_end`       |

Three conclusions:

1. **There is no session-log discovery gap.** `session_meta` is written at t=0, so `discoverSessionLog(sessionId)` resolves on the first tick. No polling ladder, no recovery path, no startup coordinator.
2. **There is no per-event buffering.** `patch_apply_end` lands 0.02–0.03s after the `custom_tool_call` that performed the edit. The diff is available the instant the write happens — which is precisely the payoff log-sourcing exists to deliver. Corroborated independently in interactive mode, where the output panel trails the live TUI by ~1s.
3. **The "10–15s delay" was time-to-first-model-output, not log latency.** First `agent_message` at ~5s and first meaningful tool work at ~13s are model thinking time. stdout is equally blind during that window; it has nothing to report either.

**Therefore latency is not a decision axis.** Source mode is chosen purely on fidelity, and secondarily on log-layout fragility (below). Do not reintroduce latency as an argument for stdout-sourcing.

**Caveats, for whoever revisits this:** two runs, one model, one Codex version, Windows. The measurement is of the log's own internal clock, so it establishes that nothing is buffered _after_ session init but not the wall-clock gap between process spawn and session init — that gap is CLI startup, which delays stdout's `thread.started` identically. Neither caveat is load-bearing for the conclusions above, but re-measure if Codex changes its rollout-log format (the instructions file already warns to diff the log against parser assumptions on version bumps).

### The residual argument for stdout-sourcing

With latency gone, exactly one non-fidelity argument survives: **stdout is a maintained public contract; the session log is an internal artifact whose layout vendors change without notice.** `harness-cli-providers.instructions.md` documents Copilot dropping `session.truncation` outright in the 0.0.x→1.0.x jump, plus nested-vs-flat session-state path variants. That is a real fragility cost, and it is why Copilot, Claude, and Qwen stay stdout-sourced below — not because stdout is faster, but because their logs are not richer enough to be worth binding to a private file layout.

---

## Format compatibility, per harness

Verified by comparing the event-type vocabularies each parser branches on. **Source mode is chosen by which stream carries more information, not by which arrives sooner.**

| Harness         | Headless stdout                                                                                                              | Session log                                                                                                                                                                                                 | Log richer?                                                                                                                            | Source mode                                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Codex**       | `thread.started`, `turn.completed`, `item.completed` with `item.type` of `agent_message`/`command_execution`/`file_change`/… | `session_meta`, `turn_context`, `event_msg`, `response_item`, `function_call`, `patch_apply_end`, …                                                                                                         | **Much** — `file_change` is `{path, kind}` on stdout; the log has `unified_diff` and whole-file `content`, plus per-turn `token_count` | **Log-sourced.** Highest payoff of any harness: diffs render _when the write happens_, not on a final back-fill pass. Deletes `CodexCliProvider.augmentParsedOutput()` outright. |
| **Antigravity** | Incremental transcript mapping in `AntigravityLogParser`                                                                     | `brain/<id>/.system_generated/logs/transcript_full.jsonl` (compact transcript only as fallback) — rich planner/tool/checkpoint/error events; the tailed `cli-*.log` carries session and completion markers. | **Much** — structured events and diffs are available incrementally.                                                                    | **Implemented.** See `../implemented/ANTIGRAVITY_TRANSCRIPT_PARSER_PLAN.md`.                                                                                                     |
| **Qwen**        | `session_id`-bearing JSON objects                                                                                            | `~/.qwen/projects/*/chats/*.jsonl`, `message.parts[]`                                                                                                                                                       | Unmeasured                                                                                                                             | **TBD** — measure before choosing.                                                                                                                                               |
| **Claude**      | `stream-json`: `system`/`assistant`/`user`/`result`, snake_case `session_id`, `tool_use_result`                              | session JSONL: `assistant`/`user`/`attachment`, camelCase `sessionId`, `toolUseResult`                                                                                                                      | Marginal — log adds `attachment`, background-task markers                                                                              | **Either.** Start stdout-sourced (field aliasing only); revisit if background-task tracking needs the log.                                                                       |
| **Copilot**     | `--output-format json`: `assistant.message`, `tool.execution_start`, `tool.execution_complete`                               | `events.jsonl`: same vocabulary plus `session.*`, `user.message`, `system.notification`                                                                                                                     | Marginal — the extras are session-lifecycle, not content                                                                               | **stdout-sourced.** Note context-window data lives in neither stream (it's the OTel export file), so that augmentation survives regardless.                                      |
| **OpenCode**    | `run --format json`                                                                                                          | `opencode export <id>` — parser doc states it produces "the same event shape produced by `opencode run --format json`" (`OpenCodeLogParser.ts:113`)                                                         | **No** — 1:1, and the "log" is a subprocess call, not a file                                                                           | **stdout-sourced.** See below: this costs ~10 lines, not a layer.                                                                                                                |

### OpenCode does not require keeping the layer

OpenCode is the one harness whose stdout is genuinely 1:1 with its "log" — and whose log parser isn't a log parser at all, but a 1s poll of `opencode export <sessionId>` as a subprocess (`OpenCodeLogParser.ts:43`, `:153`). Leaving it stdout-sourced is correct on the merits.

That does **not** mean keeping `IResponseParser` alive for it. A stdout-sourced harness needs one provider method:

```ts
// ICliProvider
parseHeadlessStdout?(stdout: string): BaseCliEvent[];
```

For OpenCode that is a JSONL split — the same `lines.split("\n").map(JSON.parse)` already inlined in `OpenCodeResponseParser.parse()`. The 261-LOC response parser still gets deleted; its event mapping is already duplicated in `OpenCodeLogParser.extractResponse` and both sides already share `OpenCodeEventMapper`. So OpenCode keeps zero latency, avoids the `export` subprocess entirely, and costs roughly ten lines rather than a parser stack.

---

## The stdout contract

**stdout is not thrown away.** What gets thrown away is the _event mapping_ of stdout — the `parse()` and `processStreamingChunk()` bodies. The stream itself keeps three jobs, none of which are parsing:

### 1. Session ID carrier

The first identifying event (Codex `thread.started`, Claude `system`/`init`, Copilot's `result`) yields the session ID. This is what makes log discovery a **direct path construction** rather than prompt-text matching across a session directory. Narrow it to a per-provider `extractSessionIdFromStdout(chunk)` that looks for one field — not a full event walk.

This is why headless must not adopt `CliInteractiveStartupCoordinator` (451 LOC of SessionStart-hook waiting, 60s soft / 5min hard timeouts, prompt-matching fallback). Headless gets the session ID for free from a stream it is already reading.

### 2. Clock

Every stdout chunk triggers `readNewLines(logPath)`. This works because `BaseLogParser.readNewLines()` is position-tracked and idempotent — it returns `[]` immediately when the file hasn't grown (`BaseLogParser.ts:386`) and otherwise reads only the delta from `lastReadPosition`. It does not care what triggered it; `watchLogFile` is itself just `fs.watch` → `readNewLines` (`BaseLogParser.ts:470-481`).

A live stdout stream is a **better** activity signal than `fs.watch`: it is ordered, it cannot be coalesced or dropped by the OS, and it implicitly proves the process is alive. Headless has this signal; interactive does not. Use it.

Two supplements are still required:

- **Idle backstop.** stdout can go quiet while a long tool call runs. Add a low-frequency poll (~500ms–1s) so log growth during a silent stretch is still picked up. Cheap, for the reason above.
- **Post-exit drain.** Process exit does not guarantee the log is flushed. Reuse the bounded drain `CliLogMonitor` already implements (`DRAIN_DEADLINE_MS = 2000`, `DRAIN_POLL_INTERVAL_MS = 150`) before the final `extractResponse()`.

The 10–15s startup gap needs no special handling: ticks during that window find nothing and return `[]`, and the first successful read catches up the entire backlog in one delta since `lastReadPosition` is still 0.

### 3. Failure and completion signal

Exit code and stderr continue to flow through `CliResponseCollector.getHeadlessFailure()`, unchanged. **Process exit is the completion signal** — which is strictly more reliable than the interactive path's hook/`isComplete()` detection, and means headless needs no notification monitor, no `handleCompletion` race handling, and no background-work hold.

### What this buys structurally

Today headless has two sources feeding one output: stdout streams degraded events live, then `augmentParsedOutput()` reconciles them against the log at the end — which is where the positional per-path cursor matching in `353ad5f0` comes from. Under a single source there is nothing to reconcile: no interleaving, no dedup, no cursor alignment. `CodexCliProvider.applyLoggedChangesToFileEvents()` and its ~90 lines of pairing logic delete along with it.

`augmentParsedOutput()` does **not** disappear entirely — Copilot's reads the OTel export file, a third artifact that is neither stdout nor the session log. It survives for that. But its use as a _stdout-repair_ mechanism ends.

---

## What headless actually loses (and what it doesn't)

Under the reshaped plan:

- **Time-to-first-event — unchanged in both modes.** Measured, not assumed: the session log exists at t=0 and is written continuously. There is no latency cost to pay.
- **Antigravity now uses its rewritten incremental transcript parser** — see `../implemented/ANTIGRAVITY_TRANSCRIPT_PARSER_PLAN.md`. The log parser emits structured planner/tool/checkpoint/error events while retaining the Go log for session and completion markers.
- **Time-to-_correct_-event — improves sharply where it was worst.** Codex headless today shows a bare `Edited <file>` for the whole run and only gains a diff at the end, when `augmentParsedOutput()` back-fills from the log. Log-sourced, the `patch_apply_end` diff renders **when the write happens** — 0.02s after the edit. This is a strict gain, not a trade.
- **Streaming fidelity — improves everywhere.** `extractStructuredEventsFromEvent` is the same mapping as the final `extractResponse`, so streamed and final output can no longer disagree. Today's `processStreamingChunk` offers no such guarantee.
- **Antigravity log-monitored output — already improved by the completed rewrite.** The transcript-backed log parser now turns the rich stream into structured tool/text events. The separate headless response parser still consumes stdout, so broader headless-source consolidation remains future work.

Things that are **not** parsing and must survive the deletion:

| Capability                      | Current location                                                                                                           | Disposition                                                                                                                                                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session ID from stdout          | `*ResponseParser.extractSessionId()`; read at `CliResponseCollector.ts:74`                                                 | **Must survive.** Only Copilot and Antigravity implement `ICliProvider.extractSessionIdFromLogs`; Claude, Codex, OpenCode and Qwen headless get their session ID from stdout metadata. Losing it forces every harness through `discoverSessionLog()` prompt-text matching. |
| Recoverable-session retry       | `ClaudeResponseParser.isRecoverableSessionError()` and the existing Qwen equivalent; called at `CliExecutionRunner.ts:394` | Move the implementations to `ICliProvider`. They classify spawn errors, not output.                                                                                                                                                                                        |
| Headless failure classification | `CliResponseCollector.getHeadlessFailure()` (exit code, stderr, CLI-invocation-error patterns)                             | Unaffected — transport-level, stays.                                                                                                                                                                                                                                       |
| `parseTokenCounts`              | `CliIntegration.ts:338` → `WorkflowExecutor.ts:1531`                                                                       | Keep the small legacy statistics helper on `CopilotCliProvider`; headless token usage comes from the shared log-parser mapping.                                                                                                                                              |
| Copilot plain-text fallback     | Formerly `CopilotResponseParser.parsePlainText()`, sets `rawTextOutput: true`                                             | **Dead code, removed.** `CopilotCliProvider.buildHeadlessArgs()` unconditionally adds `--output-format json`; interactive mode uses `-i` and does not flow through the headless response parser.                                       |

### Chicken-and-egg on session log discovery

Log-sourced harnesses must _find_ the log while the run is still in flight — a post-exit one-shot read would forfeit the live-diff payoff that makes them log-sourced in the first place. Interactive solves discovery with `CliInteractiveStartupCoordinator` (451 LOC: SessionStart hook, 60s soft / 5min hard timeout, prompt-text-matching fallback). Headless should **not** adopt that machinery, and the measured timing says it doesn't need to — `session_meta` is on disk at t=0, so discovery is a direct path construction that succeeds on the first attempt:

1. Read the session ID off the first identifying stdout event (Codex `thread.started`).
2. `discoverSessionLog(sessionId)` — direct path construction. Retry on each stdout tick purely as a cheap guard; expect it to resolve immediately.
3. From then on, tail via `readNewLines()` on each tick, per [The stdout contract](#the-stdout-contract).
4. Process exit ends the run; bounded drain; final `extractResponse()`.

No startup coordinator, no notification monitor, no completion detection. Discovery failure degrades to a post-exit read rather than failing the step.

---

## Risks

- ~~**Log-write latency**~~ — **resolved, see [Measured: the log is live](#measured-the-log-is-live).** Log-sourcing costs no measurable latency. Do not re-litigate this as a reason to prefer stdout.
- **Never route OpenCode headless through `export`.** Its "log parser" shells out to `opencode export <sessionId>` on a 1s poll (`OpenCodeLogParser.ts:43`, `:153`, `EXPORT_POLL_INTERVAL_MS`); the "log path" it is handed is the session ID. Sourcing headless from it would add repeated subprocess spawns and a session-ID dependency to obtain data stdout already contains, verbatim. Keep OpenCode stdout-sourced.
- **Antigravity's log parser is now transcript-sourced.** It incrementally tails the per-session authoritative transcript, pairs adjacent planner/result lines, and keeps the shared Go `cli-*.log` only for session and completion markers. The completed rewrite is documented in `../implemented/ANTIGRAVITY_TRANSCRIPT_PARSER_PLAN.md`; the Antigravity phase is no longer blocked on that work.
- **The CLI binary and MCP server run outside VS Code.** `CliExecutionRunner.executeInTerminal():519` falls back to `executeInteractiveCliProcess` when `isVsCodeContext()` is false — i.e. the standalone binaries have no interactive log-monitoring path today, and their headless path is exactly what this plan changes. Log parsers are fs/`os.homedir()`-based and the `setWorkspaceRoot` wiring at `CliIntegration.ts:191-202` is platform-agnostic, so this should work — but it is untested territory and needs explicit coverage.
- **Codex log-sourced means trusting the log for text too, not just diffs.** Today `CodexResponseParser` supplies `agent_message`, `reasoning`, `todo_list`, `web_search`, `mcp_tool_call`, and `command_execution` from the curated stdout stream; log-sourced, all of those must come from `response_item`/`event_msg` instead. `CodexLogParser` already handles them for interactive, so the coverage exists — but headless is currently the only consumer of the stdout vocabulary, so any gap is unexercised. Diff a real headless run's two streams event-for-event before deleting `CodexResponseParser`.

---

## Phased implementation

Each phase is independently shippable and independently revertible. `ICliProvider.responseParser` stays on the interface until the last harness is migrated.

### Phase 0a — Prepare the seam (complete 2026-07-26)

1. Rename `CliResponseParser` → `CliParseUtils` (`extractJsonObjectsFromStream`, `parseJsonLines`, `parseUnifiedDiff`, `formatStatistics`). Update all callers, including the log-side callers and utility test.
2. Add two optional `ICliProvider` members: `parseHeadlessStdout?(stdout): BaseCliEvent[]` (stdout-sourced mode — turns stdout into events the harness's **log parser** understands) and `extractSessionIdFromStdout?(chunk): string | undefined`. A provider with the former is stdout-sourced; a provider with only the latter is log-sourced.
3. Move `isRecoverableSessionError` from `IResponseParser` to `ICliProvider`, retaining the default-false behavior for providers without a provider-level implementation.

**Exit criteria:** no behavior change; every harness still on `responseParser.parse()`.

**Discovery recorded for later phases:** `AntigravityToolEventBuilder` is also a current log-parser consumer of the shared diff utility. Qwen had its own recoverable-session classifier in addition to Claude; both implementations now live on their providers so the runner's retry behavior remains unchanged.

### Phase 0b — Build the log-sourced runtime (complete 2026-07-26)

1. Build `HeadlessLogTail` — the log-sourced runtime. Owns: session-ID capture, retried `discoverSessionLog()`, `readNewLines()` on each stdout tick, the idle-poll backstop, and the post-exit bounded drain. **Session-ID discovery must be pluggable, not stdout-only:** Codex yields it from `thread.started` on stdout, but Antigravity has no stdout session marker and resolves it through the provider's existing `extractSessionIdFromLogs()`. Accept either source (stdout extractor first, provider log lookup as the alternative) or Phase 2 is blocked. It reuses `CliLogEventPump` for per-event streaming and deliberately does **not** reuse `CliLogMonitor` (no completion detection, no notification monitor, no background-work hold — process exit settles it).
2. Teach `CliResponseCollector.collectHeadlessResponse` to select: `parseHeadlessStdout()` → `logParser.extractResponse()`; else `HeadlessLogTail`'s accumulated events → `extractResponse()`; else today's `responseParser.parse()`. All three land in the same `UniversalCliOutput`, so `getHeadlessFailure`, statistics, and session-ID plumbing below it are untouched.
3. Route headless live streaming through `logParser.extractStructuredEventsFromEvent()` for both new modes (`CliTransportCoordinator.ts:337-367` currently calls `responseParser.processStreamingChunk`).

#### Phase 0b API record

`HeadlessLogTail` lives in `src/core/harness/shared/HeadlessLogTail.ts` and is
constructed with `HeadlessLogTailOptions`:

- `parser`, `promptText`, `startTime`, and optional `resolvedSessionId`,
  `workspaceRoot`, and `model` identify the run and its log parser.
- `extractSessionIdFromStdout(chunk)` is the preferred session-ID source;
  `extractSessionIdFromLogs(prompt, start, workspaceRoot)` is the pluggable
  alternative for harnesses such as Antigravity.
- `onStreamingEvents(events)` and optional `onContextWindowUpdate(used, size)`
  receive the `CliLogEventPump` output.
- `start()` begins the 750ms idle backstop and performs the initial read;
  `onStdoutChunk(chunk)` queues an idempotent `readNewLines()` tick;
  `finish()` stops polling, retries discovery once after exit, performs the
  bounded 2-second/150ms drain, and resolves to `HeadlessLogTailResult`.
  `handleStdout()` is an alias for stream adapters. `getEvents()`,
  `getSessionId()`, and `getLogPath()` expose the accumulated state to the
  collector.

The 2-second drain deadline and 150ms poll interval are exported from
`CliLogMonitor.ts` and shared by both runtimes. A failed discovery/read is
logged and treated as an empty source; it never fails the headless step.

`ICliProvider.headlessSource` is an explicit override: `"stdout"` requires
`parseHeadlessStdout()` and feeds each parsed event through
`logParser.extractStructuredEventsFromEvent()`; `"log"` constructs a
`HeadlessLogTail`. When unset, `parseHeadlessStdout()` selects stdout mode and
`extractSessionIdFromStdout()` selects log mode. Providers with neither hook
continue using the existing `responseParser` path, which is the Phase 0
behavior guarantee.

### Phase 1 — Codex, log-sourced (complete 2026-07-26)

Wire Codex to `HeadlessLogTail`. Delete `CodexResponseParser` (663 LOC) **and** `CodexCliProvider.augmentParsedOutput()` together with `applyLoggedChangesToFileEvents()` and its positional per-path cursor logic — with one source there is nothing left to reconcile. Token usage stops needing back-fill too: `event_msg:token_count` streams in like any other event.

Leading with the hardest harness is deliberate. Codex is where log-sourcing pays off most, and it is the only harness that exercises `HeadlessLogTail` end to end. If discovery, tick-driven reads, or drain timing are wrong, they surface here rather than after three easy migrations have baked in bad assumptions.

**Verify:** file diffs render mid-run, not at completion (the actual goal); `add`/`update`/`delete` still map to FILE_WRITE/FILE_EDIT/FILE_DELETE with working undo; text, reasoning, todo lists, web search, MCP calls, and command executions all still appear (see Risks).

**Completion notes:** A real Codex 0.145.0 headless run supplied the golden stdout/log pair. The surprising runtime detail was that `HeadlessLogTail.start()` cannot wait for its first log discovery when the provider obtains its session ID from stdout: doing so waits for a prompt-matching discovery before the CLI has spawned and prevents `thread.started` from ever arriving. Codex's session log then proved to be the authoritative stream: current exec-wrapped tool calls and command results are recorded there, while shell edits do not necessarily produce a native stdout `file_change` body. The tail now starts immediately, captures `thread.started`, and begins log discovery on the first stdout tick.

### Phase 2 — Antigravity, log-sourced — **complete 2026-07-26**

The transcript rewrite and headless migration are complete. `AntigravityLogParser`
now supplies incremental structured events from the per-session transcript while
the Go log continues to provide session and completion markers. Headless mode
routes through `HeadlessLogTail`, using the provider's
`extractSessionIdFromLogs()` because there is no stdout session marker.
The append-only, adjacent-line pairing rules documented in the implemented
parser plan remain the source of truth.

**Verify:** parallel workflows in one workspace attribute events to the right run. The implemented per-session `brain/<sessionId>/` transcript tail provides that isolation instead of relying on shared response content in `cli-*.log`.

### Phase 3 — Copilot, stdout-sourced — **complete 2026-07-26**

Same event vocabulary, so `parseHeadlessStdout` is a JSONL split using
`CliParseUtils`. `CopilotResponseParser` (490 LOC) was deleted, and the
provider now owns only the small legacy statistics helper needed by workflow
token reporting. The stdout `result.sessionId` is the primary session-ID path;
`extractSessionIdFromLogs` remains the fallback. `augmentParsedOutput()` remains
in place because its OTel read is a third-artifact enrichment path.

**Verify:** headless output matches today's for tool calls, file edits, thinking blocks, token usage, and context-window values — the OTel tiers in `augmentParsedOutput` must keep working (see the "wire it into both" gotcha in `harness-cli-providers.instructions.md`).

### Phase 4 — OpenCode, stdout-sourced — **complete 2026-07-26**

`parseHeadlessStdout` is a JSONL split; both parsers already share `OpenCodeEventMapper`, so this is close to mechanical. Delete `OpenCodeResponseParser` (261 LOC). OpenCode's log parser stays as-is for interactive; headless never calls `export`.

The provider now feeds headless JSONL directly through `OpenCodeLogParser`,
extracts the session ID from stdout, and retains legacy token-stat parsing.
Golden-output coverage compares headless stdout with the equivalent interactive
export event shape and asserts that the headless path makes no `export` calls.

### Phase 5 — Claude, stdout-sourced

`parseHeadlessStdout` = `CliParseUtils.extractJsonObjectsFromStream` + field aliasing (`session_id`→`sessionId`, `tool_use_result`→`toolUseResult`) + folding the `result` event into metadata. Both sides already share `ClaudeToolBuilder`. Delete `ClaudeResponseParser` (609 LOC); keep `isRecoverableSessionError` on the provider.

**Watch:** background-work tracking (`trackBackgroundWorkState` / `hasPendingBackgroundWork`) is log-parser state. Confirm it behaves when fed stdout events, or switch Claude to log-sourced if it needs the `attachment` events only the log carries.

### Phase 6 — Qwen

Measure log-vs-stdout richness (the one harness where this is still unknown), then pick a mode. Delete `QwenResponseParser` (384 LOC).

### Phase 7 — Retire the layer

Delete `IResponseParser` / `ResponseParserBase`, drop `responseParser` from `ICliProvider`, remove `processStreamingChunk` plumbing from `CliTransportCoordinator`, delete the per-harness response-parser tests.

---

## Testing

- Per-harness golden-output tests: capture real headless stdout **and** the matching session log from the same run, assert both paths yield equivalent `UniversalCliOutput` (events, ordering, metadata). This is the whole point of the change and should be the primary gate.
- Extend `src/test/integration/mixedModeExecution.integration.test.ts` — mixed headless/interactive workflows are where a mapping divergence would surface as inconsistent timeline rendering.
- Cover the standalone-CLI (non-VS Code) headless path explicitly; it is the least-exercised consumer.
- Regression cases worth pinning now: Codex file-event kinds and diff bodies (`353ad5f0` — the assertions stay, the back-fill they exercise becomes a native log read), Copilot context-window values from OTel, Claude cache-token/context-window math, undo behavior for FILE_WRITE / FILE_EDIT / FILE_DELETE.
- Add a **latency** assertion for log-sourced harnesses: a file diff must reach the output panel before the run completes, not at completion. That is the payoff, and nothing else in the suite would catch its regression.
- Do **not** run `npm run test:harness` as part of this work without asking — it spends real harness quota.

---

## Open questions

1. ~~Is the Codex log delay startup-only or ongoing?~~ **Answered:** neither — the log is written continuously from t=0 and there is no delay. See [Measured: the log is live](#measured-the-log-is-live).
2. ~~Is Copilot's plain-text headless mode still reachable, or is `--output-format json` unconditional now?~~ **Answered in Phase 3:** `buildHeadlessArgs()` always adds `--output-format json`, so headless plain-text output is unreachable. `parsePlainText()` and its `rawTextOutput` path were dead code and were deleted with `CopilotResponseParser`.
3. ~~Is Antigravity's shared `cli-*.log` safe as the sole headless source?~~ **Moot** — it carries no response content; the implemented parser uses the per-session transcript for response events and the Go log only for session/completion markers. See `../implemented/ANTIGRAVITY_TRANSCRIPT_PARSER_PLAN.md`.
4. Is Qwen's log richer than its stdout? The one remaining unmeasured harness.
5. Should `getFinalEventsOnCompletion` and `augmentParsedOutput` merge into one post-completion enrichment hook once both modes share a path? They overlap heavily after this change, and what remains of `augmentParsedOutput` (Copilot's OTel read) is exactly the "fetch from a third artifact after completion" shape `getFinalEventsOnCompletion` already describes.
