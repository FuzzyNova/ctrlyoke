# Extension host crashes repeatedly during one long-running workflow

- **Found:** 2026-10-01 by claude-cli (user-reported)
- **Area:** unknown; suspected extension-host memory use by a run with a very large timeline
- **Severity:** high

## Symptom

The VS Code extension host died twice in the same `bug-backlog` run
(`run-2026-09-30T13-41-01-546Z`, 38 steps, ~11 h, 40 harness attempts):

1. 2026-09-30 ~22:09Z during step 34: system-wide resource trouble (other processes crashed too) and
   an extension-host heap of ~1.7 GB, followed by an orderly host shutdown at 22:14Z.
2. 2026-10-01 00:07:33Z during step 35 (continuation, Codex step resuming session
   `01a0f455-…`), ~5.5 min after it started. The ctrlyoke log ends cleanly on a line boundary with
   no error; VS Code reported the host unresponsive at 00:07:52 and it exited at 00:08:49 with code
   `4294930433` (`0xFFFF7001`), then auto-restarted. No minidump was written ("crash server did not
   respond"), so the OOM signature could not be confirmed.

From the user's side the run "stopped without an error message, or the UI stopped updating".

## Evidence

- The run's `events.jsonl` is 45.7 MB. The continuation promoted 39 history entries to live in the
  panel at start.
- In the minutes before the second crash the ctrlyoke log shows only `HeadlessLogTail` polls of
  ~1 KB Codex events every ~30 s; nothing large was being processed. Codex kept writing its session
  log until 00:08:05, after the host froze.
- The extension host is shared with other extensions (Claude Code, Copilot Chat, etc.), so
  ctrlyoke is the leading suspect, not a proven one.
- Logs: `.ctrlyoke/logs/ctrlyoke-1790774099025.log` (first crash), `ctrlyoke-1790812839474.log`
  (second), and `%APPDATA%/Code/logs/20260930T190034/main.log`.

## Steps to Reproduce

Not yet reproduced. The likely shape is continuing a run whose timeline is tens of MB.

## Suggested Investigation

- Reproduce under the dev host with `--inspect` on the extension host and take heap snapshots
  before and a few minutes after continuing a large run; diff retained sizes.
- Audit which paths read or hold the whole `events.jsonl` (history load for the run view,
  `promoteHistoryToLive` payloads, token reducers, history search indexing) for a continued run.
- Consider logging `process.memoryUsage()` periodically while a run executes, so the next crash
  leaves a heap trajectory in the session log.
