# Antigravity 1.5.7's auto mode runs commands no allow rule matches

- **Found:** 2026-11-12 by the 0.7.0 pre-release `npm run test:harness` run (agy 1.5.7)
- **Area:** `src/core/harness/antigravity/AntigravityToolPermissionMapper.ts`
- **Resolution:** fixed in this commit

## Symptom

In `custom` tool-permission mode with `allowedTools: ["shell(echo:*)"]`, agy
1.5.7 ran `echo agy-chain && node marker.js out.txt` headless, and the
`node` command executed. The harness case "an allowed command does not allow
an unlisted one chained to it" failed twice in a row. It passed on 1.5.4.

ctrlyoke's per-run `--settings` file was unchanged and correct: agy's log shows
the expected strict rule,
`Allow:[command(regex:echo(?:[ \t][^;&|`$()<>\r\n]*)?)]`, with
`toolPermission=request-review`.

## Root Cause

agy 1.5.7 starts every session in its new `auto` agent mode ("auto-approve
edits and safe commands, prompt on irreversible actions"). The Go log shows
`SetCycleMode called: auto` and the `jetski_mode_auto` tag in every 1.5.7 run
and in no earlier version's run (1.5.3–1.5.6 run in `jetski_mode_default`). In
`auto`, agy's own judgement approves a command that no allow rule matches, so
the allow list stops being a limit.

## Fix

The settings file sets `agentMode: ""`, which selects the old default mode,
whenever the installed agy is 1.5.7 or later. Probed on 1.5.7 headless with a
Flash model:

- `agentMode: ""`: the chained command is refused ("auto-denied"), and an
  allowed plain `echo` still runs. No `SetCycleMode auto` line is logged.
- `--mode default`: rejected (`valid: accept-edits, auto, plan`), and the
  command ran.
- `agentMode` accepts only `auto`, `accept-edits`, `plan` and `""`. agy
  refuses the whole `--settings` file over an unknown key (`defaultMode`) or
  value, so the key is version-gated: `AntigravityHarnessAdapter` passes the
  detected version as `PermissionContext.cliVersion`.
