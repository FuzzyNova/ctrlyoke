# OpenCode failed tool calls and error events are dropped or shown as successes

- **Found:** 2026-10-02 by bug-hunt final step (source review, compiled-module repro, and live opencode 1.18.33 run)
- **Area:** `src/core/harness/opencode/OpenCodeEventMapper.ts`, `src/core/harness/opencode/OpenCodeLogParser.ts`
- **Resolution:** fixed in this commit

## Symptom

1. **Failed tool calls.** OpenCode tool parts end with `state.status` either
   `"completed"` or `"error"`. A failed call carries its message in
   `state.error`, and `opencode run` emits `tool_use` for both statuses. ctrlyoke
   only recognizes `"completed"`:
   - Headless: a failed `write` maps to a normal `fileWrite` with no failure
     flag, so the dashboard shows a file write that never happened. A failed
     `bash` shows empty output and the error text is lost. Other tools become a
     `toolCall` with no result, which looks like it's still running.
   - Interactive (export polling): `isPartCompleted` never treats an `"error"`
     part as final, so a failed tool call is never emitted at all.

   Repro against `out/`: `mapOpenCodeToolPartToCliEvent(0, {tool:"write", state:{status:"error", input:{filePath:"a.txt",content:"x"}, error:"You must read the file a.txt before overwriting it"}})`
   → `{"type":"fileWrite","data":{"path":"a.txt","content":"x"}}`.

2. **Error events.** With `--format json`, OpenCode writes session and prompt
   errors (bad model, auth, rate limit, provider errors) only to stdout, as
   `{"type":"error","error":{"name":…,"data":{"message":…}}}`, then exits 1
   with empty stderr. The parser has no case for that event type, so the user
   sees only `Process exited with code 1`.
   Repro: `opencode run --format json -m bogusprov/bogus "hello world"`.

## Root Cause

- `OpenCodeEventMapper.ts` (about line 83) computes only
  `isCompleted = status === OPERATION_STATUS.COMPLETED` and never reads
  `state.error`.
- `OpenCodeLogParser.isPartCompleted` (about line 678) only accepts `"completed"`.
- `OpenCodeLogParser.extractResponse` / `extractStructuredEventsFromEvent`
  (switches around lines 395 and 511) have no `error` event case, so
  `CliResponseCollector.getHeadlessFailure` falls back to the bare exit code.

## Suggested Fix

- Add an error status constant (alongside `OPERATION_STATUS`, or an
  OpenCode-specific one, with no hardcoded string). Treat `"error"` as terminal
  in `isPartCompleted`.
- In the mapper, mark failed parts as failures using whatever success/error
  fields the corresponding `CliEvent` data types already support (check
  `src/types/CliOutputTypes.ts`), and surface `state.error` as the
  output/result text for bash, write, edit, generic, and MCP tool events.
- Map the `error` stream event to the response's error/failure text
  (`error.data.message ?? error.name`), so the headless failure message shows
  it instead of only the exit code.
- Add Mocha tests with fixtures for a failed write, a failed bash, an
  export-polled failed part, and an `error` stream event.
