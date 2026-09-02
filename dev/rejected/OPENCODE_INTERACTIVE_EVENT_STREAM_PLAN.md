# OpenCode Interactive Event Stream Plan

**Status:** Reverted — see [Reverted](#reverted-2026-09-02) below
**Priority:** P2

## Background

Investigation of a real missing-output bug (session `ses_fd594d718ffe9SDis6A9u3ZnPD`,
run `completion-control-style-2026-08-22T13-38-41-050/run-2026-08-22T17-00-55-919Z`)
found that `OpenCodeLogParser`'s interactive-mode polling loop calls
`opencode export <sessionId>` once per second, and that command re-dumps the
**entire** session transcript every time (not a tail). Node's `execFile` default
`maxBuffer` (1 MiB) was exceeded once the transcript grew past it; every
subsequent poll then failed with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and
`fetchNewEvents` silently returned `[]` (logged at `debug`, easy to miss). The
session's Stop notification (a separate channel — the `ctrlyoke-opencode-plugin`
watching `session.idle`) fired independently and the run was marked complete,
missing ~7 minutes / 1193 failed polls of real model output.

**Interim fix already shipped** (`src/core/harness/opencode/OpenCodeLogParser.ts`):
`runOpenCodeExport()` now sets `maxBuffer: 100 * 1024 * 1024` (100 MiB) and the
swallowed failure logs at `warn` instead of `debug`. This raises the ceiling
substantially but does not remove it — a long-running session with large tool
outputs/diffs can still exceed 100 MiB, and re-fetching + re-parsing the whole
transcript every second gets more expensive (CPU, not just memory) as the
session grows, regardless of the buffer size. This doc is the permanent,
architectural fix: stop re-fetching the whole transcript at all.

## Root design problem

`opencode export` has no incremental flags (verified via `opencode export --help`
— no `--since`/`--after`/`--limit`) and is not append-only JSONL; there is no
line/offset to resume from client-side. Any client-side "remember the last line"
scheme is impossible against this command as it exists today.

## What actually supports incremental reads (verified against local opencode source at `C:\dev\opencode` and a locally-run `opencode serve` instance's live OpenAPI spec at `/doc`)

OpenCode's HTTP server (the same server the TUI embeds — see below) exposes a v2
session API (`packages/protocol/src/groups/session.ts` in the opencode monorepo)
with exactly the cursor semantics we want:

- `GET /api/session/:sessionID/history?after=<seq>` — **not** SSE, a plain JSON
  page: `{ data: SessionEvent.Durable[], hasMore: boolean }`. `after` is an
  exclusive, monotonically increasing integer aggregate sequence
  (`NonNegativeInt`), one per session. This is a drop-in replacement for the
  current poll loop shape: same 1s interval, just pass `after: <lastSeq>`
  instead of re-parsing a full export, and follow `hasMore` for catch-up pages.
- `GET /api/session/:sessionID/event?after=<seq>` — the SSE variant of the same
  durable event log ("replay durable events after an aggregate sequence, then
  continue with new durable events"). More work to consume correctly (needs
  reconnect/backoff handling) and not needed: the plain `history` endpoint
  gives us the same data with our existing polling architecture unchanged.
  **Prefer `history` over `event` for this reason.**

Verified live: I started `opencode serve --port <n>` locally and fetched its
real `/doc` OpenAPI document, confirming both routes exist and are wired in the
currently-installed `opencode-ai` CLI (matches the `>=1.18.10` version this repo
already declares as verified for OpenCode elsewhere).

**Update (2026-08-31), verified end-to-end, not just against the OpenAPI doc:**
drove a real session through the server — `POST /api/session` (response wrapped
in `{data: {...}}`), `POST /api/session/:sessionID/prompt` with a plain
`{prompt: {text: "..."}}` body, then `GET /api/session/:sessionID/history?after=0`
— on CLI `1.18.25`. The response shape matches this doc's prediction exactly,
with no wrapping surprise: `{data: SessionEvent.Durable[], hasMore: boolean}`
at the top level (unlike the session-create response, this one is *not*
double-wrapped). A real run produced this exact sequence of `type` values in
order: `session.next.prompt.admitted` → `session.next.prompted` →
`session.next.step.started` → `session.next.text.started` →
`session.next.text.ended` → `session.next.step.ended`, each with a
monotonically increasing `durable.seq` (1 through 6) — confirming the cursor
semantics described above on a live payload, not just the schema. Tool-call and
reasoning-part event shapes (`session.next.tool.*`, `session.next.reasoning.*`)
were not exercised by this particular probe (the test prompt didn't trigger a
tool call, and the model used didn't stream a distinct reasoning part on this
turn) — still unconfirmed against a live `history` payload, though their
shapes in `packages/schema/src/session-event.ts` mirror the now-confirmed
`text.started`/`text.ended` pairing closely enough to be low-risk.

