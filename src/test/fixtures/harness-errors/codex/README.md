# Codex CLI error captures

Captured 2026-11-09 with Codex CLI 0.166.0 in interactive (TUI) mode. Each probe used an isolated `CODEX_HOME` in scratch, so the stored ChatGPT sign-in was never used. Its `config.toml` selects a custom `model_provider`: `wire_api = "responses"`, `env_key` set to a dummy key, `request_max_retries = 0` and `stream_max_retries = 0`, with `base_url` pointing at a local stub. The workspace is pre-trusted there, so no first-run screen appears. `SessionStart`, `UserPromptSubmit` and `Stop` stdin loggers were passed as inline `-c hooks.*` overrides with `--enable hooks`; their trust hashes came from ctrlyoke's own `buildCodexInlineHooks`.

- **Positive control:** a stub answering with a minimal Responses-API SSE stream ("hi"). `SessionStart`, `UserPromptSubmit` and `Stop` all fired.
- **API error:** the stub answered every request with an OpenAI-shaped 401. `SessionStart` and `UserPromptSubmit` fired, but **`Stop` did not fire**.
  - `interactive-pty-excerpt.txt`: the TUI printed `■ unexpected status 401 Unauthorized: ...` and returned to its prompt.
  - The process did **not** exit before the 45-second PTY cap.
- `interactive-rollout-task-error.jsonl` holds the real `task_started` and `task_complete` records from the session rollout. On failure, `task_complete` has `last_agent_message: null` and `error: { message, codex_error_info: { http_connection_failed: { http_status_code: 401 } } }`. That is a typed session-level failure signal in the log.
- The TUI also emitted an OSC `7501;state=error:app=codex` terminal sequence on the error turn (`state=done` on the control turn). That is terminal output, not a log record.

Redactions: turn and session IDs (`<UUID>`).
