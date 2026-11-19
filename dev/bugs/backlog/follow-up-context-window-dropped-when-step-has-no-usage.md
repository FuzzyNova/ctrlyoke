# Follow-up context window is dropped when the step itself reported no usage

- **Found:** 2026-11-18 while diagnosing a Qwen step with no context-window gauge (user report)
- **Area:** `src/ui/webview-react/store/workflowStore.ts`, `src/core/orchestration/RunOutputResolver.ts`
- **Severity:** low

## Symptom

A step that completes with no token usage and then receives its assistant
record as post-completion session activity shows no context-window gauge or
token count. This happens live and after a reload, even though the follow-up
carried a valid `contextWindow` (`used: 26527, size: 1000000` in the run that
exposed it).

## Steps to Reproduce

1. Get a step to complete with an empty `structured.metadata` (no `usage`), and
   then have its session log produce an assistant record with usage. The
   `CliLogMonitor` drain race that caused this for Qwen is fixed: it was an
   event-loop stall overrunning the drain deadline before a final read. A
   genuine background-task resume after a usage-less completion still reaches
   this path.
2. `SessionActivityWatcher` emits a `CONTEXT_WINDOW_SYNC` marker, and
   `SessionActivityRecorder` persists `followUpResponseAppended` with
   `payload.contextWindow`.
3. The step card shows no context window.

## Root Cause

- Live: `mergeResumedActivityIntoOutput` in `workflowStore.ts` applies the sync
  only when `existing.tokens` is already set (`isFollowUp &&
  latestContextWindowSync && existing.tokens`), so a step with no tokens drops
  it.
- Reload: `RunOutputResolver` yields `FOLLOW_UP_RESPONSE_APPENDED` without
  `payload.contextWindow`, and the attempt fold ignores that event kind. Nothing
  in `src/` reads the persisted `payload.contextWindow`.

## Suggested Fix

Create a minimal `tokens` object holding only the context-window fields when
`existing.tokens` is absent. Carry `payload.contextWindow` through the resolver
event and fold the latest one into the attempt output's usage
(`contextWindowUsedTokens`/`contextWindowSize`), so a reload matches the live
view.