### Event shapes (`packages/schema/src/session-event.ts`)

`SessionEvent.Durable` is a discriminated union (`type` tag) including
`session.next.text.ended` (full text for a completed segment),
`session.next.tool.called` / `.progress` / `.success` / `.failed` (structured
`content`/`result`), `session.next.step.ended` (carries `finish: string`,
`cost`, `tokens.{input,output,reasoning,cache.{read,write}}` —
**confirmed on a live payload (2026-08-31, CLI `1.18.25`): `finish` is
literally `"stop"`**, matching today's `part.reason === "stop"` check
one-to-one, so `isComplete`'s re-derivation below can rely on the literal
string, not a guess), `session.next.reasoning.ended`, `session.next.compaction.*`,
`session.next.retried`, etc. This is materially different from
`opencode export`'s `{ info, parts }` shape that `OpenCodeEventMapper.ts` /
`OpenCodeLogParser.extractNewEventsFromExport` currently consume — mapping
every one of `isComplete`, `extractContentFromEvent`, `extractResponse`,
`extractLiveContextWindow`, `extractSessionId`, `classifyUserEvent`,
`extractUserSteerText`, and the streaming `extractCliEventsFromLogEntry`-
equivalent path onto the new event shapes is the bulk of the implementation
work, not the HTTP call itself.

A real captured `session.next.step.ended` event (2026-08-31, CLI `1.18.25`):

```json
{
  "id": "evt_...", "type": "session.next.step.ended",
  "durable": { "aggregateID": "ses_...", "seq": 6, "version": 2 },
  "data": {
    "timestamp": 1788214171834, "sessionID": "ses_...",
    "assistantMessageID": "msg_...", "finish": "stop", "cost": 0,
    "tokens": { "input": 3396, "output": 76, "reasoning": 138,
                "cache": { "read": 0, "write": 0 } }
  }
}
```

