# OpenCode 2 Incremental Session Polling Plan

**Status:** Backlog. Not started.
**Priority:** P3. Interactive OpenCode 2 steps work today. This removes a cost
that grows with session length; it does not fix a user-visible bug.

## Why this exists

`dev/rejected/OPENCODE_INTERACTIVE_EVENT_STREAM_PLAN.md` tried to stop
`OpenCodeLogParser` from re-fetching the whole session transcript once a
second. It was reverted because OpenCode 1's TUI never published the durable
events that plan polled for. OpenCode 2 starts a server for every launch, so
the question came up again: can that plan be revived?

**Recommendation: do not revive its design (durable event log, ctrlyoke-owned
port). Keep its goal and reach it through `session.message.list` on OpenCode 2's
background service.** The findings below explain why.

Today an interactive OpenCode 2 step polls `opencode session export <id>`
(`OPENCODE_EXPORT_COMMANDS.V2`) every `EXPORT_POLL_INTERVAL_MS` (1 s). It goes
through the shared background service, not the step's private `--standalone`
server; see the comment on `runOpenCodeExport` in
`src/core/harness/opencode/OpenCodeLogParser.ts`. Every poll transfers and
parses the complete transcript, capped by `OPENCODE_EXPORT_MAX_BUFFER`
(100 MiB). That is the same scaling problem the rejected plan described.

## Findings (OpenCode 2.2.5, source at `C:\dev\opencode` @ `187486ede3`, 2026-11-05)

### The durable event log is still the wrong tool

- The v1 `GET /api/session/:id/history` route is gone. Its replacement is
  `GET /api/experimental/session/:sessionID/log?after=<seq>&follow=<bool>`
  (operation `experimental.session.log`, `packages/protocol/src/groups/session.ts`).
- Replay only returns events if the server keeps durable payloads.
  `Bus.configured({ persist })` (`packages/core/src/bus.ts`, wired from
  `options.events?.persist` in `packages/server/src/routes.ts`) is off by
  default. Verified live: `opencode api experimental.session.log --param
sessionID=<a finished TUI session> --param after=0` returned only
  `{"type":"log.synced",...,"seq":34}` with no events. The session had 34
  durable sequence numbers, and none of their payloads were retained.
- `follow=true` delivers live events only from the server running the session.
  An interactive step runs on its own `--standalone` server, and its address
  is never surfaced. To use it, ctrlyoke would have to launch with
  `--server <url>` or allocate ports again, the machinery the rejected plan
  needed and later removed.
- The endpoint is marked experimental.

### `session.message.list` fits the existing poll loop

- `GET /api/session/:sessionID/message` (operation `session.message.list`,
  `packages/protocol/src/groups/message.ts`) is a stable route. It takes
  `limit`, `order`, `cursor` and `type`, and returns
  `{ data: Message[], cursor: { previous, next } }`. Per its description,
  "items keep the requested order across pages".
- Its messages have the same flat shape that OpenCode 2's `session export`
  produces (`OpenCodeV2ExportMessage` in `OpenCodeLogParser.ts`): `type`,
  `content[]`, `finish`, `tokens`, `time.completed`. The v2 export mapping
  should therefore apply unchanged. Verified live: `--param limit=2` returned
  an `idle` record and an `assistant` message with `finish`/`tokens`.
- It reads the projected message store, not the bus. It works for sessions
  submitted through the TUI or any other route, and through the background
  service for sessions a `--standalone` server wrote. That is the same reason
  `session export` already works there.

### How to call it

- **`opencode api <operationId> --param k=v`** is OpenCode 2's public client
  for its own server. It finds the background service, starts it if needed,
  and authenticates. Model discovery already uses it
  (`OPENCODE_MODELS_COMMANDS.V2 = "opencode api model.list"`, about 150 ms per
  call, the same as `opencode models`). It exists in every OpenCode 2 release:
  `feat(cli): add API request command` (`784eea3911`, 2026-06-23) predates
  2.0's stable release (September 2026).
- Calling the service over HTTP directly would save the process spawn on each
  poll. But the endpoint and its Basic-auth password come from a registration
  file in OpenCode's state directory (`packages/client/src/effect/service.ts`).
  That file is the contract of OpenCode's own client, not a documented one, so
  depending on it is the same kind of risk as reading
  `~/.cache/opencode/models.json`. Stay on `opencode api` unless the per-poll
  spawn proves to be the bottleneck. If it does, the next step up is
  `@opencode/client`'s `discover()`, not hand-reading the file.
- **Git Bash gotcha:** MSYS path conversion rewrites a leading-slash argument
  (`opencode api GET /api/model` becomes a Windows path and fails with
  "Expected an operation name or an HTTP method and path"). Use operation IDs,
  which have no leading slash, or run from PowerShell.

## Scope

1. In `OpenCodeLogParser`, for OpenCode 2 only (`detectOpenCodeV2()`), replace
   the per-poll `session export` with `session.message.list`. Fetch newest
   first (`order` descending) in small pages and follow `cursor` back only
   until reaching the newest message already marked final. That transfers the
   in-progress tail, not the whole transcript.
2. Keep the current rule that holds back streaming content: a message is
   emitted only once it has `time.completed` (see the "holds back streaming
   export content until it is final" test in `src/test/unit/OpenCodeV2.test.ts`).
   Its ID becomes the stop marker for the next poll.
3. Keep `session export` as the fallback: when `opencode api` exits non-zero
   or the response does not have the expected shape, fall back for the rest
   of the step and log a WARN, as the rejected plan's fallback did. OpenCode 1
   stays on `opencode export`.
4. Subagent child sessions: the parser follows child sessions through the
   plugin sidecar and exports (`setSubagentSidecar`). Apply the same paging to
   each followed child session.
5. Tests: paging until the stop marker, held-back streaming messages, fallback
   on a non-zero exit, and a fixture captured from a real
   `session.message.list` response alongside the existing v2 export fixtures in
   `src/test/fixtures/opencode/`.

## Open questions

- Check the cursor's stability while the newest message is still being
  written (`cursor.previous` vs `cursor.next` with `order` descending)
  against a live, still-running session before relying on it across polls.
  Re-fetching the first page every poll avoids the question entirely.
- Steered and queued user input shows up as `user`/`synthetic` messages and
  `idle` records. Confirm that `classifyUserEvent`/`extractUserSteerText`
  treat them the same way they do in the export.
- Measure first: capture `session export` time and size against step length
  on a long interactive step. If a typical step stays well under a few MiB,
  this plan can stay parked.

## Non-goals

- No change to headless (`opencode run --format json`), which streams to stdout.
- No ctrlyoke-allocated ports and no `--server` launch. Keep `--standalone`.
- No dependence on `events.persist` or other non-default server configuration.
