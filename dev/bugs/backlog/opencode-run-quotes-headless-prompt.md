# OpenCode headless prompts arrive wrapped in literal quotes

- **Found:** 2026-10-31 by the release harness run (OpenCode 1.19.5, Windows)
- **Area:** `src/core/harness/opencode/OpenCodeCliProvider.ts` (`buildHeadlessArgs`)
- **Severity:** low

## Symptom

Every headless OpenCode prompt reaches the model wrapped in double quotes, and
any `"` inside it reaches the model as `\"`. `opencode export <session>` shows
the stored user message as `"using these available skills C:\...\x.skills.md, follow the instructions in C:\...\x.prompt.md "`.

Most prompts still work. The risk is file references whose path contains a
space: ctrlyoke quote-wraps those (`"C:\Users\Jane Doe\proj\...\x.prompt.md"`),
and OpenCode turns that into `\"C:\Users\Jane Doe\proj\...\x.prompt.md\"`. Since
OpenCode always gets absolute references, a space anywhere in the workspace path
(commonly the user's home folder name) is enough. OpenCode's models already
struggle to find prompt files, so this makes that harder.

## Steps to Reproduce

1. Run any headless workflow step on `opencode-cli`.
2. `opencode export <sessionId>` and read the first user text part.

## Root Cause

Not ctrlyoke's argv handling. OpenCode's `run` command deliberately quotes every
positional message argument containing a space before joining them
(`packages/opencode/src/cli/cmd/run.ts:288-290` in the OpenCode repo, from
upstream commit `be8116e2e`, "fix: preserve argument boundaries in run command
(#4979)"):

```ts
let message = [...args.message, ...(args["--"] || [])]
  .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
  .join(" ");
```

That quoted `message` is the text part sent to the model (`run.ts:869`). It
happens on every OS.

## Suggested Fix

Send the prompt on stdin with no message argument: `resolveRunInput`
(`run.ts:40-50`) returns piped text unchanged when the message is empty. That
needs a stdin-input option on the headless spawn path
(`CliTransportCoordinator.spawnProcess` → `processManager.spawn`), which has
none today. Re-run the OpenCode harness tests after the change. Also worth
reporting upstream, since the quoting was meant for `--command` arguments.