**Important gap this reveals: `data.tokens` here has no `total` field**, unlike
`opencode export`'s `step-finish` part, which does carry `tokens.total`
directly. `extractLiveContextWindow`'s `lastStepTotal` tracking (today reading
`part.tokens.total` verbatim, see `OpenCodeLogParser.ts:214-223`) cannot just
be pointed at this new shape — it will need to **derive** the total itself.
Per the exact identity confirmed against five live `opencode run` captures in
[`TOKEN_TOTAL_CACHE_NORMALIZATION_PLAN.md`'s OpenCode deep
dive](TOKEN_TOTAL_CACHE_NORMALIZATION_PLAN.md#opencode-deep-dive-reasoning-tokens-confirmed-as-included-in-output),
`total = input + output + reasoning + cache.read + cache.write` always holds
exactly, so this is a one-line sum, not a new unknown — but it is a real code
difference between the `export` and `history` paths that step 3 below must
account for, not an oversight to leave unhandled.

Also note a field-shape difference in `session.next.step.started`'s `data`:
model is a nested object, `{"model": {"id": "ling-3.0-flash-fin-free",
"providerID": "opencode"}}`, where `opencode export`'s parts carry a flat
`part.model` string — another concrete instance of the "mapping onto the new
event shapes is the bulk of the work" point above, not just a generic warning.

### Step 3 mapping implementation

The pure durable-event mapping functions now live in
`src/core/harness/opencode/OpenCodeEventMapper.ts`:
`mapOpenCodeDurableEventToBaseCliEvent` maps one event, while
`mapOpenCodeDurableEventsToBaseCliEvents` correlates tool lifecycle records by
`callID` so the terminal event retains the called tool's name and input before
the existing export-shaped tool mapper consumes it. The step-ended mapper
adds `tokens.total` using
`input + output + reasoning + cache.read + cache.write`; prompt admission and
text/reasoning start markers are intentionally non-displayable boundaries.

The live fixture coverage is limited to the captured `step.ended` payload and
the captured six-event type sequence (prompt admitted/prompted, step started,
text started/ended, step ended) from the 2026-08-31 CLI 1.18.25 run. Tool
called/progress/success/failed, reasoning started/ended, retry, compaction,
and step-failed mappings use constructed schema-shaped fixtures because the
live run did not exercise tool calls or a distinct reasoning part. The next
step can wire these functions into the history polling path without changing
the export mapper's contract.

## Headless mode is unaffected — do not change it

`opencode run` (`packages/opencode/src/cli/cmd/run.ts`, used for ctrlyoke's
headless execution) never calls `Server.listen` at all; it drives the session
in-process via `AppRuntime`/`InstanceRuntime` and streams full JSON to stdout
directly. There is no export polling and no unbounded-payload risk there today.
This plan only touches the interactive-mode path
(`usesInteractiveNotificationMonitor: true` / `OpenCodeLogParser.watchLogFile`).

## The blocker: the interactive TUI's server is not reachable by default

Read `packages/opencode/src/cli/cmd/tui.ts` and `packages/opencode/src/cli/tui/worker.ts`:
the TUI always spins up an embedded server (`Server.listen`) inside a Node
`Worker` thread, but by default it is **not** bound to a real network socket —
the TUI talks to it purely in-process via an RPC bridge
(`transport = { url: "http://opencode.internal", fetch: createWorkerFetch(client), events: createEventSource(client) }`).
A real, externally-reachable HTTP listener is only created when the launching
command line includes `--port`, `--hostname`, or an mdns flag
(`const external = hasArg("--port") || hasArg("--hostname") || network.mdns === true`).
Ctrlyoke (a separate OS process talking over the CLI's stdout via PTY) has no
way to reach the in-process worker RPC — **ctrlyoke must pass an explicit
`--port <port> --hostname 127.0.0.1` when spawning the interactive OpenCode
process** for this plan to work at all.

### Auth

`packages/opencode/src/server/auth.ts`: the server requires Basic auth only if
`OPENCODE_SERVER_PASSWORD` is set (`ServerAuth.required()`). Ctrlyoke must not
set that env var when spawning OpenCode, so the loopback server stays
unauthenticated for our own polling client — consistent with the trust model
already used elsewhere in the interactive harnesses, but note it explicitly:
**this opens an unauthenticated local HTTP listener, bound to 127.0.0.1, for
the lifetime of every interactive OpenCode session** (it does not exist today
for a plain interactive spawn with no `--port`). Confirmed acceptable by
@nhickster given loopback-only binding, on condition of correct per-instance
port allocation (see below).

### Concurrency: many OpenCode sessions run at once in the same workspace

Ctrlyoke can and does run multiple concurrent OpenCode harness instances in the
same workspace. Each spawned interactive process needs its **own** free port —
there is no evidence in the opencode source of a "find me any free port and
tell me which one" mode usable cross-process (passing `--port 0` only helps the
_in-process_ worker pick an ephemeral port; that choice is never surfaced to
stdout/PTY or any discoverable file, so an external process cannot learn it).
The practical approach: **ctrlyoke allocates a free TCP port itself** (bind to
port 0 on 127.0.0.1, read the OS-assigned port, close the probe socket, then
pass that exact port via `--port`) before spawning each interactive OpenCode
process, so the port is known up front rather than discovered. No existing
free-port helper exists in this codebase (`src/utils` has none) — this needs a
small new utility, with a bind-time `EADDRINUSE` retry (re-probe a new port) to
cover the inherent TOCTOU race of "probe-then-reuse".

## Scope (implementation outline for whoever picks this up)

1. Add `src/utils/FreePortAllocator.ts` exporting
   `allocateLoopbackPort()`. It probes a loopback port without internal retry;
   callers should invoke it again if the real process later reports
   `EADDRINUSE`.
2. `OpenCodeCliProvider.planCliArgs()` now calls
   `allocateLoopbackPort(): Promise<number>` only for interactive executions,
   appends `--port <port> --hostname 127.0.0.1`, and leaves headless args
   unchanged. The prepared execution mutation stores
   `interactiveServerBaseUrl: string | undefined` as
   `http://127.0.0.1:<port>` (or `undefined` for headless mode or allocation
   failure), and `OpenCodeLogParser` receives it through the constructor
   callback `getServerBaseUrl: () => string | undefined`, alongside the
   existing context-window callback. `OPENCODE_SERVER_PASSWORD` is not set.
3. `OpenCodeLogParser`: replace `fetchNewEvents`'s `opencode export` call with
   a polling loop against `GET http://<hostname>:<port>/api/session/<id>/history?after=<lastSeq>`,
   tracking `lastSeq` (an integer) instead of `seenPartIds`. Follow `hasMore`
   within a single poll tick before waiting for the next interval. Map each
   `SessionEvent.Durable` variant onto the existing `BaseCliEvent` contract —
   this is the bulk of the work; expect to rewrite most of
   `OpenCodeEventMapper.ts` alongside `extractNewEventsFromExport`'s
   replacement, and to re-derive `isComplete` from `session.next.step.ended`'s
   `finish` field, now confirmed literally `"stop"` on a live payload (see
   Event shapes above — no longer a guess to verify). While rewriting this
   path, also derive `lastStepTotal`/`contextWindowUsedTokens` as
   `input + output + reasoning + cache.read + cache.write` rather than reading
   a `tokens.total` field — the `history` endpoint's `step.ended` event has no
   `total` field at all, unlike `opencode export`'s `step-finish` part (see
   Event shapes above).
