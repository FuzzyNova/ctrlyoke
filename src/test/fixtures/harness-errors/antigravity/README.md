# Antigravity CLI error captures

Captured 2026-11-09 with Antigravity CLI (`agy`) 1.5.3. Every file here is real output. The CLI is installed as `agy`; the earlier "not installed" result came from probing for an `antigravity` executable. To force a non-retryable API error, `agy` ran with `--settings '{"modelProvider":"gemini"}'`, a dummy `GEMINI_API_KEY`, and `GOOGLE_GEMINI_BASE_URL` pointing at a local stub that answers every request with a Gemini-shaped 401 (`UNAUTHENTICATED`). Each probe ran from a fresh scratch workspace outside the repo. The hooks were registered in that workspace's `.agents/hooks.json`, which was trusted through `--settings` (`trustedWorkspaces`). The global `~/.gemini/config/hooks.json` was not touched.

Redactions: conversation, error and session IDs (`<UUID>`), the home directory (`<HOME>`), the scratch workspace (`<SCRATCH>`), and the headless `init.tools` list (`<TOOLS_OMITTED>`).

## Headless (`--print --output-format stream-json`)

- `headless-stream-json-error.jsonl`: the complete stdout. The error step shows up only as a `step_update` with `step_type: "error_message"`, which carries no text. The text is in the final `result` event: `status: "ERROR"`, `error: "agent executor error: ..."`, `finished_reason: "error"`.
- `headless-stderr.txt`: the complete stderr. It has a plain `error: ...` line plus an `AGY_ERROR: {...}` JSON line with `status`, `error_code`, `code_kind`, `retryable` and `error_id`.
- The process exited with code **3**.
- `transcript_full.jsonl` for that conversation held only the `USER_INPUT` step. **No `SYSTEM`/`ERROR_MESSAGE` entry was written**, and none exists in any other transcript on this machine. The Phase 2 transcript-based extraction (`AntigravityLogParser.extractSessionError`) therefore never fires for this error class. The earlier `headless-system-error.jsonl` was synthesized, not captured, and has been removed; the parser unit test now builds that entry inline and labels it synthetic.
- A bogus `--model` is rejected by client-side validation before any request is made: exit 1, no `init` event, and a `result` with an empty `conversation_id`. That is not a provider error.

## Interactive (`--prompt-interactive`)

- `interactive-stop-hook-error.json`: the `Stop` hook **fires** after the API error. Its stdin carries `terminationReason: "ERROR"` and the provider text in `error`.
- `interactive-stop-hook-success.json`: a positive-control `Stop` from a normal successful turn in the same setup, using the real sign-in. It has `terminationReason: "NO_TOOL_CALL"` and `error: ""`.
- `interactive-pty-excerpt.txt`: the TUI shows `⚠ agent executor error: ...` with an Error ID, then returns to its prompt.
- The process did **not** exit. It stayed in the TUI until the 60-second PTY cap.
- `PreInvocation` fired before the error. `PostInvocation` did not fire on the error turn but did on the control turn.
- As in headless mode, the transcript held only the `USER_INPUT` step.
