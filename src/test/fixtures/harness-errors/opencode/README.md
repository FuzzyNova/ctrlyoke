# OpenCode error captures

Captured 2026-11-09 with OpenCode 1.19.5 in interactive mode (`opencode --prompt ... -m stub/stub-model`). Each probe ran from a fresh scratch project whose `opencode.json` defines an `@ai-sdk/openai-compatible` provider pointing at a local stub. The stub answers every request with an OpenAI-shaped `401 invalid_api_key` (`isRetryable: false`), so OpenCode reports the error at once instead of retrying a connection error.

- `v1-session-error-event-order.jsonl` is real. A scratch-only plugin logged every bus event. The error turn emitted `session.error`, then `session.status` `idle` and `session.idle` in the **same millisecond**, then a second `idle`/`session.idle` pair 2 ms later. `dtMs` is relative to `session.error`. The `properties.error` shape is `{ name: "APIError", data: { message, statusCode, isRetryable, responseHeaders, responseBody, metadata: { url } } }`. There is no top-level `error.message`, so `getOpenCodeErrorMessage` must read `error.data.message`.
- `v1-session-error-artifact.json` is real. ctrlyoke's own v1 plugin (`src/scripts/ctrlyoke-opencode-plugin.ts`) was copied into the scratch project as `.opencode/plugin/ctrlyoke-completion-hook.ts` and ran with a scratch `CTRLYOKE_NOTIFY_DIR`. It wrote `<session>-error.json` 2 ms **before** `<session>-stop.json` (birth times 1794210887.352 and .354). The monitor checks the error file first (`INotificationMonitor.ts`), but both files can exist by the time it polls.
- The process did not exit; the TUI stayed open until the PTY cap.
- **OpenCode 2.x is still unavailable.** `npm view opencode-ai versions` lists no 2.x release (latest is 1.19.5), so the v2 plugin path and its immediate-idle ordering are still unexercised.

Redactions: session and message IDs (`<SESSION_ID>`, `<MESSAGE_ID>`) and the response `date` header.