4. Keep `opencode export` as an explicit **fallback path**: if the server
   fails to bind (port race exhausted), or the `history` endpoint 404s /
   errors (older CLI versions predating this API), fall back to the current
   export-polling implementation rather than failing the run. Treat this as a
   capability-gated feature, not a hard requirement — do not raise the
   documented minimum OpenCode CLI version without evidence real users are
   all above the line where `/api/session/:id/history` exists.
5. Document the new dual-path (server-backed history vs. export fallback) in
   `.github/instructions/harness-cli-providers.instructions.md`. Review
   `OpenCodeNotificationMonitor` and `OpenCodeCliProvider.capabilities` for a
   meaningful capability fact, but do not add a field outside the shared
   capability schema; the current history/export choice is an internal parser
   mechanism rather than a user-facing capability domain.
6. New/updated tests: `src/test/suite/harness/LogParsers.test.ts` (event
   mapping for every `SessionEvent.Durable` variant, cursor/`hasMore` paging,
   fallback-to-export behavior) and `src/test/unit/OpenCodeCliProvider.test.ts`
   (port allocation, `--port`/`--hostname` arg construction, concurrent
   instances getting distinct ports).

## Non-goals

- No change to headless (`opencode run`) execution — it already streams full
  JSON and has no unbounded-payload problem.
- Do not consume the SSE `/api/session/:id/event` endpoint. The plain
  paginated `history` endpoint gives the same durable events without
  reconnect/backoff complexity, and fits the existing 1s-poll architecture
  with a one-line semantic change (cursor instead of full replay).
- Do not remove or weaken the interim `maxBuffer`/`warn`-log fix already
  shipped in `OpenCodeLogParser.ts` until this replacement is implemented and
  the export path is demoted to fallback-only.

## Acceptance criteria

- [x] Interactive OpenCode sessions no longer re-fetch or re-parse the full
      transcript on every poll; each poll only transfers/parses events newer than
      the last seen sequence. Confirmed by `OpenCodeLogParser.fetchNewEvents()`
      and the cursor/`hasMore` coverage in
      `src/test/suite/harness/LogParsers.test.ts`.
- [ ] A session whose transcript would have exceeded the 100 MiB export buffer no
      longer loses events — behavior is verified with a synthetic large-output
      session (e.g. a tool call whose output alone exceeds 100 MiB). The cursor
      implementation removes the architectural buffer limit, but this still needs
      a real `opencode` CLI run with a large tool-output session.
- [x] Multiple concurrent interactive OpenCode sessions in the same workspace each
      get a distinct port with no collision. Confirmed by
      `src/test/unit/FreePortAllocator.test.ts` and the concurrent-provider test
      in `src/test/unit/OpenCodeCliProvider.test.ts`.
- [x] An OpenCode CLI version predating the `history` endpoint still works,
      transparently falling back to `opencode export` polling. Confirmed by the
      404 and no-server fallback tests in
      `src/test/suite/harness/LogParsers.test.ts`.
- [x] `isComplete`, `extractResponse`, `extractContentFromEvent`,
      `extractLiveContextWindow`, `extractSessionId`, `classifyUserEvent`, and
      `extractUserSteerText` all produce equivalent output to today's
      export-based path for the same underlying conversation content in synthetic
      history/export fixtures. Confirmed by the history mapping and extraction
      tests in `src/test/suite/harness/LogParsers.test.ts`. A real `opencode` CLI
      run is still needed to confirm the live
      `tool.called`/`.progress`/`.success`/`.failed` and reasoning event shapes;
      those were not exercised by the live step-3 probe.

## Post-ship incident: silent zero-event sessions (2026-09-01)

