# Antigravity Headless `stream-json` Output Plan

**Status:** Implemented — verified July 31, 2026.
**Created:** July 30, 2026
**Revised:** July 31, 2026 (pre-implementation review — see "Review corrections" below)
**Related:** `./ANTIGRAVITY_STATUSLINE_TOKEN_TRACKING_PLAN.md` (implemented; the only
current Antigravity token/context-window source, and remains necessary — see
"What this does NOT replace" below), `dev/implemented/ANTIGRAVITY_TRANSCRIPT_PARSER_PLAN.md`
(the transcript stays the authoritative content source), `dev/implemented/PARSER_UNIFICATION_PLAN.md`
(Phase 2 made Antigravity headless log-sourced via `HeadlessLogTail`; this plan
adds a stdout side-channel on top of that, it does not change the source mode).

---

## Verdict

**Adopt `--output-format stream-json` for Antigravity headless, but as a
stdout side-channel for session ID and token usage — not as a replacement for
the transcript-sourced event pipeline.** Empirically, agy's stream-json
`tool_info` strips exactly the fields ctrlyoke's rich tool/file events depend
on (see "Fidelity gap" below), so switching headless's content source to
stdout would be a regression, not an upgrade. The genuine wins are narrower
than the prompt's framing suggested, but real:

1. **Session ID at t=0, zero file I/O.** The `init` event's `conversation_id`
   is the very first line of stdout — earlier and simpler than the statusline
   snapshot, the `last_conversations.json` cache, or the `cli-*.log` scrape.
2. **A new per-turn usage signal with a field the statusline doesn't have**
   (`thinking_tokens`), obtained natively from the process ctrlyoke is already
   reading, with zero global-settings mutation.
3. **Genuinely incremental text streaming** (`text_delta` chunks arrive
   mid-turn, confirmed below), which the transcript-tail approach cannot
   provide today — transcript entries are only mapped once their `status`
   reaches `DONE` (`AntigravityLogParser.mapTranscriptRecord`), so today's
   "live" text for Antigravity actually updates in whole-message jumps, not
   token-by-token.

**What this does NOT replace:** the statusline lease/sidecar
(`ANTIGRAVITY_STATUSLINE_TOKEN_TRACKING_PLAN.md`) stays, for two reasons that
don't overlap with what stream-json provides:

- It is the **only** signal for interactive mode. `agy --help` documents
  `--output-format` as "Output format for **print mode**" — confirmed there is
  no interactive equivalent.
