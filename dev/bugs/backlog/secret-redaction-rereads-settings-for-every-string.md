# Secret redaction re-reads the merged settings for every string it redacts

- **Found:** 2026-10-19 by Claude Code (performance investigation, extension-host CPU profile)
- **Area:** `src/utils/SecretRedactionService.ts`, `src/utils/ConfigurationUtils.ts`, `src/config/CtrlYokeConfigService.ts`, `src/config/FileConfigBackend.ts`
- **Severity:** high

## Symptom

The whole dashboard feels slower: switching workflows, opening a run, sending a prompt, and
hosted-tab startup all stall the extension host. In a 45 s CPU profile of dev-host startup
(shared state, 1,508 lineages), `isHeuristicSecretRedactionEnabled` accounted for ~2.4 s of
main-thread time, called from `redactValue` under `CtrlYokeWebviewProvider.postMessage`,
the hosted server's `broadcast`, `PostMessageDashboardSink.send`, and `Log.writeLog`.

Measured with the real user and workspace settings files (`node` against `out/`):

| Operation                                                                                     | Cost           |
| --------------------------------------------------------------------------------------------- | -------------- |
| `configService.get("permissions")`                                                            | 64 µs per call |
| `secretRedactionService.redactText("hello world")`                                            | 64 µs per call |
| `redactValue` over one real run timeline (1,985 events, 44,645 strings, 18 MB `events.jsonl`) | **2,935 ms**   |
| The same, with only the `permissions` setting memoized                                        | **28 ms**      |

So a large run's view snapshot blocks the event loop for seconds per client it is sent to, and
`TimelineRecorder` pays the same per-string price on every event it appends.

## Steps to Reproduce

1. Use a workspace with a large run (the `media-plan` run above has an 18 MB `events.jsonl`).
2. Open that run in the dashboard, or redact its events directly:
   `secretRedactionService.redactValue(events)` with `configService` backed by the real
   `FileConfigBackend`s.
3. Watch `[EventLoopStall]` lines in the session log, or time the call: seconds instead of tens of
   milliseconds.

## Root Cause

`SecretRedactionService.redactValueInternal` (`src/utils/SecretRedactionService.ts:92`)
calls `redactText` once per string leaf. Each call goes through `redactTextWithSecrets`
(line 77), which calls `ConfigurationUtils.isHeuristicSecretRedactionEnabled()`
(`src/utils/ConfigurationUtils.ts:1068`) → `configService.get(CONFIG_KEYS.PERMISSIONS)` →
`CtrlYokeConfigService.getAll()` (`src/config/CtrlYokeConfigService.ts:446`). That rebuilds
the merged settings from scratch on every call: it copies the defaults, then runs up to three
`deepMerge`s (user, workspace, CLI overlay). Each backend's `FileConfigBackend.getAll()`
(`src/config/FileConfigBackend.ts:85`) also does a synchronous `fs.statSync` of its
settings file to validate its cache. That stat was added in 730b164ed (2026-10-14,
"reload settings after external file changes"), the same week the slowdown was noticed. So
one redacted string costs two `statSync`s plus three deep merges of the whole settings tree.

Entry points that redact whole payloads: `CtrlYokeWebviewProvider.ts:1358` (every panel
message), `CtrlYokeHostedServer.ts:208` (every hosted send and broadcast, serialized per
message), `PtyProcessManager.ts:1072`, `TimelineRecorder.ts:168/301/366` (every persisted
event), and `Log.writeLog` (every log line).

## Suggested Fix

Read the heuristic flag once per `redactValue`/`redactText` call tree, not per leaf. Pass it
down the way `redactTextWithSecrets` already threads `exactSecrets`, or memoize it in
`SecretRedactionService` and invalidate it from `configService`'s change listener. Separately,
`CtrlYokeConfigService.getAll()` should cache its merged result and invalidate it on backend
change/set (the commit above already added a settings-file watcher in `extension.ts`, so the
per-read `statSync` can become a watcher-driven invalidation). Every `ConfigurationUtils`
getter on a hot path benefits from that change, not just redaction. Add a unit test that
`redactValue` on a payload with many strings reads settings a bounded number of times.
