# Qwen Code interactive error captures

All runs used Qwen Code 0.26.7 (`-i`) with its bundled Node runtime.

## Original capture (earlier attempt)

`interactive-session-log.jsonl` and `interactive-pty-excerpt.txt` came from a run with an invalid `DASHSCOPE_API_KEY` against the real endpoint. The PTY showed the 401 and the TUI returned to its prompt. The saved chat JSONL recorded a typed `qwen-code.api_error` event.

## Stub captures (2026-11-09)

Each run had a fresh scratch workspace and an isolated `HOME`. A scratch `~/.qwen/settings.json` selected `openai` auth and turned folder trust off. `OPENAI_BASE_URL` pointed at a local OpenAI-compatible stub. `SessionStart`, `UserPromptSubmit` and `Stop` stdin loggers were registered through a scratch file passed as `QWEN_CODE_SYSTEM_SETTINGS_PATH`, as ctrlyoke does. The user's real Qwen settings were not read or changed.

- **Positive control (successful turn):** all three hooks fired, including `Stop`. This proves the hook registration works.
- **401 (`interactive-401-lifecycle-session-log.jsonl`):**
  - `SessionStart` and `UserPromptSubmit` fired. **`Stop` did not fire.**
  - The TUI showed `✕ [API Error: 401 ...] (Press Ctrl+Y to retry)` and stayed open until the PTY cap.
  - The log has `request_lifecycle` `phase: "started"`, then `qwen-code.api_error`, then `request_lifecycle` `phase: "ended"` with `outcome: "error"`.
- **One 429, then success (`interactive-sdk-retried-429-session-log.jsonl`):**
  - The stub received two chat requests for the turn, but the log has a single lifecycle ending `outcome: "success"` and **no `qwen-code.api_error`**. The retry happened below Qwen's logging layer, inside the OpenAI SDK client.
  - `Stop` fired.
- **Four 429s, then success (`interactive-outer-retried-429-session-log.jsonl`):**
  - The SDK absorbed the first three retries. The fourth failure surfaced, so Qwen logged `qwen-code.api_error` and a lifecycle ending `outcome: "error"`.
  - Its outer retry then opened a **new lifecycle** with a new `executionId` and the same `promptId`. That lifecycle ended `outcome: "success"` and was followed by `qwen-code.api_response`.
  - `Stop` fired, and the TUI showed the stub's reply.
  - So **an `api_error` record does not mean the turn failed**: a later lifecycle for the same `promptId` can recover it.

Redactions: session, execution and prompt UUIDs (`<UUID>`). Only `ui_telemetry` records are kept, reduced to `type`, `subtype`, `version`, `timestamp` and `systemPayload`.
