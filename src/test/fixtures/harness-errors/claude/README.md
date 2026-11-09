# Claude Code error captures

Captured 2026-11-09 with Claude Code 2.1.319 in interactive (TUI) mode. Each probe ran from a fresh scratch workspace with an isolated `CLAUDE_CONFIG_DIR`, so the user's own config was never read or written. That config dir was pre-seeded to skip onboarding and approve the dummy key. Hooks were registered through `--settings` pointing at a scratch file, with `SessionStart`, `Stop` and `StopFailure` stdin loggers. `ANTHROPIC_BASE_URL` pointed at a local stub.

- `stopfailure-hook-input.json` is real. The stub answered every request with an Anthropic-shaped `400 invalid_request_error`, which Claude does not retry. `StopFailure` fired within a second, and `Stop` did not fire. In the payload:
  - `error` is a **category string** (`"unknown"` here), not the error text.
  - The provider text is in `last_assistant_message` (`"API Error: 400 ..."`).
  - There is **no `error_details` field**.
- The TUI showed the API error and returned to its prompt; the process did not exit before the 45-second cap.
- A `401 authentication_error` from the same stub was retried as `attempt N/10`, with backoff reaching about 40 s, and `StopFailure` did not fire within 45 s. That matches the earlier connection-refused attempt, so only non-retryable errors give a prompt `StopFailure`.

Redactions: session and prompt IDs (`<UUID>`) and the scratch paths (`<SCRATCH>`, `<SCRATCH_SLUG>`).
