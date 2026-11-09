# Qwen Code interactive error capture

Captured with Qwen Code 0.26.7 using its bundled Node runtime, `-i`, and an invalid `DASHSCOPE_API_KEY` in a fresh scratch workspace. The PTY excerpt shows the 401 error and the TUI returning to its prompt. The process remained interactive until the 45-second PTY timeout. The saved chat JSONL records the same failure as a typed `qwen-code.api_error` system telemetry event (`AuthenticationError`, status 401).

A workspace `Stop` hook using the ctrlyoke hook configuration shape was registered for the probe; no hook input file was written before timeout. The scratch hook was not positively tested on a successful turn, so this does not prove the event did not fire. IDs, request ID, and workspace path are omitted from the fixtures.
