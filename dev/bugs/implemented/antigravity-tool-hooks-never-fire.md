# Antigravity `preToolUse` and `postToolUse` hooks never fire

- **Found:** 2026-10-22 by Claude (harness capability suite), with agy 1.4.5
- **Area:** `src/core/harness/antigravity/AntigravityNotificationMonitor.ts` (`buildHookConfig`)
- **Resolution:** fixed in this commit. `buildHookConfig()` writes tool events as one
  `{ matcher: "*", hooks: [...] }` group, per agy's hooks reference
  (https://antigravity.google/docs/hooks/), and `ctrlyoke-antigravity-hook.js` answers
  `PreToolUse` with `{"decision":"allow"}`. Both claims now cite the capability suite, whose
  Antigravity cases all pass on agy 1.4.5. 1.2.6 was not run (agy can't install an old version),
  but its changelog shows tool matchers honored since 1.1.9.

## Follow-up findings

- The flaky `PostToolUse` was a second bug, not print mode. A `PreToolUse` hook that prints JSON
  without a `decision`, including the `{}` ctrlyoke's script printed, blocks the tool call, so
  there was nothing for `PostToolUse` to follow. With `allow`, `PostToolUse` fired in 3 of 3
  print-mode probes. Empty stdout also lets the call proceed, so user hooks that print nothing
  are unaffected.
- `allow` defers to agy's own permission checks. Without `--dangerously-skip-permissions`, a run
  behaves the same with the hook as with no hooks at all.
- Since `hooks.json` is global, the script's other-workspace early exit gives the same `allow`;
  printing `{}` there would block tools in every other agy session on the machine.

## Symptom

A workflow `preToolUse` or `postToolUse` hook on an Antigravity step never runs, although the
compatibility matrix lists both as supported. `sessionStart` and `stop` hooks on the same step do
run. ctrlyoke's own tool-event notifications on Antigravity are affected the same way.

## Steps to Reproduce

1. `npm run test:harness -- --grep "antigravity-cli: hooks"`.
2. The model runs the shell command, but the recorder logs only `sessionStart` and `stop`.

Probing `agy -p … --dangerously-skip-permissions` directly against `~/.gemini/config/hooks.json`:

- A plain handler, `"PreToolUse": [{"type":"command","command":"…"}]` (what ctrlyoke writes),
  never runs.
- A matcher group, `"PreToolUse": [{"matcher":"*","hooks":[{"type":"command","command":"…"}]}]`,
  runs on every tool call with the tool-call payload on stdin.
- `PostToolUse` ran in only one of three probes, in either shape. In print mode agy may exit
  before the post-tool hook completes.

## Root Cause

`buildHookConfig()` pushes every handler, tool events included, as a plain `{type, command,
timeout}` object. That shape is right for `PreInvocation`, `PostInvocation` and `Stop`, but agy
1.4.5 reads `PreToolUse`/`PostToolUse` entries as matcher groups and ignores the plain form. The
original research (`dev/implemented/ANTIGRAVITY_CLI_HARNESS_PLAN.md`, "A.6") only confirmed the
shape for `Stop` and noted that tool events "may support a tool-name matcher".

## Suggested Fix

Write `PreToolUse`/`PostToolUse` handlers as `{ matcher: "*", hooks: [handler] }` groups. Check that
the minimum (1.2.6) accepts that shape. Find out whether `PostToolUse` fires reliably in print
mode; if not, mark it partial with a caveat. Until then the two declarations should not claim
`exact` support.
