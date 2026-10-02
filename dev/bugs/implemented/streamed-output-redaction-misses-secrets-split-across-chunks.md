# Streamed PTY output is redacted per chunk, so a secret split across chunks reaches dashboards unredacted

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli)
- **Area:** `src/core/WorkflowInstance.ts` (~3616, PTY `onData`), `src/core/harness/PtyProcessManager.ts` (`ptyPostMessage`), `src/types/PreviewRedactor.ts` (exact-substring redaction)
- **Resolution:** fixed in this commit

## Symptom

Secret values granted to a step are redacted from what ctrlyoke sends to the
webview and hosted-dashboard clients. Redaction is an exact substring match on
each message (`redactValue` → `PreviewRedactor`), and interactive/PTY output is
posted one raw node-pty chunk at a time (`TERMINAL_OUTPUT` via `ptyPostMessage`,
and the same chunk through `options.onOutput` into the timeline). If a secret
straddles a chunk boundary, neither chunk contains the whole value, so both halves
are delivered unredacted and the value can be reassembled in the terminal view
(and probably in persisted `events.jsonl`). ConPTY on Windows splits output at
arbitrary points and interleaves VT escape sequences, which makes this more likely.

Other chunked streams (script stdout via `StreamChunkCoalescer`, CLI output chunks)
probably have the same property; a fix should audit them.

Found by code reading, not reproduced end to end.

## Steps to Reproduce

1. Grant a secret `S = "abcdef123456"` to an interactive step and have it echo it
   in a way that makes the PTY deliver `"...abcdef"` and `"123456..."` as separate
   chunks (e.g. a script printing the halves with a short sleep in between).
2. Watch the terminal in the dashboard, or the hosted client's websocket traffic:
   the full secret is visible.

## Root Cause

Stateless per-message redaction applied to a stream whose chunk boundaries are
arbitrary.

## Original Suggested Fix

Add a streaming redactor per session/stream and apply it to every chunked output
path that reaches a client or persisted event. The binding design decision below
specifies the suffix matching and flush behavior used by the implementation.

## Decision (orchestrator, 2026-10-01)

Implement a per-stream `StreamingSecretRedactor` with these rules:

- **Hold only what could still be a secret.** After redacting `held + chunk`, hold
  back the longest suffix that is a proper prefix of any current exact secret
  (`RunSecretRedactor` values, including the JSON-escaped representation); emit
  everything before it. When no run has registered secrets, nothing is ever held,
  so the common case has zero added latency. Do not hold a fixed
  `maxSecretLength - 1` window — that delays every chunk.
- **No idle-timer flush.** A timer would reopen exactly the leak in the repro
  (writer pauses mid-secret). Held text is emitted when the next chunk arrives and
  disambiguates it, or on `flush()` at stream end (process exit, step
  abort/cancel, session dispose). The accepted cost: an interactive prompt whose
  trailing characters happen to match a secret's first characters appears only
  after the next output.
- **Redact upstream of the transport boundary.** `secretRedactionService.redactValue`
  at `ptyPostMessage`/webview/hosted sinks stays as-is (stateless defense in depth);
  the streaming redactor wraps each chunk producer before its chunk is fanned out to
  the terminal message, the timeline `onOutput`, and persisted events.
- **VT escapes interleaved mid-secret are out of scope.** Stripping them would change
  terminal rendering; leave as a documented limitation. Heuristic (pattern-based)
  redaction across chunk boundaries is likewise out of scope.

Implementation is split: the redactor plus the PTY paths first, then an audit of
the remaining chunked streams (script stdout/stderr through `StreamChunkCoalescer`,
headless CLI output chunks) and persisted `events.jsonl`.

## Progress

- Implemented `StreamingSecretRedactor` and wired streaming redaction into the
  interactive script PTY and harness interactive PTY paths, before terminal
  callbacks and reconnect-buffer recording. Stream tails flush on exit, kill,
  and process-manager disposal.
- Completed: audited script stdout/stderr, headless CLI stdout, JSONL event
  parsing, CLI terminal formatting, and `events.jsonl`; see Resolution below.

## Resolution

- `ScriptExecutionReporter` now redacts stdout incrementally before
  `StreamChunkCoalescer`, with one redactor for that stdout stream and a flush
  before the final dashboard/history record on success, error, timeout, and
  cancellation paths. Completed stdout and stderr are redacted separately as
  whole values before completed output and script runtime records are published
  or persisted. Stderr is not streamed today; it is only exposed after process
  completion, so it cannot split across published chunks.
- Plain headless CLI stdout chunks are redacted before the live streaming
  callback and flushed when the spawned process ends, including a rejected
  spawn. The standalone CLI's `CliTerminalFormatter` receives those safe chunks.
  Interactive harness output continues to use the PTY redactor added in the
  earlier commit.
- Headless JSONL output is buffered by complete line before the provider parser
  sees an event. Thus a transport chunk split inside a JSON record is reassembled
  before that event is redacted at the output boundary; `CliResponseCollector`
  also redacts its completed stdout/stderr values before failure details are
  exposed. No per-chunk redactor was added to the JSONL parser.
- `TimelineRecorder` redacts every event before writing `events.jsonl`. Script
  and PTY output chunks now arrive there after streaming redaction, so no secret
  can be divided across consecutive timeline output chunks from those streams.
  Other complete structured CLI events are still redacted as whole events.
- The exact matcher handles registered secret values and their JSON-escaped
  forms. VT escape sequences inserted inside a secret remain unsupported, and
  heuristic pattern redaction is not made stateful across chunks.