- Even in headless, stream-json's `usage` objects never include a context
  window **size**, a cumulative **occupancy** total, or `used_percentage` —
  only per-call `input_tokens`/`output_tokens`/`thinking_tokens`/
  `cache_read_tokens`/`total_tokens`. The statusline's `context_window.
  context_window_size` is Antigravity self-reporting its own live window size;
  losing that means falling back to ctrlyoke's static `getAntigravityContextWindowSize()`
  model-lookup table, which goes stale the moment Google ships a model this
  table doesn't know about. See "Context-window fill bar" below for the
  narrower thing stream-json *can* approximate.

So this plan is additive: a new, small stdout-derived enrichment path
alongside the existing transcript pipeline and the existing statusline
sidecar, not a replacement for either.

---

## Empirical findings (agy 1.1.8, live headless runs against `gemini-3.6-flash-low`)

All captured directly via `agy --print "<prompt>" --model gemini-3.6-flash-low
--output-format stream-json [--dangerously-skip-permissions]` in this
workspace — not from docs alone. `agy --help` confirms the flag:
`--output-format   Output format for print mode (text, json, stream-json) (default text)`.

### Event shape

NDJSON on stdout, one `{"event": "...", ...}` object per line:

- **`init`** (once, first line): `conversation_id`, `init.model`, `init.cwd`,
  `init.tools` (full tool-name array), `init.permission_mode`.
- **`step_update`** (many): `step_update.conversation_id`, `step_index`,
  `state` (`ACTIVE` while running, `DONE` on completion), `step_type`
  (`user_input`, `unknown` — an unlabeled internal step present in every run,
  `agent_response`, `tool`, `checkpoint`), plus type-specific fields below.
- **`result`** (once, last line): every field is nested under a `result`
  object — `result.conversation_id`, `result.status` (`"SUCCESS"` in every
  captured run), `result.response` (final text), `result.duration_seconds`,
  `result.num_turns`, and cumulative `result.usage`. **The nesting is
  load-bearing**: an earlier revision of this section listed these as
  top-level fields, and the step-2 implementation duly read `event.usage`,
  which is always `undefined` — the terminal cumulative usage was silently
  never captured, and the unit fixture (written from this prose rather than
  from the wire) passed anyway. Corrected during review against agy 1.1.8:

```json
{"event":"result","result":{"conversation_id":"01a4f023-...","status":"SUCCESS","response":"pong\n","duration_seconds":1.6169349,"num_turns":1,"usage":{"input_tokens":9780,"output_tokens":4,"thinking_tokens":0,"cache_read_tokens":8140,"total_tokens":9784}}}
```

  Note the contrast that made this easy to get wrong: `init` really does carry
  `conversation_id` at the **top** level, while `result` carries it nested.
  Also verified: agy terminates stdout with a trailing newline, so the final
  line always arrives complete — the accumulator's `flush()` is a safety net
  for truncated output, not a hot path.

Real `agent_response` step (trivial "reply with pong" prompt):

```json
{"event":"step_update","step_update":{"conversation_id":"73b9d054-...","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"pong"}}
{"event":"step_update","step_update":{"conversation_id":"73b9d054-...","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"\n","duration_seconds":0.7197045,"usage":{"input_tokens":17831,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":17832}}}
```

Real `tool` step (shell command):

```json
{"event":"step_update","step_update":{"conversation_id":"1ebe2475-...","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello-from-agy-tool-test"}}}}
{"event":"step_update","step_update":{"conversation_id":"1ebe2475-...","step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.9743698,"tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello-from-agy-tool-test"},"output":"hello-from-agy-tool-test\r\n"}}}
```

`checkpoint` steps (agy's own context-management pass, matching the
transcript's `SYSTEM`/`CHECKPOINT` entries) also carry a small `usage` block
— e.g. `{"input_tokens":99,"output_tokens":3,...}` — confirming usage is
reported per model call, not just per user-visible turn.

### Fidelity gap: `tool_info.parameters` omits content, diffs, and exit codes

This is the load-bearing finding against using stream-json as the content
source. Compared directly against the transcript for the **same
conversation** (`brain/<id>/.system_generated/logs/transcript_full.jsonl`):

| Tool call                | stream-json `tool_info.parameters`                        | Transcript `PLANNER_RESPONSE.tool_calls[].args`                                              |
| ------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `write_to_file`           | `{"TargetFile": "..."}`  — **no content field at all**      | `{"CodeContent": "hello world", "Overwrite": true, "TargetFile": "...", "Description": "..."}` |
| `replace_file_content`    | `{"TargetFile": "..."}`  — **no replacement chunks**         | Full structured replacement content (consumed by `AntigravityToolEventBuilder.ts:231`'s `CodeContent`/`content`/`file_text` lookup) |
| `run_command` (failing)   | `{"CommandLine": "..."}` in, `{"output": "<merged stdout+stderr text>"}` out — **no exit code field**, error folded into free text | Transcript entries carry richer structured status the mapper uses for `BASH_COMMAND` success/failure |

`AntigravityToolEventBuilder.ts:231` reads `CodeContent` (aliased to
`content`/`file_text`) directly from the planner's `tool_calls[].args` — a
field stream-json's `tool_info.parameters` simply does not include for either
`write_to_file` or `replace_file_content` in any captured run. This was
verified three times (a create, an edit, and a failing command), not assumed
from one sample. If Antigravity ever changes this and starts including full
content/diffs in `tool_info`, this verdict should be re-run — but as shipped
today, switching the content source to stream-json would make every
Antigravity file-write/file-edit event lose its diff, which is the single
richest event type in ctrlyoke's timeline UI. `PARSER_UNIFICATION_PLAN.md`'s
own decision rule applies directly here: **choose the source on fidelity,
and the transcript is unambiguously richer for content.**

### Streaming is genuinely incremental, not just chunked-on-completion

Timestamped capture (`echo streaming-test-line-1 && echo streaming-test-line-2`):

```
20:14:44.590  step_index 5 ACTIVE  text_delta: "The command has been executed successfully.\n\n**Output:**\n```\nstreaming-test-line-1\ns"
20:14:44.787  step_index 5 DONE    text_delta: "treaming-test-line-2\n```\n"
```

The word "streaming" is split mid-token across two deltas 197ms apart — this
is real incremental generation, not two full copies of the same text. This is
a strictly new capability: the transcript only ever contains an entry once
its `status` is `DONE` (`AntigravityLogParser.mapTranscriptRecord`'s guard:
`if (entry.status !== "DONE" && !isBackgroundLaunch && !isGenericRunning)
return [];`), so today's "live" Antigravity text updates in whole-message
jumps at transcript-flush granularity, never token-by-token.

### `step_update` usage is per-call, not cumulative context occupancy

Across a 3-tool-call run, each `agent_response`/`tool`/`checkpoint` step
reports its own `input_tokens`/`output_tokens`, and the terminal `result.usage`
is close to (not exactly, likely due to rounding/step overlap) the sum of the
individual steps — e.g. one run's steps summed to ~36.3k while `result.usage.
input_tokens` reported 36464. This is the same shape as the statusline's
`context_window.current_usage` (last-turn breakdown), **not** the statusline's
`context_window.total_input_tokens`/`context_window_size` (cumulative
occupancy) — those two statusline fields have no stream-json equivalent.

**A usable proxy exists, but isn't identical to the statusline's number.**
Because agy resends full conversation history each call (visible as growing
`cache_read_tokens` across turns — 0 → 8140 → 20345 → 32547 in one captured
run), `input_tokens + cache_read_tokens` for the latest step approximates
"total context length at that call," which is what the live-context-fill bar
needs as its `used` value. What it still can't supply is `size` (the model's
max window) — that requires either `getAntigravityContextWindowSize(model)`
(today's existing static fallback table) or the statusline's live
self-reported `context_window_size`. Whether to accept the static-table
fallback for headless (dropping the statusline dependency for the fill bar
too) or keep requiring the statusline for `size` is a product call, not a
technical blocker — see "Decision needed" below.

### No interactive equivalent; failure/error output untested

- `--output-format` is documented and behaves as print-mode-only; no
  `-i`/`--prompt-interactive` stream-json variant exists.
- `result.status` was `"SUCCESS"` in every run, including a run whose only
  tool call was a failing shell command the model then explained in prose —
  agy itself never surfaced a run-level failure in testing. What `status`
  reads on a genuine agy-level error (auth failure, quota exceeded,
  `--print-timeout` exceeded) was not exercised — flagged as an open question,
  not resolved here. `CliResponseCollector.getHeadlessFailure()` is
  exit-code/stderr-driven and format-agnostic, so this is not a blocker for
  adoption, just an untested edge worth a spot-check during implementation.

---

## Review corrections (July 31, 2026)

Four corrections found by reading the code this plan touches. They change the
design in section 1–3 below; the verdict and empirical findings above are
unchanged and were re-confirmed (`agy --version` → 1.1.8, `agy --help` still
documents `--output-format ... (text, json, stream-json)`).

1. **No new `thinkingTokens` field — map `thinking_tokens` onto the existing
   `TokenUsage.reasoningOutputTokens`** (`src/types/CliOutputTypes.ts:385`).
   That field already exists for exactly this concept (currently documented
   "Codex only", set by `CodexLogParser`). Adding a parallel `thinkingTokens`
   would duplicate a shared contract field. Update the doc comment to name
   both harnesses. Note honestly: nothing in `src/ui/` reads
   `reasoningOutputTokens` today, so this captures the value into the shared
   contract without adding a UI surface — that is the intended scope.
2. **The stdout side-channel must buffer partial lines; a pure
   `parseStreamJsonLine(line)` alone is not sufficient.** stdout arrives in
   arbitrary chunks (`CliTransportCoordinator.executeHeadless`'s `onStdout`
   forwards raw chunk strings), so NDJSON lines split across chunk
   boundaries. The `result` line carrying cumulative usage is the last and
   longest line of the stream and is therefore the most likely to be split —
   a stateless per-chunk split would silently drop it. The module needs a
   small stateful accumulator that retains the trailing incomplete line
   between chunks, plus a `flush()`/reset. Because `AntigravityCliProvider`
   instances are reused across prompts within one workflow (same reason
   `statusLineToken`/`statusLineSidecar` are reset there), the accumulator
   must be reset in `buildCliArgs()` alongside the other per-prompt state.
3. **The seam needs a matching `ICliProvider` member, not just a
   `HeadlessLogTailOptions` field.** `HeadlessLogTail` is constructed by
   `CliExecutionRunner.createHeadlessStreamingSource()`, which builds its
   options exclusively from `ICliProvider` members (`extractSessionIdFromStdout`,
   `extractSessionIdFromLogs`, …). So this resolves the third Open Question:
   add optional `ICliProvider.observeHeadlessStdout?(chunk: string): void`,
   bound through the runner into a new
   `HeadlessLogTailOptions.onStdoutChunkObserved?: (chunk: string) => void`,
   invoked from `HeadlessLogTail.onStdoutChunk`. It must fire for **every**
   chunk — unlike `captureSessionId`, which is deliberately skipped once a
   session ID is known.
4. **Confirmed: flipping the stdout format cannot leak NDJSON into the UI.**
   `CliTransportCoordinator.executeHeadless()` routes `onStdout` to
   `source.logTail.onStdoutChunk(chunk)` whenever `source.mode === "log"`, and
   only calls `hostCallbacks.onStreamingChunk(chunk)` in the no-source branch.
   Antigravity always gets a log-mode source (`headlessSource = "log"` plus a
   non-null `logParser`), so its raw headless stdout is already used purely as
   a clock and never rendered — despite `config.shouldStreamHeadlessOutput`
   being `true`. This is the specific path the section-1 claim depends on.

---

## Proposed Design

### 1. Add the flag, gated as an enrichment source only

`AntigravityCliProvider.buildHeadlessArgs()` adds `"--output-format",
"stream-json"` unconditionally for headless runs (this method already only
applies to `--print` invocations). This does not change `headlessSource`,
which stays `"log"` — the transcript remains authoritative for
`extractResponse()`/`extractStructuredEventsFromEvent()`. Confirmed no
existing code depends on Antigravity's default plain-text headless stdout
shape (`CliResponseCollector.getHeadlessFailure()` is exit-code/stderr driven
and format-agnostic; `HeadlessLogTail.onStdoutChunk` today only uses
Antigravity's stdout as an untyped tick trigger since the provider doesn't
implement `extractSessionIdFromStdout` yet).

### 2. Session ID: implement `extractSessionIdFromStdout`

Add `AntigravityCliProvider.extractSessionIdFromStdout(chunk)`: parse `chunk`
line-by-line, return the first `init.conversation_id` found. This is the
exact pluggable seam `HeadlessLogTail` already has
(`HeadlessLogTailOptions.extractSessionIdFromStdout`,
`PARSER_UNIFICATION_PLAN.md` Phase 0b) — no new plumbing required, just an
implementation. Per `HeadlessLogTail.start()`'s existing comment, this cannot
resolve pre-spawn; it fires on the first post-spawn stdout tick, which for
agy is the very first line written, faster than any of today's three
session-ID paths (statusline snapshot write, `last_conversations.json`, log
scrape). `AntigravityCliProvider.extractSessionIdFromLogs()` keeps its
existing statusline-snapshot / cache / log-scrape fallback chain unchanged —
this is a faster primary path layered in front via `HeadlessLogTail`'s
existing `extractSessionIdFromStdout`-first, `extractSessionIdFromLogs`-second
resolution order, not a replacement of the fallback chain itself.

### 3. Usage: a new stdout-parsed side-channel, additive to the statusline

New small module `AntigravityStreamJsonUsage.ts` exposing a pure
`parseStreamJsonLine(line: string): { conversationId?: string; usage?: {...};
stepType?: string } | undefined` **plus** a stateful accumulator class that
owns the partial-line buffer and the latest-usage state (see review
correction 2 — a pure per-chunk function loses lines split across chunk
boundaries). `HeadlessLogTailOptions` gains
`onStdoutChunkObserved?: (chunk: string) => void`, bound by
`CliExecutionRunner` from the new optional
`ICliProvider.observeHeadlessStdout?(chunk)` (review correction 3) and
invoked from `onStdoutChunk` alongside the existing
`captureSessionId` call — a narrow, provider-specific hook, not a general
"parse stdout for content" escape hatch, so it must not become a second event
mapping (`PARSER_UNIFICATION_PLAN.md`'s core invariant). Antigravity's
implementation accumulates the latest per-step usage and calls the same
`onContextWindowUpdate`/usage-merge path the statusline sidecar already
feeds — reuse `AntigravityLogParser.extractTokenUsage()`'s merge point rather
than adding a second usage field on `UniversalCliOutput.metadata`.

**Gated behind the same toggle, not independent.** Consistent with "fill bar
stays statusline-only" below: the stream-json usage side-channel only runs
when `permissions.antigravityStatusLineTracking` is enabled. A user who
disables the toggle opts out of Antigravity token/context tracking entirely —
the setting stays the single, honest answer to "does ctrlyoke track this or
not," rather than leaving a confusing partial state where turning it off
still shows some numbers. When enabled, precedence between the two sources
for a given prompt: statusline snapshot's `current_usage` wins for
`contextWindowUsedTokens`/`contextWindowSize` (self-reported, includes the
live window size); stream-json's usage is the sole source for
`reasoningOutputTokens` (from `thinking_tokens` — the statusline doesn't have
it; see review correction 1) and is the fallback per-turn breakdown for any
prompt where the statusline sidecar hasn't produced a snapshot yet (e.g. the
very first poll tick of a short run).

### 4. Live text: cut

**Decided: not doing this.** `text_delta` live-typing preview would need a
de-dup design against the transcript's own `DONE`-gated text (see section 4's
original analysis in the research above) for payoff that's mostly cosmetic —
Antigravity responses already render at transcript-flush granularity, which
is sub-second per chunk in every capture above. Not worth the complexity.
Session ID (section 2) and usage (section 3) are the two pieces this plan
implements.

---

## What this does NOT replace (recap)

- The statusline lease, wrapper script, and sidecar
  (`ANTIGRAVITY_STATUSLINE_TOKEN_TRACKING_PLAN.md`) — still the only signal
  for interactive mode, and still the only *self-reporting* source for the
  model's actual context window size in headless mode.
- The transcript as the event/content source — `headlessSource` stays `"log"`;
  `AntigravityLogParser.extractStructuredEventsFromEvent()`,
  `AntigravityToolEventBuilder`, background-task tracking, checkpoint/
  compaction detection, and the unified-diff mapping are all unchanged.
- `discoverSessionLog()`/the transcript-log-tail mechanics — unaffected;
  stream-json only makes the session ID available sooner, it doesn't change
  how the transcript itself is found or read.

## Step 1 implementation record (July 31, 2026)

Step 1 is complete. Antigravity headless arguments now unconditionally include
`--output-format stream-json`; interactive arguments remain unchanged. The
provider extracts only the first valid `conversation_id` from an `init` event,
while malformed or non-JSON lines are ignored. `headlessSource` remains
`"log"`, so `HeadlessLogTail` still uses stdout only for the early session-ID
lookup and the transcript for response/events.

The required live verification used `gemini-3.6-flash-low`. The first stdout
line carried `conversation_id`
`fdf30699-cc25-456b-bfb6-64cbc4ec7a34`, and the matching
`brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl` contained
completed `USER_INPUT`, `PLANNER_RESPONSE`, and baseline `CHECKPOINT` records.
This confirmed the faster stdout session-ID path without changing the
transcript-sourced event path. Nothing in the run contradicted the plan; the
`result.status` failure behavior remains an open question for step 3.

## Step 2 implementation record (July 31, 2026)

Step 2 is complete. Headless stdout now feeds a provider-specific usage
observer while the transcript remains the sole event/content source. The
observer runs synchronously for every stdout chunk, and the accumulator keeps
the trailing partial NDJSON line so a split terminal `result` event cannot be
lost. Its normalized snapshot retains both the latest per-step usage and the
terminal cumulative usage; the latest step wins field-by-field when both are
available, with the terminal result filling missing fields. The parser receives
that snapshot through an explicit setter, and `thinking_tokens` maps to the
existing `TokenUsage.reasoningOutputTokens` field. The statusline toggle gates
the complete usage side-channel and per-prompt reset clears both accumulator
and parser state. No live `text_delta` preview was added.

---

## Decision: fill bar stays statusline-only

**Decided: do nothing extra here.** When the statusline feature is disabled
(`permissions.antigravityStatusLineTracking: false`), the live context-fill
bar simply stays unavailable in headless too — same as today's behavior with
no statusline signal at all. Headless does **not** fall back to approximating
`used` from `input_tokens + cache_read_tokens` (stream-json) against the
static `getAntigravityContextWindowSize(model)` table. Reasoning: that
fallback would silently show a context-window percentage against a hardcoded
size table that can drift the moment Google ships a model ctrlyoke doesn't
know about yet, and the statusline toggle already exists as the one clear
switch for this class of data — better to keep it as the single source of
truth than to have a degraded, table-dependent shadow path. The Advanced
Permissions settings UI (`AdvancedPermissionsSection.tsx`) now surfaces a
warning when the toggle is off, explaining that it's required for both
context-window and token-usage tracking, so this isn't a silent gap.

## Step 3 verification record (July 31, 2026)

The failure path was exercised with the installed agy 1.1.8 binary using the
required `gemini-3.6-flash-low` model. A `--print-timeout 1ms` run emitted an
`init` event followed by `result.status: "ERROR"` and `error: "timeout waiting
for response"`, with exit code `1` and empty stderr. An invalid `--effort` run
also emitted `result.status: "ERROR"` and exited `1`. Because
`CliResponseCollector.getHeadlessFailure()` returns a process-exit failure
before its `stdout.trim() || parsedOutput.events.length > 0` check, the NDJSON
stdout did not change failure detection. That early return remains harmless
for exit-code-zero stderr handling because Antigravity's genuine failures
observed here were non-zero exits.

A successful real headless run returned exit code `0` and
`result.status: "SUCCESS"`, with conversation ID
`b4fc19ec-81bb-490f-b812-f106938c2660` in its first stdout line. The matching
transcript contained a completed
`PLANNER_RESPONSE` with the full `CodeContent` for the `write_to_file` call,
while stream-json exposed only its target path. The run also populated
per-step and terminal token usage, including `thinking_tokens`, confirming the
transcript remains the content/fidelity source and stdout remains an
enrichment side-channel. Re-confirming `headlessSource = "log"` and
`CliTransportCoordinator.executeHeadless()` showed raw NDJSON still goes to
`HeadlessLogTail` and not `hostCallbacks.onStreamingChunk`; debug raw-output
logging and stderr sanitization remain diagnostic/failure paths only.

The existing disabled-toggle coverage was re-confirmed: with
`permissions.antigravityStatusLineTracking: false`,
`AntigravityCliProvider.observeHeadlessStdout()` clears the stream-json
snapshot and parsed output has no token/context usage, while statusline
settings and environment tracking remain untouched. The fill bar therefore
stays unavailable, as decided above.

---

## Open Questions

- What does `result.status` read on a genuine agy-level failure (auth error,
  quota exhaustion, `--print-timeout` exceeded)? **Resolved July 31, 2026:** a
  real `--print-timeout 1ms` run with `--model gemini-3.6-flash-low` emitted a
  terminal `result.status` of `"ERROR"` with `error: "timeout waiting for
  response"` and exited with code `1` (stderr was empty). An invalid `--effort`
  run with the same required Flash model produced the same `"ERROR"` status
  and exit code `1`. `CliResponseCollector.getHeadlessFailure()` therefore
  correctly classifies the failure from the non-zero exit code; it does not
  depend on the result status or assume prose stdout.
- Does `--json-schema` interact with `--output-format stream-json` in any way
  ctrlyoke would care about? Out of scope — ctrlyoke doesn't use
  `--json-schema` today and this plan doesn't propose adding it.
- ~~Exact name/shape of the new `HeadlessLogTailOptions` side-channel callback
  (step 3)~~ — **resolved** by review correction 3:
  `ICliProvider.observeHeadlessStdout?(chunk)` →
  `HeadlessLogTailOptions.onStdoutChunkObserved`.

---

## Implementation Steps (proposed order)

1. **[x] `buildHeadlessArgs` flag + stdout session-ID.** Add `--output-format
   stream-json`; implement `extractSessionIdFromStdout`. Verify against a
   real headless run that `HeadlessLogTail` picks up the session ID from the
   first stdout tick and that transcript-sourced events are unaffected. Done
   July 31, 2026; the live run confirmed both paths.
2. **[x] Stream-json usage side-channel.** New `AntigravityStreamJsonUsage.ts`
   (pure line parser + stateful chunk accumulator); add
   `ICliProvider.observeHeadlessStdout` and
   `HeadlessLogTailOptions.onStdoutChunkObserved` and bind them in
   `CliExecutionRunner`; wire into `AntigravityLogParser.extractTokenUsage()`'s
   merge point per the precedence rule in section 3, mapping `thinking_tokens`
   to `TokenUsage.reasoningOutputTokens`. Unit tests on the parser (real
   captured payloads above as fixtures, including a chunk boundary that splits
   a line) and on the merge precedence. Done July 31, 2026.
3. **[x] Verify no regression to failure detection or plain-text assumptions.**
   `getHeadlessFailure()` remains exit-code/stderr driven: its stdout early
   return is only reached for exit code `0`, while genuine agy-level failures
   exit `1`, so NDJSON cannot mask the failure. `CliTransportCoordinator`
   still routes Antigravity's log-mode stdout only to `HeadlessLogTail`; raw
   NDJSON is not sent to `hostCallbacks.onStreamingChunk`. Raw-output debug
   logging remains an intentional diagnostic string, and
   `sanitizeTerminalOutput` is applied to stderr/failure messages, not used to
   parse the stream. A real timeout and invalid-effort run both confirmed
   exit code `1` and `result.status: "ERROR"`; see the resolved question above.
   Done July 31, 2026.
4. ~~**(Optional, follow-up) Live text preview**~~ — **rejected**, see
   section 4 above. Do not implement.

Verification gate for every step: `npm run typecheck`, `npm run lint`,
`npm test`. Never `npm run test:harness` without asking (spends real harness
quota).
