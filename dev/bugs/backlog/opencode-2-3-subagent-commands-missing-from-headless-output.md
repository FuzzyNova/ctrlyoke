# OpenCode 2.3.0 headless output drops foreground subagent commands

- **Found:** 2026-11-17 by the headless session control plan review pass (full `npm run test:harness`)
- **Area:** `src/core/harness/opencode/OpenCodeLogParser.ts` (headless `STDOUT` source)
- **Severity:** medium

## Symptom

`opencode-cli: attributes parallel foreground subagent commands` in
`src/test/harness/subagents.harness.test.ts` fails with
`opencode-cli: no command ran subagent-marker-alpha`. The two subagent spawn cards are recorded
(the earlier `spawnEvents.length >= 2` assertion passes), but the run's `events.jsonl` has no
`toolCall`/`bashCommand` event for either child's `echo`. So in the step output, a headless
OpenCode subagent's commands are missing, not just mis-attributed.

## Steps to Reproduce

1. Install OpenCode 2.3.0.
2. `npm run compile-tests`, then
   `npx mocha --ui tdd --exit --timeout 900000 "out/test/harness/**/*.test.js" --grep "opencode-cli: attributes parallel foreground subagent"`.

## Evidence

- Passed on OpenCode 2.2.6 (`.ctrlyoke/logs/test-runs/harness-2026-11-16T01-50-25-189Z.json`).
  It has failed on every run on 2.3.0 since `harness-2026-11-16T22-19-34-461Z.json`, which is
  before the session-control OpenCode bridge (a5f188d01) landed. A focused rerun on 2026-11-17
  failed the same way, while the other five harnesses passed.
- Between those runs, the only ctrlyoke change in `src/core/harness/opencode/` was a
  capability declaration (e4394dc77). The cause is therefore most likely an output change in
  OpenCode 2.3.0: child-session tool parts are no longer emitted on `opencode run --format json`
  stdout, or are emitted in a shape `OpenCodeLogParser` does not recognize.

## Next step

Capture `opencode run --standalone --format json` stdout for the case's prompt on 2.3.0 and
compare it with 2.2.6. If child-session events left stdout, follow the child sessions another
way (for example the plugin's session events, which the 6c control bridge already forwards).
