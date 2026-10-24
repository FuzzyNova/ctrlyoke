# Statusline wrapper kills the user's own statusline command after 200 ms, blanking PowerShell/npx statuslines on Windows

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (harness-cli)
- **Area:** `src/scripts/ctrlyoke-statusline-wrapper.js`
- **Severity:** medium

## Symptom

A user who already had a statusline command for Claude, Copilot, Qwen or Antigravity has it saved as
`statusLine.byHarness.<harness>.customCommand` when ctrlyoke installs its wrapper. The wrapper then
runs that command underneath. If the command takes longer than 200 ms to print its output, the wrapper
kills it and prints whatever stdout has arrived so far, which is usually nothing. With
`useCtrlyokeStyle: false`, the user's status line goes blank on every refresh. Nothing is logged and
the user is not told.

On Windows, the usual kinds of statusline command are all slower than 200 ms:

- a PowerShell script (`powershell -NoProfile -File statusline.ps1`)
- `npx ccstatusline` and other npx-launched tools
- a Node script that also shells out to git

That breaks the promise in `docs/harnesses/files-ctrlyoke-writes.md:39-41`: "ctrlyoke saves it in its
own settings ... and runs it underneath, so your status line keeps working."

## Steps to Reproduce

1. On Windows, set Claude's `statusLine` to `{"type":"command","command":"powershell -NoProfile -Command \"Write-Output hello\""}`.
2. Run a Claude step through ctrlyoke so the wrapper is installed and the command is saved as `customCommand`.
3. Leave `useCtrlyokeStyle` off for Claude.
4. The status line is blank. The same command run through `spawn(cmd, {shell:true})` takes 263-277 ms
   on an idle machine (measured during verification). A bare `node -e` takes about 71 ms, and git
   takes about 46 ms.

## Root Cause

- `src/scripts/ctrlyoke-statusline-wrapper.js:29`: `DEFAULT_FORWARD_TIMEOUT_MS = 200`. The comment at
  :27-28 bases this on the Antigravity poll cadence. The comment at :34-39 admits that a cold `node -e`
  can take longer than 200 ms on a loaded Windows machine, which is why tests override it through
  `CTRLYOKE_STATUSLINE_FORWARD_TIMEOUT_MS` (:41-49). That env var is not a user setting.
- `forwardToCommand` (:325-373) spawns with `shell: true`. When the timer fires (:352-359) it calls
  `child.kill()` and resolves with the partial or empty `output`. The caller cannot tell a timeout
  from a command that printed nothing. With `shell: true` on Windows, `child.kill()` ends only the
  `cmd.exe` wrapper, so the PowerShell/node grandchild keeps running after every refresh.
- `src/scripts/ctrlyoke-claude-statusline.js:37-53` writes `forwardedOutput` exactly as received
  (blank) when the ctrlyoke style is off. It also awaits the forward even when the style is on and
  the output is thrown away.

## Suggested Fix

Do not use a fixed timeout that is shorter than normal command startup. Options, which can be
combined:

- Raise the forward budget to fit realistic commands (for example 1-2 s), since each host CLI already
  applies its own debounce/timeout to the statusline command. Or make the budget a
  `statusLine.byHarness.<harness>` setting.
- Cache the last good forwarded output per harness and return it when a refresh times out, instead of
  returning blank.
- Skip the forward entirely when `useCtrlyokeStyle` is on, because its output is never used.
- On timeout, kill the whole process tree on Windows (`taskkill /T /F /PID`) so grandchildren do not
  pile up.

This is a fix to a fixed limit. Paging does not apply here.
