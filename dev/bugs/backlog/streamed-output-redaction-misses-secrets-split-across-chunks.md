# Streamed PTY output is redacted per chunk, so a secret split across chunks reaches dashboards unredacted

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli)
- **Area:** `src/core/WorkflowInstance.ts` (~3616, PTY `onData`), `src/core/harness/PtyProcessManager.ts` (`ptyPostMessage`), `src/types/PreviewRedactor.ts` (exact-substring redaction)
- **Severity:** medium (security; fix needs a behavior change — output buffering — so it is not queued automatically)

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

## Suggested Fix

Add a streaming redactor per session/stream. Keep a tail buffer of up to
`maxSecretLength - 1` characters, redact `tail + chunk`, emit only the prefix that
can no longer begin a secret, and flush the remainder on exit. Apply it to the PTY
path and any other chunked output that reaches a client or a persisted event.
Consider whether VT escape sequences inserted mid-secret need stripping before
matching. This delays output by a few characters, a user-visible behavior change,
so it needs a design decision before implementation.