A real interactive OpenCode run (CLI 1.18.25, session `ses_fa0dbd48affe9MaIHz5TnhIlQV`)
produced a completed workflow with real edits (git commit `a70f3bc0`) but an
**empty captured output** (`structured.events: []` in the persisted
`cliOutputRecorded` payload) and **zero warn/error log lines** for OpenCode
polling across the whole ~6-minute session. `--port`/`--hostname` were
confirmed present in the actual spawned command
(`--port 55578 --hostname 127.0.0.1`), and `opencode export` on that same
session ID afterward returned 17 completed text segments and 46 completed
tool calls — proving the underlying data existed and the export fallback
would have shown it, had it ever been tried.

This is only possible if `GET /api/session/:id/history` was reachable and
responding successfully on every poll (no thrown error, so `historyFallback`
never tripped) while consistently returning an empty page. The existing
fallback logic only reacts to explicit failures (non-2xx, malformed shape,
stalled cursor, thrown fetch error) — a server that answers 200 with nothing,
forever, was treated as healthy.

Root cause in opencode's server internals (whether `session.next.*` durable
events are reliably published for TUI-submitted prompts specifically, as
opposed to the plan's own manual verification which drove sessions purely via
direct `POST /api/session/:id/prompt`) was not conclusively established —
this environment's PTY limitations and an unrelated `opencode serve` startup
error in the sandbox blocked a live re-test.

**Mitigation shipped** in `OpenCodeLogParser.ts`: track whether the history
endpoint has ever returned a single durable event for the current session; if
`OPENCODE_HISTORY_EMPTY_GRACE_MS` (15s) elapses since session start with zero
durable events despite successful polling, permanently switch to
`opencode export` for the rest of the session (mirroring the existing
error-triggered fallback) and log a WARN explaining why. Also added
`Log.trace` on every successful poll (history and export) reporting event
counts, so a future occurrence is diagnosable from logs alone instead of
requiring artifact archaeology. See
`falls back to export after history responds successfully but stays empty
past the grace period` in `src/test/suite/harness/LogParsers.test.ts`.

## Reverted (2026-09-02)

A live A/B test resolved the "root cause not conclusively established" open
question above: **`GET /api/session/:id/history` never publishes durable
events for TUI-submitted prompts at all, regardless of wait time.** Two
sessions were driven against the same running `opencode serve` instance:

- A TUI-launched session (`opencode --prompt "..." --port ... --hostname ...`
  — the exact invocation ctrlyoke uses) produced a correct model response,
  real token/cost accounting, and a full transcript via `opencode export` —
  but `history` returned `{"data":[],"hasMore":false}` for the entire
  session, even 20+ seconds after completion.
- The same server, given a session created and prompted via direct
  `POST /api/session/:id/prompt` (the method this plan's own verification
  steps used throughout, see "Update (2026-08-31)" above), populated
  `history` correctly within ~2 seconds.

Same server, same code, same model — the only variable was how the prompt
was submitted. opencode's TUI-native prompt path (`--prompt` at launch, or
keystrokes typed into a running TUI) simply never emits `session.next.*`
durable events; only prompts driven through its own HTTP API do. This is a
structural property of opencode's TUI, not a timing issue, a wrong-endpoint
call, or something a longer grace period / retry could fix — so the
post-ship mitigations above (grace period, per-step force-fallback) were
permanent workarounds for dead code, not stopgaps for a real race.

Combined with the plan's own "Headless mode is unaffected" finding: headless
(`opencode run`) never used this path anyway, so every interactive session
ctrlyoke actually drives was already falling through to `opencode export` on
every run — the history-endpoint path never fired in production.

**Action taken:** reverted commits `3f89ff70`..`2db3905d`
(`feat: add loopback free-port allocator` through
`fix: fall back to opencode export when history polling goes silently
empty`), which cleanly covered the entire feature — no unrelated commits
touched these files in that range. `OpenCodeLogParser.ts` is back to
`opencode export`-only polling (retaining the pre-plan interim fix: a 100 MiB
`maxBuffer` and `warn`-level logging on swallowed export failures, from the
original Background section above — still the right permanent mitigation for
the buffer-size problem, since that failure mode is real and export-only is
now the only path). `OpenCodeCliProvider.ts` no longer allocates a port or
passes `--port`/`--hostname`; `FreePortAllocator.ts` and
`OpenCodeEventMapper.ts`'s durable-event mapping were removed as dead code
with no other path exercising them.

If this is revisited later, the fix has to live on opencode's side (get the
TUI to actually emit `session.next.*` for its own prompt submissions, or
expose an equivalent event source that does) — no client-side polling
strategy against `history` can work around a server that never publishes the
events being polled for.
