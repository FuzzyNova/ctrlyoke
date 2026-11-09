# Claude Code capture attempt

Claude Code 2.1.319 was run from fresh scratch workspaces with a scratch-only `StopFailure` stdin logger and an invalid API endpoint/key. The TUI retried the connection error (attempt 7/10 at the 70-second cap); `StopFailure` did not fire within the bounded run, so no hook payload fixture is available. The `error`, `error_details`, and `last_assistant_message` fields remain unverified. This affects Phase 1 hook extraction.
